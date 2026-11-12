import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  TransactionNotFoundError,
  type Hash,
} from 'viem';

import {
  inspectSignerRecovery,
} from '../../src/chain/inspect-signer-recovery.js';

import {
  anchoredReadDetails,
} from '../../src/diagnostics/anchored-read-errors.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  journalJson,
} from '../../src/state/journal-ledger-validation.js';

import {
  journalSnapshotDigest,
} from '../../src/state/operator-attribution.js';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

import {
  ACCOUNT,
  DURABLE,
  HINT_HASH,
  IDENTITY,
  OTHER_HASH,
  anchor,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

import {
  maximumOutcome,
} from '../helpers/operator-outcome-fixture.js';

async function coordinatorFor(
  snapshot: TransactionJournalSnapshot,
) {
  const save = vi.fn(async (_next: TransactionJournalSnapshot) => { });

  const createErrorSummary = () => ({
    scrubText: createScrubber({
      rpcUrls: [],
    }),
  });

  const coordinator = await SignerCoordinator.create({
    identity: IDENTITY,
    store: {
      load: async () => ({
        kind: 'present',
        snapshot,
      }),
      save,
    },
    maxRetainedAttempts: 16,
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      errorSummary: createErrorSummary(),
      destination: {
        write: () => { },
      },
    }),
    createErrorSummary,
  });

  return {
    coordinator,
    save,
  };
}

function inspect(
  snapshot: TransactionJournalSnapshot,
  rpc: ReturnType<typeof client>,
  hint = request().hint,
  durable = DURABLE,
) {
  return inspectSignerRecovery({
    publicClient: rpc.publicClient,
    snapshot,
    anchor: durable,
    maxBlockRange: 1n,
    hint,
  });
}

