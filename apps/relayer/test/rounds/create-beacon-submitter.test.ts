import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';

import type {
  TransactionAttemptSummary,
  TransactionManagerStatus,
  TransactionReconciliationReport,
  SubmitTransactionWorkResult,
} from '../../src/state/transaction-manager-types.js';

const mocks = vi.hoisted(() => ({
  submitBeaconTransaction: vi.fn(),
}));

vi.mock(
  '../../src/rounds/submit-beacon-transaction.js',
  () => ({
    submitBeaconTransaction: mocks.submitBeaconTransaction,
  }),
);

import {
  createBeaconSubmitter,
  type BeaconSubmissionRequest,
  type CreateBeaconSubmitterOptions,
} from '../../src/rounds/create-beacon-submitter.js';

const REGISTRY =
  '0x2222222222222222222222222222222222222222' as const;

const HASH = `0x${'aa'.repeat(32)}` as const;
const SIGNATURE = `0x${'11'.repeat(48)}` as const;

function retainedAttempt(
  phase: TransactionAttemptSummary['phase'],
): TransactionAttemptSummary {
  const transactionHashes: TransactionAttemptSummary['transactionHashes'] = [
    HASH,
  ];

  Object.freeze(transactionHashes);

  return Object.freeze({
    attemptId: '11111111-1111-4111-8111-111111111111',
    workId: 'test-work:retained',
    nonce: 4n,
    phase,
    transactionHashes,
  });
}

function setup() {
  const controller = new AbortController();

  const status: TransactionManagerStatus = {
    chainId: 4663,
    journalInitialized: true,
    busy: false,
    open: true,
    primaryReason: null,
    blockers: [],
    recoveryComplete: true,
    inclusionChecksComplete: true,
    persistenceState: 'idle',
    blockedSince: null,
    attempts: [],
  };

  const readStatus = vi.fn<() => TransactionManagerStatus>()
    .mockReturnValue(status);

  const recoveryResult: TransactionReconciliationReport = {
    state: status,
    recoveryStatus: 'no-attempt',
    inclusionStatus: 'inspected',
    broadcast: null,
    retryDelayMs: null,
  };

  const submissionResult = {
    status: 'submitted',
    broadcast: {
      status: 'acknowledged',
      workId:
        'quicknet-round:v1:4663:' +
        '0x2222222222222222222222222222222222222222:20791007',
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: HASH,
      nonce: 4n,
    },
  } as const satisfies SubmitTransactionWorkResult;

  const reconcile =
    vi.fn<CreateBeaconSubmitterOptions['manager']['reconcile']>()
      .mockResolvedValue(recoveryResult);

  const submit =
    vi.fn<CreateBeaconSubmitterOptions['manager']['submit']>();

  const manager = {
    get status() {
      return readStatus();
    },
    reconcile,
    submit,
  } satisfies CreateBeaconSubmitterOptions['manager'];

  const getBlock = vi.fn<PublicClient['getBlock']>()
    .mockImplementation(async ({ blockNumber } = {}) => ({
      number: blockNumber,
      hash: HASH,
    }) as never);

  const readChainHeads =
    vi.fn<CreateBeaconSubmitterOptions['readChainHeads']>()
      .mockResolvedValue({
        durableBlock: 100n,
        latestBlock: 110n,
      });

  const options = {
    publicClient: { getBlock } as unknown as PublicClient,
    manager,
    readChainHeads,
    signal: controller.signal,
  } satisfies CreateBeaconSubmitterOptions;

  const request = {
    address: REGISTRY,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'submitBeacon',
    args: [20_791_007n, SIGNATURE],
    gas: 150_000n,
  } as const satisfies BeaconSubmissionRequest;

  mocks.submitBeaconTransaction.mockResolvedValue(submissionResult);

  return {
    options,
    request,
    controller,
    status,
    readStatus,
    getBlock,
    readChainHeads,
    reconcile,
    submit,
    recoveryResult,
    submissionResult,
    submitter: createBeaconSubmitter(options),
  };
}

