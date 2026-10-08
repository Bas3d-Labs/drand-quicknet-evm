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

import {
  encodeBeaconSubmission,
} from '../../src/rounds/encode-beacon-submission.js';

const preparationMocks = vi.hoisted(() => ({
  prepareRelayerTransaction: vi.fn(),
}));

vi.mock(
  '../../src/chain/prepare-relayer-transaction.js',
  () => preparationMocks,
);

import {
  submitBeaconTransaction,
} from '../../src/rounds/submit-beacon-transaction.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const SIGNER = ACCOUNT.address;

const REGISTRY =
  '0x2222222222222222222222222222222222222222' as const;

const HASH = `0x${'aa'.repeat(32)}` as const;
const SIGNATURE = `0x${'11'.repeat(48)}` as const;

function setup() {
  const events: string[] = [];

  const request = {
    address: REGISTRY,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'submitBeacon',
    args: [20_791_007n, SIGNATURE],
    gas: 150_000n,
  } as const;

  const transaction = {
    ...encodeBeaconSubmission(request),
    type: 'eip1559',
    gas: 150_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  } as const;

  preparationMocks.prepareRelayerTransaction.mockImplementation(
    async () => {
      events.push('prepare');
      return transaction;
    },
  );

  const attempt = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    transactionHash: HASH,
    nonce: 4n,
  };

  const broadcast = {
    ...attempt,
    status: 'acknowledged',
  } as const;

  const prepareAttempt = vi.fn().mockImplementation(async () => {
    events.push('persist');
    return attempt;
  });

  const broadcastAttempt = vi.fn().mockImplementation(async () => {
    events.push('broadcast');
    return broadcast;
  });

  const status = { open: true };

  const coordinator = {
    status,
    prepareAttempt,
    broadcastAttempt,
  } as unknown as SignerCoordinator;

  const options = {
    publicClient: {} as PublicClient,
    walletClient: {} as WalletClient,
    account: ACCOUNT,
    coordinator,
    request,
  };

  return {
    options,
    status,
    events,
    transaction,
    attempt,
    broadcast,
    prepareAttempt,
    broadcastAttempt,
  };
}

describe('beacon transaction submission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('prepares, persists, and broadcasts in order with cycle correlation', async () => {
    const t = setup();

    const result = await submitBeaconTransaction(t.options, 7);

    expect(t.events).toEqual([
      'prepare',
      'persist',
      'broadcast',
    ]);

    expect(preparationMocks.prepareRelayerTransaction)
      .toHaveBeenCalledExactlyOnceWith({
        walletClient: t.options.walletClient,
        signer: SIGNER,
        ...encodeBeaconSubmission(t.options.request),
        gas: 150_000n,
      });

    expect(t.prepareAttempt).toHaveBeenCalledExactlyOnceWith({
      account: t.options.account,
      transaction: t.transaction,
    }, 7);

    expect(t.broadcastAttempt).toHaveBeenCalledExactlyOnceWith({
      publicClient: t.options.publicClient,
      attemptId: t.attempt.attemptId,
    }, 7);

    expect(result).toBe(t.broadcast);
  });

  it('does no preparation while the signer gate is closed', async () => {
    const t = setup();
    t.status.open = false;

    await expect(
      submitBeaconTransaction(t.options),
    ).rejects.toThrow('The signer gate must be open');

    expect(preparationMocks.prepareRelayerTransaction)
      .not.toHaveBeenCalled();

    expect(t.prepareAttempt).not.toHaveBeenCalled();
    expect(t.broadcastAttempt).not.toHaveBeenCalled();
  });

  it('does not prepare an attempt when fee or gas preparation fails', async () => {
    const t = setup();
    const error = new Error('Preparation failed');

    preparationMocks.prepareRelayerTransaction
      .mockRejectedValueOnce(error);

    await expect(
      submitBeaconTransaction(t.options),
    ).rejects.toBe(error);

    expect(t.prepareAttempt).not.toHaveBeenCalled();
    expect(t.broadcastAttempt).not.toHaveBeenCalled();
  });

  it('does not broadcast when attempt preparation or persistence fails', async () => {
    const t = setup();
    const error = new Error('Journal persistence failed');

    t.prepareAttempt.mockRejectedValueOnce(error);

    await expect(
      submitBeaconTransaction(t.options),
    ).rejects.toBe(error);

    expect(t.prepareAttempt).toHaveBeenCalledOnce();
    expect(t.broadcastAttempt).not.toHaveBeenCalled();
  });

  it('propagates an uncertain broadcast without preparing or sending again', async () => {
    const t = setup();
    const error = new Error('Transaction broadcast outcome is uncertain');

    t.broadcastAttempt.mockRejectedValueOnce(error);

    await expect(
      submitBeaconTransaction(t.options),
    ).rejects.toBe(error);

    expect(preparationMocks.prepareRelayerTransaction)
      .toHaveBeenCalledOnce();

    expect(t.prepareAttempt).toHaveBeenCalledOnce();
    expect(t.broadcastAttempt).toHaveBeenCalledOnce();
  });
});