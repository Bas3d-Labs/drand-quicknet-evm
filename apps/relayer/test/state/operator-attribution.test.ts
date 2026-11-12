import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  maximumOutcome,
} from '../helpers/operator-outcome-fixture.js';

import {
  journalJson,
  readOperatorOutcome,
} from '../../src/state/journal-ledger-validation.js';

import {
  MAX_UINT256,
} from '../../src/shared/uint.js';

import {
  inspectSignerRecovery,
} from '../../src/chain/inspect-signer-recovery.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  durableRecoveryRevision,
} from '../../src/state/durable-recovery-revision.js';

import {
  journalSnapshotDigest,
} from '../../src/state/operator-attribution.js';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  DURABLE,
  IDENTITY,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

async function attributed() {
  const snapshot = await fixture();

  const rpc = client();

  const inspection = await inspectSignerRecovery({
    publicClient: rpc.publicClient,
    snapshot,
    anchor: DURABLE,
    maxBlockRange: 1n,
    hint: request().hint,
  });

  const plan = planSignerRecovery({
    identity: IDENTITY,
    snapshot,
    inspection,
    attribution: request(),
    unattributedActivity: false,
  });

  if (plan.kind !== 'persist') {
    throw new Error('Expected attribution plan.');
  }

  return {
    snapshot,
    inspection,
    plan,
  };
}

