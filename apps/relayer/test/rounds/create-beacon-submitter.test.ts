import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
  WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';

import type {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  SignerRecoveryCycle,
  SignerRecoveryCycleResult,
} from '../../src/state/signer-recovery-cycle.js';

const mocks = vi.hoisted(() => ({
  recoverSignerAtHeads: vi.fn(),
  submitBeaconTransaction: vi.fn(),
}));

vi.mock(
  '../../src/state/recover-signer-at-heads.js',
  () => ({
    recoverSignerAtHeads: mocks.recoverSignerAtHeads,
  }),
);

vi.mock(
  '../../src/rounds/submit-beacon-transaction.js',
  () => ({
    submitBeaconTransaction: mocks.submitBeaconTransaction,
  }),
);

import {
  createBeaconSubmitter,
  type BeaconSubmissionRequest,
} from '../../src/rounds/create-beacon-submitter.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const REGISTRY =
  '0x2222222222222222222222222222222222222222' as const;

const HASH = `0x${'aa'.repeat(32)}` as const;
const SIGNATURE = `0x${'11'.repeat(48)}` as const;

function setup() {
  const events: string[] = [];
  const controller = new AbortController();

  const recoveryResult: SignerRecoveryCycleResult = {
    inspection: {
      status: 'no-attempt',
      observation: {
        anchor: {
          blockNumber: 100n,
          blockHash: HASH,
        },
        nonce: 4n,
      },
    },
    inclusions: null,
    broadcast: null,
    retryDelayMs: null,
  };

  const submissionResult = {
    status: 'acknowledged',
    attemptId: '11111111-1111-4111-8111-111111111111',
    transactionHash: HASH,
    nonce: 4n,
  } as const;

  mocks.recoverSignerAtHeads.mockImplementation(async () => {
    events.push('recover');
    return recoveryResult;
  });

  mocks.submitBeaconTransaction.mockImplementation(async () => {
    events.push('submit');
    return submissionResult;
  });

  const readStatus = vi.fn<
    () => Pick<SignerCoordinator['status'], 'open' | 'primaryReason'>
  >().mockReturnValue({
    open: true,
    primaryReason: null,
  });

  const coordinator = {
    get status() {
      return readStatus();
    },
  } as unknown as SignerCoordinator;
  const recovery = {} as SignerRecoveryCycle;

  const options = {
    publicClient: {} as PublicClient,
    walletClient: {} as WalletClient,
    account: ACCOUNT,
    coordinator,
    recovery,
    readChainHeads: vi.fn().mockResolvedValue({
      durableBlock: 100n,
      latestBlock: 110n,
    }),
    maxBlockRange: 2n,
    signal: controller.signal,
  };

  const request = {
    address: REGISTRY,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'submitBeacon',
    args: [20_791_007n, SIGNATURE],
    gas: 150_000n,
  } as const satisfies BeaconSubmissionRequest;

  return {
    options,
    request,
    controller,
    events,
    readStatus,
    recoveryResult,
    submissionResult,
    submitter: createBeaconSubmitter(options),
  };
}