describe(
  'operator attribution review regressions',
  () => {
    it(
      'normalizes every outcome anchor without changing the journal digest premise',
      async () => {
        const base = await fixture();

        const mixed = (number: bigint) => ({
          blockNumber: number,
          blockHash: `0x${'aB'.repeat(32)}` as Hash,
        });

        const oldest = base.attempts[0]!;

        const snapshot: TransactionJournalSnapshot = {
          ...base,
          baseline: {
            anchor: mixed(98n),
            nonce: 4n,
          },
          lastObservation: {
            anchor: mixed(104n),
            nonce: 5n,
          },
          attempts: [{
            ...oldest,
            replacementSearch: {
              lowerBound: {
                anchor: mixed(98n),
                nonce: 4n,
              },
              searchedThrough: mixed(102n),
              exhausted: {
                anchor: mixed(100n),
                nonce: 5n,
              },
            },
          }],
        };

        const before = structuredClone(snapshot);

        const rpc = client();

        const original = rpc.getBlock.getMockImplementation()!;

        rpc.getBlock.mockImplementation(async (input) => ({
          ...await original(input),
          hash: mixed(input!.blockNumber!).blockHash,
          parentHash: mixed(input!.blockNumber! - 1n).blockHash,
        }));

        const inspection = await inspect(snapshot, rpc, request().hint, mixed(104n));

        const plan = planSignerRecovery({
          identity: IDENTITY,
          snapshot,
          inspection,
          attribution: request(),
          unattributedActivity: false,
        });

        expect(plan.kind).toBe('persist');

        if (plan.kind !== 'persist') {
          throw new Error('Expected attribution.');
        }

        const outcome = plan.snapshot.ledger.outcomes[0]!;

        for (const value of [
          outcome.durable.anchor,
          outcome.lowerBound.anchor,
          outcome.priorSearch.searchedThrough!,
          outcome.priorSearch.exhausted!.anchor,
          outcome.replacement.inclusion,
        ]) {
          expect(value.blockHash).toBe(`0x${'ab'.repeat(32)}`);
        }

        expect(outcome.snapshotDigest).toBe(journalSnapshotDigest(snapshot));
        expect(snapshot).toEqual(before);
        expect(await decodeJournalSnapshot(
          await encodeJournalSnapshot(plan.snapshot, IDENTITY),
          IDENTITY,
        )).toEqual(plan.snapshot);
      },
    );

    it.each([
      {
        mode: 'found',
        reason: null,
      },
      {
        mode: 'pending',
        reason: 'locator-pending',
      },
      {
        mode: 'missing',
        reason: 'locator-not-found',
      },
    ])(
      'handles the locator: $mode',
      async ({ mode, reason }) => {
        const snapshot = await fixture();

        const rpc = client();

        if (mode === 'pending') {
          rpc.getTransaction.mockResolvedValue({
            blockNumber: null,
          } as never);
        }

        if (mode === 'missing') {
          rpc.getTransaction.mockRejectedValue(new TransactionNotFoundError({
            hash: HINT_HASH,
          }));
        }

        const hint = {
          attemptId: request().hint.attemptId,
          transactionHash: HINT_HASH,
        };

        const result = await inspect(snapshot, rpc, hint);

        expect(rpc.getTransaction).toHaveBeenCalledExactlyOnceWith({
          hash: HINT_HASH,
        });

        if (reason === null) {
          expect(result.status).toBe('operator-attribution-available');
          expect(rpc.calls.at(-2)).toBe('101:true');
        } else {
          expect(result).toMatchObject({
            status: 'operator-hint-refused',
            reason,
          });
          expect(rpc.calls).toEqual([
            '104:false', 'receipt', '104:false',
            '104:false', 'nonce', '104:false',
          ]);
        }
      },
    );

    it.each([
      'retained-candidate-unresolved',
      'wrong-attempt',
      'nonce-unconsumed',
      'cursor-above-durable',
      'invalid-match',
    ])(
      'refuses %s with no write',
      async (reason) => {
        let snapshot = await fixture(null, null);

        const rpc = client();

        const attribution = request();

        let hint = attribution.hint;

        if (reason === 'retained-candidate-unresolved') {
          hint = {
            ...hint,
            transactionHash: snapshot.attempts[0]!.signedTransactions[0].transactionHash,
          };
        }

        if (reason === 'wrong-attempt') {
          hint = {
            ...hint,
            attemptId: '33333333-3333-4333-8333-333333333333',
          };
        }

        if (reason === 'nonce-unconsumed') {
          rpc.getTransactionCount.mockResolvedValue(4);
        }

        if (reason === 'cursor-above-durable') {
          snapshot = await fixture(null, 105n);
        }

        if (reason === 'invalid-match') {
          const original = rpc.getBlock.getMockImplementation()!;

          rpc.getBlock.mockImplementation(async (input) => {
            const block = await original(input);

            if (input?.includeTransactions) {
              return {
                ...block,
                transactions: [HINT_HASH],
              } as never;
            }

            return block;
          });
        }

        const { coordinator, save } = await coordinatorFor(snapshot);

        expect(await coordinator.recover({
          publicClient: rpc.publicClient,
          anchor: DURABLE,
          maxBlockRange: 1n,
          attribution: {
            ...attribution,
            hint,
          },
        })).toMatchObject({
          status: 'operator-hint-refused',
          reason,
        });

        expect(save).not.toHaveBeenCalled();
      },
    );

    it.each(['operator', 'at', 'requestId'])(
      'rejects invalid %s before the opening RPC',
      async (field) => {
        const snapshot = await fixture();

        const { coordinator, save } = await coordinatorFor(snapshot);

        const rpc = client();

        const attribution = {
          ...request(),
          [field]: '',
        };

        const owned = coordinator.beginInspection({
          publicClient: rpc.publicClient,
          head: anchor(106n),
          durableAnchor: DURABLE,
        });

        await expect(owned.recover({
          publicClient: rpc.publicClient,
          anchor: DURABLE,
          maxBlockRange: 1n,
          attribution,
        })).rejects.toThrow('Invalid operator attribution request.');

        expect(rpc.getBlock).not.toHaveBeenCalled();
        expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.getTransaction).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      },
    );

    it.each([98n, 100n, 102n, 104n])(
      'preserves scope and expected hash on a failed header at %s',
      async (height) => {
        const snapshot = await fixture();

        const rpc = client();

        const failure = new Error('header unavailable');

        const original = rpc.getBlock.getMockImplementation()!;

        let durableReads = 0;

        rpc.getBlock.mockImplementation(async (input) => {
          if (input?.blockNumber === 104n) {
            durableReads += 1;
          }

          if (input?.blockNumber === height && (height !== 104n || durableReads === 6)) {
            throw failure;
          }

          return original(input);
        });

        await expect(inspect(snapshot, rpc)).rejects.toBe(failure);
        expect(anchoredReadDetails(failure)).toMatchObject({
          operation: 'signer-recovery',
          blockNumber: height.toString(),
          expectedBlockHash: anchor(height).blockHash,
        });
      },
    );

    it(
      'allows cached inclusion to be superseded, but refuses a fresh above-D receipt',
      async () => {
        const base = await fixture();

        const oldest = base.attempts[0]!;

        const hash = oldest.signedTransactions[0].transactionHash;

        const snapshot: TransactionJournalSnapshot = {
          ...base,
          attempts: [{
            ...oldest,
            phase: 'included',
            inclusion: {
              outcome: 'success',
              transactionHash: hash,
              inclusion: {
                blockNumber: 101n,
                blockHash: OTHER_HASH,
              },
              observedAt: {
                blockNumber: 103n,
                blockHash: OTHER_HASH,
              },
            },
          }],
        };

        const rpc = client();

        expect((await inspect(snapshot, rpc)).status).toBe('operator-attribution-available');

        rpc.getTransactionReceipt.mockResolvedValue({
          transactionHash: hash,
          blockNumber: 105n,
          blockHash: anchor(105n).blockHash,
          status: 'success',
        } as never);

        expect((await inspect(snapshot, rpc)).status).toBe('inconsistent-observations');
      },
    );
  },
);