describe(
  'operator attribution persistence',
  () => {
    it.each([false, true])(
      'bounds maximum row bytes (escaped=%s)',
      (escaped) => {
        const row = maximumOutcome(0, MAX_UINT256 - 1n, escaped);

        const checked = readOperatorOutcome(row);

        const bytes = Buffer.byteLength(journalJson(checked), 'utf8');

        expect(checked).toEqual(row);
        expect(bytes).toBeLessThanOrEqual(8_192);
        expect(Object.isFrozen(checked.priorSearch)).toBe(true);
        expect(Object.isFrozen(checked.candidateHashes)).toBe(true);
        expect(checked).not.toBe(row);
      },
    );

    it(
      'binds the original encoding, atomically resolves and round-trips history',
      async () => {
        const { snapshot, plan } = await attributed();

        expect(plan.snapshot.attempts).toEqual([]);
        expect(plan.snapshot.durableNextNonce).toBe(5n);
        expect(plan.snapshot.nextNonce).toBe(5n);
        expect(plan.snapshot.ledger.outcomes).toHaveLength(1);
        expect(plan.snapshot.ledger.obligations).toEqual([]);
        expect(plan.completion.kind).toBe('operator-attribution');
        expect(plan.snapshot.ledger.outcomes[0]!.snapshotDigest)
          .toBe(journalSnapshotDigest(snapshot));
        expect(await decodeJournalSnapshot(
          await encodeJournalSnapshot(plan.snapshot, IDENTITY),
          IDENTITY,
        )).toEqual(plan.snapshot);

        const blockers = new Set<never>();

        const before = durableRecoveryRevision({
          kind: 'present',
          snapshot,
        }, blockers);

        const after = durableRecoveryRevision({
          kind: 'present',
          snapshot: plan.snapshot,
        }, blockers);

        const withoutHistory = durableRecoveryRevision({
          kind: 'present',
          snapshot: {
            ...plan.snapshot,
            ledger: {
              outcomes: [],
              obligations: [],
            },
          },
        }, blockers);

        expect(after).not.toBe(before);
        expect(after).toBe(withoutHistory);
      },
    );

    it(
      'refuses stale inspection evidence even when attempt identity still matches',
      async () => {
        const { snapshot, inspection } = await attributed();

        const changed = {
          ...snapshot,
          lastObservation: {
            anchor: DURABLE,
            nonce: 6n,
          },
        };

        expect(planSignerRecovery({
          identity: IDENTITY,
          snapshot: changed,
          inspection,
          attribution: request(),
          unattributedActivity: true,
        })).toEqual({
          kind: 'unchanged',
          reason: 'inspection-not-committable',
        });
      },
    );

    it.each([false, true])(
      'acknowledges a terminal write and preserves independent activity (retry=%s)',
      async (retry) => {
        const initial = await fixture();

        let stored = {
          ...initial,
          lastObservation: {
            anchor: DURABLE,
            nonce: 9n,
          },
        };

        const lines: string[] = [];

        const createErrorSummary = (secrets: readonly string[] = []) => ({
          scrubText: createScrubber({
            rpcUrls: [],
            secrets,
          }),
        });

        const log = createRelayerLog({
          chainId: IDENTITY.chainId,
          errorSummary: createErrorSummary(),
          destination: {
            write: (line) => { lines.push(line); },
          },
        });

        const save = vi.fn(async (next: TransactionJournalSnapshot) => {
          if (retry && save.mock.calls.length === 1) {
            throw new Error('uncertain save');
          }

          stored = await decodeJournalSnapshot(
            await encodeJournalSnapshot(next, IDENTITY),
            IDENTITY,
          );
        });

        const create = () => SignerCoordinator.create({
          identity: IDENTITY,
          store: {
            load: async () => ({
              kind: 'present',
              snapshot: stored,
            }),
            save,
          },
          maxRetainedAttempts: 16,
          log,
          createErrorSummary,
        });

        const coordinator = await create();

        const rpc = client();

        const pending = coordinator.recover({
          publicClient: rpc.publicClient,
          anchor: DURABLE,
          maxBlockRange: 1n,
          attribution: request(),
        }, 21);

        if (retry) {
          await expect(pending).rejects.toThrow('Journal persistence did not complete.');
          expect(stored.ledger.outcomes).toEqual([]);
          expect(lines.join('')).not.toContain('signer_attempt_operator_attributed');
          await coordinator.retryPersistence(22);
        } else {
          expect((await pending).status).toBe('operator-attribution-committed');
        }

        expect(stored.attempts).toEqual([]);
        expect(stored.ledger.outcomes).toHaveLength(1);
        expect(stored.lastObservation.nonce).toBe(9n);
        expect(coordinator.status.recoveryComplete).toBe(false);
        expect(coordinator.status.blockers).toContain('unattributed-signer-activity');
        expect((await create()).status.blockers).toContain('unattributed-signer-activity');
        expect(rpc.sendRawTransaction).not.toHaveBeenCalled();

        const events = lines.map((line) => JSON.parse(line))
          .filter((event) => event.event === 'signer_attempt_operator_attributed');

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          level: 40,
          supersededNoMatch: true,
        });
        expect(lines.join('')).not.toContain(
          initial.attempts[0]!.signedTransactions[0].signedTransaction,
        );
      },
    );

    it.each([
      'unknown-key',
      'derived-flag',
      'candidate-replacement',
      'duplicate-request',
      'duplicate-attempt',
      'duplicate-nonce',
      'obligation',
      'noncanonical-number',
      'nested-key',
    ])(
      'rejects %s on encode and decode',
      async (fault) => {
        const { plan } = await attributed();

        const encoded = await encodeJournalSnapshot(plan.snapshot, IDENTITY);

        const memory = structuredClone(plan.snapshot) as any;

        memory.baseline.nonce = 0n;

        const disk = JSON.parse(encoded);

        disk.baseline.nonce = '0';

        for (const value of [memory, disk]) {
          const row = value.ledger.outcomes[0];

          if (fault === 'unknown-key') {
            row.extra = true;
          }

          if (fault === 'derived-flag') {
            row.supersededNoMatch = true;
          }

          if (fault === 'candidate-replacement') {
            row.replacement.transactionHash = row.candidateHashes[0];
          }

          if (fault === 'obligation') {
            value.ledger.obligations.push({});
          }

          if (fault === 'nested-key') {
            row.replacement.inclusion.extra = true;
          }

          if (fault === 'noncanonical-number') {
            row.nonce = '04';
          }

          if (fault.startsWith('duplicate-')) {
            const second = structuredClone(row);

            second.requestId = '33333333-3333-4333-8333-333333333333';
            second.attemptId = '44444444-4444-4444-8444-444444444444';
            second.nonce = typeof row.nonce === 'bigint' ? 3n : '3';
            second.lowerBound.nonce = second.nonce;

            if (fault === 'duplicate-request') {
              second.requestId = row.requestId;
            }

            if (fault === 'duplicate-attempt') {
              second.attemptId = row.attemptId;
            }

            if (fault === 'duplicate-nonce') {
              second.nonce = row.nonce;
            }

            value.ledger.outcomes.unshift(second);
          }
        }

        await expect(encodeJournalSnapshot(memory, IDENTITY))
          .rejects.toThrow('Invalid transaction journal encoding.');
        await expect(decodeJournalSnapshot(JSON.stringify(disk), IDENTITY))
          .rejects.toThrow('Invalid transaction journal encoding.');
      },
    );
  },
);


it(
  'refuses a 33rd distinct outcome on both codec paths',
  async () => {
    const initial = await fixture();

    const full = {
      ...initial,
      baseline: {
        ...initial.baseline,
        nonce: 0n,
      },
      durableNextNonce: 33n,
      nextNonce: 33n,
      attempts: [],
      ledger: {
        outcomes: Array.from({
          length: 32,
        }, (_, index) => maximumOutcome(index, BigInt(index))),
        obligations: [] as const,
      },
    };

    const contents = await encodeJournalSnapshot(full, IDENTITY);

    const decoded = await decodeJournalSnapshot(contents, IDENTITY);

    expect(decoded.ledger.outcomes).toHaveLength(32);

    const overflow = {
      ...full,
      ledger: {
        outcomes: [...full.ledger.outcomes, maximumOutcome(32, 32n)],
        obligations: [] as const,
      },
    };

    await expect(encodeJournalSnapshot(overflow, IDENTITY))
      .rejects.toThrow('Invalid transaction journal encoding.');
    await expect(decodeJournalSnapshot(journalJson(overflow), IDENTITY))
      .rejects.toThrow('Invalid transaction journal encoding.');
  },
);