describe('beacon submitter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('captures durable and latest anchors before reconciling', async () => {
    const t = setup();

    await expect(t.submitter.recover(7)).resolves.toBe(t.recoveryResult);

    expect(t.readChainHeads).toHaveBeenCalledOnce();
    expect(t.getBlock).toHaveBeenCalledTimes(2);

    expect(t.getBlock.mock.calls.map(([options]) => options?.blockNumber))
      .toEqual([100n, 110n]);

    expect(t.reconcile).toHaveBeenCalledExactlyOnceWith({
      durable: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
      signal: t.controller.signal,
      cycle: 7,
    });

    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
    expect(t.submit).not.toHaveBeenCalled();
    expect(Object.isFrozen(t.submitter)).toBe(true);
  });

  it('reads a shared durable and latest block only once', async () => {
    const t = setup();

    t.readChainHeads.mockResolvedValueOnce({
      durableBlock: 100n,
      latestBlock: 100n,
    });

    await t.submitter.recover();

    expect(t.getBlock).toHaveBeenCalledOnce();

    expect(t.reconcile).toHaveBeenCalledExactlyOnceWith({
      durable: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      head: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      signal: t.controller.signal,
      cycle: undefined,
    });
  });

  it('rejects reversed heads before reading blocks or reconciling', async () => {
    const t = setup();

    t.readChainHeads.mockResolvedValueOnce({
      durableBlock: 110n,
      latestBlock: 100n,
    });

    await expect(t.submitter.recover()).rejects.toThrow();

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.reconcile).not.toHaveBeenCalled();
  });

  it('propagates head-selection failure without reconciling', async () => {
    const t = setup();
    const failure = new Error('Head selection failed');

    t.readChainHeads.mockRejectedValueOnce(failure);

    await expect(t.submitter.recover()).rejects.toBe(failure);

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.reconcile).not.toHaveBeenCalled();
  });

  it('propagates an anchor-read failure without reconciling', async () => {
    const t = setup();
    const failure = new Error('Anchor read failed');

    t.getBlock.mockRejectedValueOnce(failure);

    await expect(t.submitter.recover()).rejects.toBe(failure);

    expect(t.reconcile).not.toHaveBeenCalled();
  });

  it('propagates reconciliation failure without retrying', async () => {
    const t = setup();
    const failure = new Error('Recovery failed');

    t.reconcile.mockRejectedValueOnce(failure);

    await expect(t.submitter.recover()).rejects.toBe(failure);

    expect(t.reconcile).toHaveBeenCalledOnce();
    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
  });

  it('does no recovery work when already cancelled', async () => {
    const t = setup();
    const reason = new Error('Stop');

    t.controller.abort(reason);

    await expect(t.submitter.recover()).rejects.toBe(reason);

    expect(t.readChainHeads).not.toHaveBeenCalled();
    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.reconcile).not.toHaveBeenCalled();
  });

  it('stops when cancellation arrives during head selection', async () => {
    const t = setup();
    const reason = new Error('Stop');

    t.readChainHeads.mockImplementationOnce(async () => {
      t.controller.abort(reason);

      return {
        durableBlock: 100n,
        latestBlock: 110n,
      };
    });

    await expect(t.submitter.recover()).rejects.toBe(reason);

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.reconcile).not.toHaveBeenCalled();
  });

  it('forwards submission to the adapter without a separate recovery pass', async () => {
    const t = setup();

    const result = await t.submitter.submit(t.request, 8);
    const statusReadsDuringSubmission = t.readStatus.mock.calls.length;

    expect(result).toBe(t.submissionResult);
    expect(statusReadsDuringSubmission).toBe(0);

    expect(mocks.submitBeaconTransaction)
      .toHaveBeenCalledExactlyOnceWith({
        manager: t.options.manager,
        request: t.request,
        signal: t.controller.signal,
      }, 8);

    expect(mocks.submitBeaconTransaction.mock.calls[0]![0].request)
      .toBe(t.request);

    expect(t.readChainHeads).not.toHaveBeenCalled();
    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 'already-retained',
      retained: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        workId: 'test-work:retained',
      },
    },
    {
      status: 'deferred',
      primaryReason: 'unresolved-attempt',
      reasons: ['unresolved-attempt'],
    },
  ] as const satisfies readonly SubmitTransactionWorkResult[])(
    'forwards the adapter’s $status result unchanged',
    async (result) => {
      const t = setup();

      mocks.submitBeaconTransaction.mockResolvedValueOnce(result);

      await expect(t.submitter.submit(t.request, 7)).resolves.toBe(result);

      expect(t.readStatus).not.toHaveBeenCalled();
      expect(mocks.submitBeaconTransaction).toHaveBeenCalledOnce();
      expect(t.reconcile).not.toHaveBeenCalled();
    },
  );

  it('propagates submission failure without retrying', async () => {
    const t = setup();
    const failure = new Error('Submission failed');

    mocks.submitBeaconTransaction.mockRejectedValueOnce(failure);

    await expect(t.submitter.submit(t.request)).rejects.toBe(failure);

    expect(mocks.submitBeaconTransaction).toHaveBeenCalledOnce();
    expect(t.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    'signed',
    'broadcast-may-have-occurred',
    'included',
  ] as const)(
    'returns the existing frozen summary for retained work in phase %s',
    (phase) => {
        const t = setup();
        const retained = retainedAttempt(phase);

        t.readStatus.mockReturnValue({
        ...t.status,
        attempts: Object.freeze([retained]),
      });

      const result = t.submitter.findRetainedWork(retained.workId);

      expect(result).toBe(retained);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result!.transactionHashes)).toBe(true);
      expect(t.readStatus).toHaveBeenCalledOnce();

      expect(t.reconcile).not.toHaveBeenCalled();
      expect(t.options.readChainHeads).not.toHaveBeenCalled();
      expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
    },
  );

  it('matches retained work by exact identity and returns null otherwise', () => {
    const t = setup();
    const retained = retainedAttempt('included');

    const unrelated: TransactionAttemptSummary = Object.freeze({
      ...retained,
      attemptId: '22222222-2222-4222-8222-222222222222',
      workId: 'test-work:unrelated',
      nonce: 3n,
    });

    t.readStatus.mockReturnValue({
      ...t.status,
      attempts: Object.freeze([unrelated, retained]),
    });

    expect(t.submitter.findRetainedWork(retained.workId))
      .toBe(retained);

    expect(t.submitter.findRetainedWork('test-work:missing'))
      .toBeNull();

    expect(t.submitter.findRetainedWork('TEST-WORK:RETAINED'))
      .toBeNull();

    expect(t.submitter.findRetainedWork('test-work:retained '))
      .toBeNull();

    expect(t.readStatus).toHaveBeenCalledTimes(4);
    expect(t.reconcile).not.toHaveBeenCalled();
    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
  });

  it('reads the current retained population on every lookup', () => {
    const t = setup();
    const retained = retainedAttempt('included');

    // The submitter already exists before the retained record appears.
    expect(t.submitter.findRetainedWork(retained.workId)).toBeNull();

    t.readStatus.mockReturnValue({
      ...t.status,
      attempts: Object.freeze([retained]),
    });

    expect(t.submitter.findRetainedWork(retained.workId))
      .toBe(retained);

    t.readStatus.mockReturnValue({
      ...t.status,
      attempts: Object.freeze([]),
    });

    expect(t.submitter.findRetainedWork(retained.workId)).toBeNull();

    expect(t.readStatus).toHaveBeenCalledTimes(3);
    expect(t.reconcile).not.toHaveBeenCalled();
    expect(mocks.submitBeaconTransaction).not.toHaveBeenCalled();
  });
});