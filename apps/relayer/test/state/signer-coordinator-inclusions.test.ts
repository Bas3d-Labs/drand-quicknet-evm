import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const REPLACEMENT = `0x${'bb'.repeat(32)}` as const;

const hashAt = (number: bigint) =>
  `0x${number.toString(16).padStart(64, '0')}` as Hash;

const anchorAt = (number: bigint) => ({
  blockNumber: number,
  blockHash: hashAt(number),
});

describe('coordinator replacement inclusions', () => {
  it.each([false, true])(
    'retains replacement evidence without durable resolution; failed write: %s',
    async (failWrite) => {
      const signedTransaction = await ACCOUNT.signTransaction({
        type: 'eip1559',
        chainId: 4663,
        nonce: 4,
        gas: 21_000n,
        to: ACCOUNT.address,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      });

      const transactionHash = keccak256(signedTransaction);

      const baseline = {
        anchor: anchorAt(100n),
        nonce: 4n,
      };

      const snapshot: TransactionJournalSnapshot = {
        version: 1,
        identity: {
          chainId: 4663,
          signer: ACCOUNT.address,
        },
        baseline,
        lastObservation: baseline,
        nextNonce: 5n,
        durableNextNonce: 4n,
        repairs: [],
        attempts: [{
          attemptId: '11111111-1111-4111-8111-111111111111',
          workId: 'test-work:4',
          nonce: 4n,
          createdAt: '2026-10-04T00:00:00.000Z',
          signedTransactions: [{
            transactionHash,
            signedTransaction,
          }],
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
          replacementSearch: {
            lowerBound: baseline,
            searchedThrough: null,
          },
        }],
      };

      const lines: string[] = [];

      const save = vi.fn<TransactionJournalStore['save']>()
        .mockResolvedValue(undefined);

      const coordinator = await SignerCoordinator.create({
        identity: snapshot.identity,
        maxRetainedAttempts: 2,
        store: {
          load: async () => ({ kind: 'present', snapshot }),
          save,
        },
        log: createRelayerLog({
          chainId: 4663,
          destination: {
            write(line) {
              lines.push(line);
            },
          },
        }),
        createErrorSummary: () => ({
          scrubText: () => ({
            text: 'redacted',
            removed: true,
          }),
        }),
      });

      const getBlock = vi.fn(async (request: {
        blockNumber: bigint;
        includeTransactions?: boolean;
      }) => ({
        number: request.blockNumber,
        hash: hashAt(request.blockNumber),
        parentHash: hashAt(request.blockNumber - 1n),
        transactions: request.blockNumber === 101n
          ? [{
              hash: REPLACEMENT,
              from: ACCOUNT.address,
              nonce: 4,
            }]
          : [],
      }));

      const getTransactionReceipt = vi.fn(async (
        request: { hash: Hash },
      ) => {
        if (request.hash !== REPLACEMENT) {
          throw new TransactionReceiptNotFoundError({
            hash: request.hash,
          });
        }

        return {
          transactionHash: REPLACEMENT,
          blockNumber: 101n,
          blockHash: hashAt(101n),
          status: 'reverted',
        };
      });

      const getTransactionCount = vi.fn().mockResolvedValue(5);

      const publicClient = {
        getBlock,
        getTransactionReceipt,
        getTransactionCount,
      } as unknown as PublicClient;

      // At the durable baseline, nonce 4 remains unconsumed.
      // The later head inspection will discover its replacement.
      getTransactionCount.mockResolvedValueOnce(4);

      const recovery = await coordinator.recover({
        publicClient,
        anchor: baseline.anchor,
        maxBlockRange: 2n,
      });

      expect(recovery).toMatchObject({
        status: 'unresolved',
        observation: baseline,
        receipt: {
          status: 'receipt-not-found',
        },
        search: null,
      });

      expect(coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: true,
        inclusionChecksComplete: false,
      });

      expect(coordinator.attempts).toHaveLength(1);
      expect(coordinator.attempts[0]?.phase)
        .toBe('broadcast-may-have-occurred');

      expect(save).toHaveBeenCalledOnce();

      // Subsequent assertions concern inclusion persistence, not setup recovery.
      save.mockClear();
      getBlock.mockClear();
      getTransactionReceipt.mockClear();
      getTransactionCount.mockClear();
      lines.length = 0;

      const options = {
        publicClient,
        head: anchorAt(110n),
        maxReplacementBlockRange: 2n,
      };

      const beforeInclusion = coordinator.durableRecoveryRevision;

      save.mockImplementationOnce(async () => {
        expect(coordinator.status.open).toBe(false);
        expect(coordinator.status.inclusionChecksComplete).toBe(false);
        expect(coordinator.durableRecoveryRevision).toBe(beforeInclusion);

        if (failWrite) {
          throw new Error('Durability uncertain');
        }
      });

      if (failWrite) {
        await expect(coordinator.checkInclusions(options))
          .rejects.toThrow('Journal persistence');

        expect(coordinator.durableRecoveryRevision).toBe(beforeInclusion);

        expect(coordinator.attempts[0]?.phase)
          .toBe('broadcast-may-have-occurred');

        await coordinator.retryPersistence();

        const afterRetry = coordinator.durableRecoveryRevision;

        expect(afterRetry).not.toBe(beforeInclusion);

        expect(save.mock.calls[1]![0])
          .toBe(save.mock.calls[0]![0]);

        expect(coordinator.attempts[0]?.phase).toBe('included');

        expect(coordinator.status).toMatchObject({
          open: false,
          inclusionChecksComplete: false,
        });

        // Persistence retry alone does not restore authorization.
        await coordinator.checkInclusions(options);

        expect(coordinator.durableRecoveryRevision).toBe(afterRetry);
      } else {
        await coordinator.checkInclusions(options);
      }

      expect(coordinator.durableRecoveryRevision)
        .not.toBe(beforeInclusion);

      expect(save.mock.calls[0]![0]).toMatchObject({
        nextNonce: 5n,
        durableNextNonce: 4n,
        attempts: [{
          nonce: 4n,
          phase: 'included',
          signedTransactions: [{
            transactionHash,
            signedTransaction,
          }],
          replacementSearch: {
            lowerBound: baseline,
            searchedThrough: null,
          },
          inclusion: {
            outcome: 'replaced',
            replacementTransactionHash: REPLACEMENT,
            nonceAtAnchor: 5n,
            inclusion: anchorAt(101n),
            observedAt: anchorAt(110n),
          },
        }],
      });

      expect(coordinator.attempts).toHaveLength(1);

      expect(coordinator.status).toMatchObject({
        open: true,
        recoveryComplete: true,
        inclusionChecksComplete: true,
      });

      expect(coordinator.canBroadcast).toBe(false);

      const events = lines.map((line) => JSON.parse(line).event);

      expect(events).not.toContain('attempt_resolved');
      expect(events.filter(
        (event) => event === 'signer_gate_released',
      )).toHaveLength(1);

      const retainedRevision = coordinator.durableRecoveryRevision;

      // Revalidate the replacement at a newer head. The replacement's
      // discovery nonce remains unchanged while observedAt advances.
      await coordinator.checkInclusions({
        ...options,
        head: anchorAt(120n),
      });

      expect(coordinator.durableRecoveryRevision).toBe(retainedRevision);

      const refreshed = save.mock.calls.at(-1)![0];

      expect(refreshed.attempts[0]).toMatchObject({
        phase: 'included',
        inclusion: {
          outcome: 'replaced',
          replacementTransactionHash: REPLACEMENT,
          nonceAtAnchor: 5n,
          observedAt: anchorAt(120n),
        },
      });

      // The durable pass observes nonce 4 at block 100, while the latest
      // pass observes nonce 5. Neither observation refresh changes the
      // retained replacement evidence or persistent blockers.
      for (let pass = 0; pass < 2; pass += 1) {
        getTransactionCount.mockResolvedValueOnce(4);

        await coordinator.recover({
          publicClient,
          anchor: baseline.anchor,
          maxBlockRange: 2n,
        });

        expect(save.mock.calls.at(-1)![0].lastObservation).toEqual({
          anchor: baseline.anchor,
          nonce: 4n,
        });

        expect(coordinator.durableRecoveryRevision).toBe(retainedRevision);

        await coordinator.checkInclusions({
          ...options,
          head: anchorAt(120n),
        });

        expect(save.mock.calls.at(-1)![0].lastObservation).toEqual({
          anchor: anchorAt(120n),
          nonce: 5n,
        });

        expect(coordinator.durableRecoveryRevision).toBe(retainedRevision);
      }

      expect(coordinator.status).toMatchObject({
        open: true,
        blockers: [],
      });
    },
  );
});