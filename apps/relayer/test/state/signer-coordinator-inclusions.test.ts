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
        attempts: [{
          attemptId: '11111111-1111-4111-8111-111111111111',
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

      coordinator.completeRecovery();
      lines.length = 0;

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

      const publicClient = {
        getBlock,
        getTransactionReceipt,
        getTransactionCount: vi.fn().mockResolvedValue(5),
      } as unknown as PublicClient;

      const options = {
        publicClient,
        head: anchorAt(110n),
        maxReplacementBlockRange: 2n,
      };

      save.mockImplementationOnce(async () => {
        expect(coordinator.status.open).toBe(false);
        expect(coordinator.status.inclusionChecksComplete).toBe(false);

        if (failWrite) {
          throw new Error('Durability uncertain');
        }
      });

      if (failWrite) {
        await expect(coordinator.checkInclusions(options))
          .rejects.toThrow('Journal persistence');

        expect(coordinator.attempts[0]?.phase)
          .toBe('broadcast-may-have-occurred');

        await coordinator.retryPersistence();

        expect(save.mock.calls[1]![0])
          .toBe(save.mock.calls[0]![0]);

        expect(coordinator.attempts[0]?.phase).toBe('included');

        expect(coordinator.status).toMatchObject({
          open: false,
          inclusionChecksComplete: false,
        });

        // Persistence retry alone does not restore authorization.
        await coordinator.checkInclusions(options);
      } else {
        await coordinator.checkInclusions(options);
      }

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
    },
  );
});