describe('beacon submitter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('exposes recovery using the shared runner without submitting a new beacon', async () => {
    const t = setup();

    const result = await t.submitter.recover(7);

    expect(result).toBe(t.recoveryResult);

    expect(mocks.recoverSignerAtHeads)
      .toHaveBeenCalledExactlyOnceWith({
        publicClient: t.options.publicClient,
        recovery: t.options.recovery,
        readChainHeads: t.options.readChainHeads,
        maxBlockRange: 2n,
        signal: t.controller.signal,
      }, 7);

    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
    expect(Object.isFrozen(t.submitter)).toBe(true);
  });

  it('awaits recovery before submitting and forwards the cycle', async () => {
    const t = setup();

    let finishRecovery!: () => void;

    mocks.recoverSignerAtHeads.mockImplementationOnce(
      () => new Promise<SignerRecoveryCycleResult>((resolve) => {
        t.events.push('recover');

        finishRecovery = () => {
          resolve(t.recoveryResult);
        };
      }),
    );

    const pending = t.submitter.submit(t.request, 8);

    try {
      expect(mocks.recoverSignerAtHeads).toHaveBeenCalledOnce();
      expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
      expect(t.readStatus).not.toHaveBeenCalled();
    } finally {
      finishRecovery();
    }

    expect(await pending).toBe(t.submissionResult);
    expect(t.readStatus).toHaveBeenCalledOnce();
    expect(t.events).toEqual(['recover', 'submit']);

    expect(mocks.recoverSignerAtHeads).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: t.options.recovery,
      }),
      8,
    );

    expect(mocks.submitBeaconTransaction)
      .toHaveBeenCalledExactlyOnceWith({
        publicClient: t.options.publicClient,
        walletClient: t.options.walletClient,
        account: ACCOUNT,
        coordinator: t.options.coordinator,
        request: t.request,
        signal: t.controller.signal,
      }, 8);

    expect(mocks.submitBeaconTransaction.mock.calls[0]![0].request)
      .toBe(t.request);
  });

  it('does not submit when recovery fails', async () => {
    const t = setup();
    const error = new Error('Recovery failed');

    mocks.recoverSignerAtHeads.mockRejectedValueOnce(error);

    await expect(
      t.submitter.submit(t.request),
    ).rejects.toBe(error);

    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
    expect(t.readStatus).not.toHaveBeenCalled();
  });

  it('does not submit when cancellation arrives during recovery', async () => {
    const t = setup();
    const reason = new Error('Stop');

    mocks.recoverSignerAtHeads.mockImplementationOnce(async () => {
      t.controller.abort(reason);
      return t.recoveryResult;
    });

    await expect(
      t.submitter.submit(t.request),
    ).rejects.toBe(reason);

    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
    expect(t.readStatus).not.toHaveBeenCalled();
  });

  it('propagates submission failure without retrying', async () => {
    const t = setup();
    const error = new Error('Transaction broadcast outcome is uncertain');

    mocks.submitBeaconTransaction.mockRejectedValueOnce(error);

    await expect(
      t.submitter.submit(t.request),
    ).rejects.toBe(error);

    expect(mocks.recoverSignerAtHeads).toHaveBeenCalledOnce();
    expect(mocks.submitBeaconTransaction).toHaveBeenCalledOnce();
  });

  it('defers when fresh recovery leaves the signer blocked', async () => {
    const t = setup();

    mocks.recoverSignerAtHeads.mockImplementationOnce(async () => {
      t.readStatus.mockReturnValue({
        open: false,
        primaryReason: 'unresolved-attempt',
      });

      return t.recoveryResult;
    });

    await expect(t.submitter.submit(t.request, 9)).resolves.toEqual({
      status: 'signer-unavailable',
      blocker: 'unresolved-attempt',
    });

    expect(mocks.recoverSignerAtHeads).toHaveBeenCalledOnce();
    expect(t.readStatus).toHaveBeenCalledOnce();
    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
  });

  it('submits when fresh recovery releases a previously blocked gate', async () => {
    const t = setup();

    t.readStatus.mockReturnValue({
      open: false,
      primaryReason: 'unresolved-attempt',
    });

    mocks.recoverSignerAtHeads.mockImplementationOnce(async () => {
      t.readStatus.mockReturnValue({
        open: true,
        primaryReason: null,
      });

      return t.recoveryResult;
    });

    await expect(t.submitter.submit(t.request))
      .resolves.toBe(t.submissionResult);

    expect(t.readStatus).toHaveBeenCalledOnce();
    expect(mocks.submitBeaconTransaction).toHaveBeenCalledOnce();
  });

  it('throws when the gate is closed without a classified blocker', async () => {
    const t = setup();

    t.readStatus.mockReturnValue({
      open: false,
      primaryReason: null,
    });

    await expect(t.submitter.submit(t.request)).rejects.toThrow(
      'Signer gate is closed without a reported blocker.',
    );

    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
  });

  it.each(['recover', 'submit'] as const)(
    'reports completed recovery through %s',
    async (operation) => {
      const t = setup();
      const onRecoveryCompleted = vi.fn();

      const submitter = createBeaconSubmitter({
        ...t.options,
        onRecoveryCompleted,
      });

      if (operation === 'recover') {
        expect(await submitter.recover(7)).toBe(t.recoveryResult);
      } else {
        expect(await submitter.submit(t.request, 7))
          .toBe(t.submissionResult);
      }

      expect(onRecoveryCompleted).toHaveBeenCalledExactlyOnceWith({
        retryDelayMs: null,
      });

      const observed = onRecoveryCompleted.mock.calls[0]![0];

      expect(Object.isFrozen(observed)).toBe(true);
      expect(Object.keys(observed)).toEqual(['retryDelayMs']);

      if (operation === 'submit') {
        expect(
          onRecoveryCompleted.mock.invocationCallOrder[0]!,
        ).toBeLessThan(
          mocks.submitBeaconTransaction.mock.invocationCallOrder[0]!,
        );
      }
    },
  );

  it('reports the delay only after recovery finishes', async () => {
    const t = setup();
    const onRecoveryCompleted = vi.fn();

    let finish!: (result: SignerRecoveryCycleResult) => void;

    mocks.recoverSignerAtHeads.mockReturnValueOnce(
      new Promise<SignerRecoveryCycleResult>((resolve) => {
        finish = resolve;
      }),
    );

    const submitter = createBeaconSubmitter({
      ...t.options,
      onRecoveryCompleted,
    });

    const pending = submitter.recover();

    try {
      expect(onRecoveryCompleted).not.toHaveBeenCalled();
    } finally {
      finish({
        ...t.recoveryResult,
        retryDelayMs: 5_000,
      });
      await pending;
    }

    expect(onRecoveryCompleted).toHaveBeenCalledExactlyOnceWith({
      retryDelayMs: 5_000,
    });
  });

  it('does not report completed recovery when recovery fails', async () => {
    const t = setup();
    const failure = new Error('Recovery failed');
    const onRecoveryCompleted = vi.fn();

    mocks.recoverSignerAtHeads.mockRejectedValueOnce(failure);

    const submitter = createBeaconSubmitter({
      ...t.options,
      onRecoveryCompleted,
    });

    await expect(submitter.submit(t.request)).rejects.toBe(failure);

    expect(onRecoveryCompleted).not.toHaveBeenCalled();
    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
  });

  it.each(['recover', 'submit'] as const)(
    'preserves %s when the recovery observer throws',
    async (operation) => {
      const t = setup();

      const submitter = createBeaconSubmitter({
        ...t.options,
        onRecoveryCompleted() {
          throw new Error('Diagnostic observer failed');
        },
      });

      if (operation === 'recover') {
        await expect(submitter.recover())
          .resolves.toBe(t.recoveryResult);
      } else {
        await expect(submitter.submit(t.request))
          .resolves.toBe(t.submissionResult);

        expect(mocks.submitBeaconTransaction).toHaveBeenCalledOnce();
      }

      expect(mocks.recoverSignerAtHeads).toHaveBeenCalledOnce();
    },
  );
});