it.each([false, true])(
  'full history refuses hints, but allows ordinary resolution (receipt=%s)',
  async (receipt) => {
    const base = await fixture(null, null);

    const signedTransaction = await ACCOUNT.signTransaction({
      chainId: IDENTITY.chainId,
      nonce: 40,
      gas: 21_000n,
      to: ACCOUNT.address,
      type: 'eip1559',
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    const hash = keccak256(signedTransaction);

    const outcomes = Array.from({
      length: 32,
    }, (_, index) => ({
      ...maximumOutcome(index, BigInt(index)),
      lowerBound: {
        anchor: anchor(90n),
        nonce: BigInt(index),
      },
      durable: {
        anchor: anchor(95n),
        nonce: BigInt(index) + 1n,
      },
      replacement: {
        transactionHash: HINT_HASH,
        inclusion: anchor(94n),
      },
      priorSearch: {
        searchedThrough: null,
        exhausted: null,
      },
    }));

    const snapshot: TransactionJournalSnapshot = {
      ...base,
      baseline: {
        anchor: anchor(80n),
        nonce: 0n,
      },
      nextNonce: 41n,
      durableNextNonce: 40n,
      lastObservation: {
        anchor: DURABLE,
        nonce: 41n,
      },
      ledger: {
        outcomes,
        obligations: [],
      },
      attempts: [{
        ...base.attempts[0]!,
        nonce: 40n,
        signedTransactions: [{
          transactionHash: hash,
          signedTransaction,
        }],
        replacementSearch: {
          lowerBound: {
            anchor: anchor(98n),
            nonce: 40n,
          },
          searchedThrough: null,
          exhausted: null,
        },
      }],
    };

    const rpc = client();

    rpc.getTransactionCount.mockImplementation(async () => {
      rpc.calls.push('nonce');

      return 41;
    });

    if (receipt) {
      rpc.getTransactionReceipt.mockResolvedValue({
        transactionHash: hash,
        blockNumber: 101n,
        blockHash: anchor(101n).blockHash,
        status: 'success',
      } as never);
    }

    const { coordinator, save } = await coordinatorFor(snapshot);

    const result = await coordinator.recover({
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 1n,
      attribution: {
        ...request(),
        hint: {
          attemptId: request().hint.attemptId,
          transactionHash: HINT_HASH,
        },
      },
    });

    expect(rpc.getTransaction).not.toHaveBeenCalled();
    expect(rpc.getBlock.mock.calls.some(([input]) => input?.includeTransactions)).toBe(false);

    if (receipt) {
      expect(result.status).toBe('resolution-available');
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]![0].ledger.outcomes).toEqual(outcomes);
    } else {
      expect(result).toMatchObject({
        status: 'operator-hint-refused',
        reason: 'ledger-capacity-reached',
      });
      expect(save).not.toHaveBeenCalled();
      expect(rpc.calls).toEqual([
        '104:false', 'receipt', '104:false',
        '104:false', 'nonce', '104:false',
      ]);

      expect(planSignerRecovery({
        identity: IDENTITY,
        snapshot,
        unattributedActivity: false,
        attribution: request(),
        inspection: {
          status: 'operator-attribution-available',
          snapshotDigest: journalSnapshotDigest(snapshot),
          observation: {
            anchor: DURABLE,
            nonce: 41n,
          },
          observations: [],
          attemptId: request().hint.attemptId,
          transactionHash: HINT_HASH,
          inclusion: anchor(101n),
        },
      })).toEqual({
        kind: 'unchanged',
        reason: 'ledger-capacity-reached',
      });
    }
  },
);

it.each(['below-baseline', 'descending'])(
  'rejects history %s in both codec paths',
  async (fault) => {
    const base = await fixture();

    const outcomes = [maximumOutcome(0, 2n), maximumOutcome(1, 3n)];

    let baselineNonce = 0n;

    if (fault === 'descending') {
      outcomes.reverse();
    } else {
      baselineNonce = 3n;
    }

    const snapshot: TransactionJournalSnapshot = {
      ...base,
      baseline: {
        ...base.baseline,
        nonce: baselineNonce,
      },
      ledger: {
        outcomes,
        obligations: [],
      },
    };

    await expect(encodeJournalSnapshot(snapshot, IDENTITY))
      .rejects.toThrow('Invalid transaction journal encoding.');
    await expect(decodeJournalSnapshot(journalJson(snapshot), IDENTITY))
      .rejects.toThrow('Invalid transaction journal encoding.');
  },
);
