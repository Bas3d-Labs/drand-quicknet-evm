import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  TransactionReceiptNotFoundError,
} from 'viem';

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

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  encodeBeaconSubmission,
} from '../../src/rounds/encode-beacon-submission.js';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

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

  it('does no preparation when already cancelled', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    controller.abort(reason);

    await expect(submitBeaconTransaction({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(preparationMocks.prepareRelayerTransaction)
      .not.toHaveBeenCalled();

    expect(t.prepareAttempt).not.toHaveBeenCalled();
    expect(t.broadcastAttempt).not.toHaveBeenCalled();
  });

  it('does not sign when cancellation arrives during gas preparation', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    preparationMocks.prepareRelayerTransaction
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return t.transaction;
      });

    await expect(submitBeaconTransaction({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.prepareAttempt).not.toHaveBeenCalled();
    expect(t.broadcastAttempt).not.toHaveBeenCalled();
  });

  it('does not start broadcasting when cancellation arrives during persistence', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    t.prepareAttempt.mockImplementationOnce(async () => {
      controller.abort(reason);
      return t.attempt;
    });

    await expect(submitBeaconTransaction({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.prepareAttempt).toHaveBeenCalledOnce();
    expect(t.broadcastAttempt).not.toHaveBeenCalled();
  });

  it.each(['acknowledged', 'not-acknowledged'] as const)(
    'preserves a %s broadcast result when shutdown occurs during broadcasting',
    async (status) => {
      const t = setup();
      const controller = new AbortController();
      const reason = new Error('Shutdown requested.');
      const broadcast = {
        ...t.broadcast,
        status,
      };

      t.broadcastAttempt.mockImplementationOnce(async () => {
        controller.abort(reason);
        return broadcast;
      });

      const result = await submitBeaconTransaction({
        ...t.options,
        signal: controller.signal,
      }, 7);

      expect(result).toBe(broadcast);
      expect(controller.signal.aborted).toBe(true);

      expect(preparationMocks.prepareRelayerTransaction)
        .toHaveBeenCalledOnce();

      expect(t.prepareAttempt).toHaveBeenCalledOnce();
      expect(t.broadcastAttempt).toHaveBeenCalledExactlyOnceWith({
        publicClient: t.options.publicClient,
        attemptId: t.attempt.attemptId,
      }, 7);
    },
  );

  it('preserves a broadcast failure when shutdown occurs during broadcasting', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Shutdown requested.');
    const failure = new Error('Broadcast operation failed.');

    t.broadcastAttempt.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw failure;
    });

    await expect(submitBeaconTransaction({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(failure);

    expect(preparationMocks.prepareRelayerTransaction)
      .toHaveBeenCalledOnce();

    expect(t.prepareAttempt).toHaveBeenCalledOnce();
    expect(t.broadcastAttempt).toHaveBeenCalledOnce();
  });

  it('recovers the same signed transaction after cancellation prevents broadcast', async () => {
    const t = setup();
    const directory = await mkdtemp(join(tmpdir(), 'relayer-shutdown-'));

    try {
      const filePath = join(directory, 'journal.json');
      const identity = {
        chainId: 4663,
        signer: ACCOUNT.address,
      };
      const anchor = {
        blockNumber: 100n,
        blockHash: HASH,
      };
      const observation = {
        anchor,
        nonce: 4n,
      };

      const store = await FileTransactionJournalStore.open({
        filePath,
        identity,
      });

      await store.save({
        version: 1,
        identity,
        baseline: observation,
        lastObservation: observation,
        nextNonce: 4n,
        durableNextNonce: 4n,
        repairs: [],
        attempts: [],
      });

      const log = createRelayerLog({
        chainId: identity.chainId,
        destination: {
          write(_line: string) {},
        },
      });

      const createErrorSummary = (secrets: readonly string[] = []) => ({
        scrubText: createScrubber({
          rpcUrls: [],
          secrets,
        }),
      });

      const coordinator = await SignerCoordinator.create({
        identity,
        store,
        maxRetainedAttempts: 1,
        log,
        createErrorSummary,
      });

      const request = vi.fn<PublicClient['request']>();
      const getTransactionReceipt =
        vi.fn<PublicClient['getTransactionReceipt']>();

      const publicClient = {
        getBlock: async () => ({
          number: anchor.blockNumber,
          hash: anchor.blockHash,
        }),
        getTransactionCount: async () => 4,
        getTransactionReceipt,
        request,
      } as unknown as PublicClient;

      coordinator.completeRecovery();
      await coordinator.checkInclusions({
        publicClient,
        head: anchor,
      });

      const controller = new AbortController();
      const reason = new Error('Shutdown requested.');
      const signTransaction = vi.fn(ACCOUNT.signTransaction);
      const account = {
        ...ACCOUNT,
        signTransaction,
      };

      const ordinarySave = store.save.bind(store);
      const saveSpy = vi.spyOn(store, 'save')
        .mockImplementationOnce(async (snapshot) => {
          await ordinarySave(snapshot);
          controller.abort(reason);
        });

      await expect(submitBeaconTransaction({
        ...t.options,
        publicClient,
        account,
        coordinator,
        signal: controller.signal,
      })).rejects.toBe(reason);

      expect(saveSpy).toHaveBeenCalledOnce();
      expect(signTransaction).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();

      saveSpy.mockRestore();

      // Reopen from disk and create a fresh coordinator.
      const reopened = await FileTransactionJournalStore.open({
        filePath,
        identity,
      });
      const loaded = await reopened.load();

      expect(loaded.kind).toBe('present');

      if (loaded.kind !== 'present') {
        throw new Error('Expected the saved journal.');
      }

      expect(loaded.snapshot.nextNonce).toBe(5n);
      expect(loaded.snapshot.durableNextNonce).toBe(4n);
      expect(loaded.snapshot.attempts).toHaveLength(1);

      const attempt = loaded.snapshot.attempts[0]!;
      const signed = attempt.signedTransactions[0]!;

      expect(attempt.phase).toBe('signed');
      expect(attempt.nonce).toBe(4n);
      expect(attempt.signedTransactions).toHaveLength(1);

      const restarted = await SignerCoordinator.create({
        identity,
        store: reopened,
        maxRetainedAttempts: 1,
        log,
        createErrorSummary,
      });

      expect(restarted.status.open).toBe(false);
      expect(restarted.canBroadcast).toBe(false);

      await expect(restarted.prepareAttempt({
        account,
        transaction: t.transaction,
      })).rejects.toThrow('signer gate');

      await expect(restarted.broadcastAttempt({
        publicClient,
        attemptId: attempt.attemptId,
      })).rejects.toThrow('Fresh reconciliation');

      expect(request).not.toHaveBeenCalled();

      getTransactionReceipt.mockRejectedValue(
        new TransactionReceiptNotFoundError({
          hash: signed.transactionHash,
        }),
      );
      request.mockResolvedValue(signed.transactionHash);

      await restarted.recover({
        publicClient,
        anchor,
        maxBlockRange: 100n,
      });

      await expect(restarted.broadcastAttempt({
        publicClient,
        attemptId: attempt.attemptId,
      })).resolves.toEqual({
        status: 'acknowledged',
        attemptId: attempt.attemptId,
        transactionHash: signed.transactionHash,
        nonce: 4n,
      });

      expect(request).toHaveBeenCalledExactlyOnceWith({
        method: 'eth_sendRawTransaction',
        params: [signed.signedTransaction],
      }, {
        retryCount: 0,
      });

      expect(signTransaction).toHaveBeenCalledOnce();

      const after = await reopened.load();

      expect(after).toMatchObject({
        kind: 'present',
        snapshot: {
          nextNonce: 5n,
          durableNextNonce: 4n,
          attempts: [{
            attemptId: attempt.attemptId,
            nonce: 4n,
            phase: 'broadcast-may-have-occurred',
            signedTransactions: [signed],
          }],
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});