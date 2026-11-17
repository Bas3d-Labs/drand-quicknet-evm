import {
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  BroadcastRetrySchedule,
} from '../../src/state/broadcast-retry-schedule.js';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import {
  SignerRecoveryCycle,
} from '../../src/state/signer-recovery-cycle.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  FACT_IDENTITY,
  factAnchor,
  factObservation,
  searchFactFixture,
} from '../helpers/search-fact-fixture.js';

async function setup(options: { leading?: boolean; exhausted?: boolean } = {}) {
  const initial = await searchFactFixture(options.leading ? [3, 4, 5] : [4, 5]);

  const attempts = initial.attempts.map((attempt) => {
    let lowerBound = factObservation(100n, 4n);

    if (attempt.nonce === 3n) {
      lowerBound = factObservation(80n, 3n);
    } else if (attempt.nonce === 5n && !options.exhausted) {
      lowerBound = factObservation(120n, 5n);
    }

    let exhausted = null;

    if (options.exhausted && attempt.nonce === 5n) {
      exhausted = factObservation(120n, 7n);
    }

    return {
      ...attempt,
      replacementSearch: {
        lowerBound,
        searchedThrough: null,
        exhausted,
      },
    };
  });

  let snapshot: TransactionJournalSnapshot = { ...initial, attempts };

  let freshNonce = 6;

  const lines: string[] = [];

  const save = vi.fn(async (next: TransactionJournalSnapshot) => {
    snapshot = next;
  });

  const coordinator = await SignerCoordinator.create({
    identity: FACT_IDENTITY,
    maxRetainedAttempts: 16,
    store: {
      load: async () => ({ kind: 'present', snapshot }),
      save,
    },
    log: createRelayerLog({
      chainId: FACT_IDENTITY.chainId,
      level: 'debug',
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    }),
    createErrorSummary: (secrets = []) => ({
      scrubText: createScrubber({ rpcUrls: [], secrets }),
    }),
  });

  const request = vi.fn();

  const receipts = vi.fn(async ({ hash }) => {
    if (options.leading && hash === attempts[0]!.signedTransactions[0].transactionHash) {
      return {
        transactionHash: hash,
        blockNumber: 90n,
        blockHash: factAnchor(90n).blockHash,
        status: 'success',
      };
    }

    throw new TransactionReceiptNotFoundError({ hash });
  });

  const getBlock = vi.fn(async ({ blockNumber }) => ({
    number: blockNumber,
    hash: factAnchor(blockNumber).blockHash,
    parentHash: factAnchor(blockNumber - 1n).blockHash,
    transactions: [],
  }));

  const publicClient = {
    getBlock,
    getTransactionReceipt: receipts,
    getTransactionCount: vi.fn(async ({ blockNumber }) => blockNumber === 100n ? 4 : freshNonce),
    request,
  } as unknown as PublicClient;

  const cycle = new SignerRecoveryCycle({
    coordinator,
    schedule: new BroadcastRetrySchedule({
      initialDelayMs: 1000,
      maxDelayMs: 1000,
    }),
  });

  return {
    coordinator,
    save,
    lines,
    request,
    receipts,
    visible: () => snapshot,
    setNonce: (nonce: number) => {
      freshNonce = nonce;
    },
    run: (number: number) => cycle.run({
      publicClient,
      anchor: factAnchor(120n),
      head: factAnchor(130n),
      maxBlockRange: 50n,
    }, number),
  };
}

describe('stored fact runtime refusal', () => {
  it('refuses repeated cycles before save and reports the disputed pair', async () => {
    const t = await setup();

    const before = structuredClone(t.visible());

    for (const cycle of [1, 2]) {
      const result = await t.run(cycle);

      expect(result.inspection).toMatchObject({
        status: 'inconsistent-observations',
        detail: {
          reason: 'stored-fact-nonce-conflict',
          anchor: factAnchor(120n),
          first: {
            attemptId: before.attempts[0]!.attemptId,
            kind: 'exhausted',
            nonce: 6n,
            source: 'candidate',
          },
          second: {
            attemptId: before.attempts[1]!.attemptId,
            kind: 'lowerBound',
            nonce: 5n,
            source: 'retained',
          },
        },
      });
      expect(result.inclusions).toBeNull();
      expect(t.save).not.toHaveBeenCalled();
      expect(t.visible()).toEqual(before);
      expect(t.coordinator.status.persistenceState).toBe('idle');
      expect(t.coordinator.status.blockers).toContain('recovery-incomplete');
      expect(t.coordinator.status.blockers).not.toContain('persistence-failure');
      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.coordinator.status.open).toBe(false);
    }

    const conflicts = t.lines.map((line) => JSON.parse(line))
      .filter((line) => line.event === 'stored_fact_nonce_conflict');

    expect(conflicts.map((line) => line.level)).toEqual([40, 20]);
    expect(conflicts.map((line) => line.cycle)).toEqual([1, 2]);
    expect(conflicts[0]).toMatchObject({
      signer: FACT_IDENTITY.signer,
      firstAttemptId: before.attempts[0]!.attemptId,
      secondAttemptId: before.attempts[1]!.attemptId,
      firstNonce: '6',
      secondNonce: '5',
      firstExhausted: true,
      secondExhausted: false,
    });
    expect(t.receipts.mock.calls.every(([arg]) =>
      arg.hash === before.attempts[0]!.signedTransactions[0].transactionHash,
    )).toBe(true);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('progresses on consistent evidence and reports changed conflicts', async () => {
    const t = await setup();

    await t.run(1);
    t.setNonce(7);
    await t.run(2);

    const conflicts = t.lines.map((line) => JSON.parse(line))
      .filter((line) => line.event === 'stored_fact_nonce_conflict');

    expect(conflicts.map((line) => line.level)).toEqual([40, 40]);

    t.setNonce(5);

    const result = await t.run(3);

    expect(result.inspection.status).not.toBe('inconsistent-observations');
    expect(t.save).toHaveBeenCalled();
    expect(t.visible().attempts[0]!.replacementSearch?.exhausted?.nonce).toBe(5n);
    expect(t.coordinator.status.blockers).not.toContain('persistence-failure');
  });

  it.each([false, true])(
    'returns a typed candidate refusal; retained exhaustion: %s',
    async (exhausted) => {
      const input = await searchFactFixture();

      const snapshot = {
        ...input,
        attempts: input.attempts.map((attempt, index) => ({
          ...attempt,
          replacementSearch: {
            lowerBound: factObservation(
              index === 0 || exhausted ? 100n : 120n,
              index === 0 || exhausted ? 4n : 5n,
            ),
            searchedThrough: null,
            exhausted: index === 1 && exhausted ? factObservation(120n, 7n) : null,
          },
        })),
      };

      const before = structuredClone(snapshot);

      const plan = planSignerRecovery({
        identity: FACT_IDENTITY,
        snapshot,
        unattributedActivity: false,
        inspection: {
          status: 'unresolved',
          observation: factObservation(120n, 6n),
          observations: [],
          receipt: {
            status: 'receipt-not-found',
            observations: [],
          },
          search: {
            status: 'not-found',
            searchedThrough: factAnchor(120n),
            scannedBlocks: 20n,
            remainingBlocks: 0n,
            observations: [],
          },
        },
      });

      expect(plan.kind).toBe('inconsistent-observations');
      expect(snapshot).toEqual(before);
    },
  );
});


describe('stored fact refusal boundaries', () => {
  it('preserves an earlier acknowledged resolution and stops later attempts', async () => {
    const t = await setup({ leading: true });

    const before = structuredClone(t.visible());

    const result = await t.run(1);

    expect(result.inspection.status).toBe('inconsistent-observations');
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.visible().attempts).toEqual(before.attempts.slice(1));
    expect(t.visible().durableNextNonce).toBe(4n);
    expect(t.coordinator.status.persistenceState).toBe('idle');
    expect(t.coordinator.status.blockers).toContain('recovery-incomplete');
    expect(t.coordinator.status.blockers).not.toContain('persistence-failure');
    expect(t.receipts.mock.calls.map(([arg]) => arg.hash)).not.toContain(
      before.attempts[2]!.signedTransactions[0].transactionHash,
    );
    expect(t.request).not.toHaveBeenCalled();

    // Only a resolution can continue to another recovery segment. Its removal
    // is committed, so later cycles start at the refused attempt, not the prefix.
    for (const cycle of [2, 3]) {
      const repeated = await t.run(cycle);

      expect(repeated.inspection.status).toBe('inconsistent-observations');
      expect(t.save).toHaveBeenCalledTimes(1);
      expect(t.visible().attempts).toEqual(before.attempts.slice(1));
    }

    const conflicts = t.lines.map((line) => JSON.parse(line))
      .filter((line) => line.event === 'stored_fact_nonce_conflict');

    expect(conflicts.map((line) => line.level)).toEqual([40, 20, 20]);
    expect(conflicts.map((line) => line.cycle)).toEqual([1, 2, 3]);
  });

  it('refuses conflicting exhaustion facts without saving either as authoritative', async () => {
    const t = await setup({ exhausted: true });

    const before = structuredClone(t.visible());

    const result = await t.run(1);

    // The existing inspector refuses this pair before a candidate is planned.
    expect(result.inspection.status).toBe('inconsistent-observations');
    expect(t.save).not.toHaveBeenCalled();
    expect(t.visible()).toEqual(before);
    expect(t.coordinator.status.blockers).toContain('conflict-search-exhausted');
    expect(t.coordinator.status.blockers).not.toContain('persistence-failure');
  });
});

describe('remaining-fact planning', () => {
  it('refuses a newly seeded lower bound against another retained lower bound', async () => {
    const input = await searchFactFixture();

    const snapshot = {
      ...input,
      attempts: input.attempts.map((attempt, index) => ({
        ...attempt,
        replacementSearch: index === 0 ? null : {
          lowerBound: factObservation(120n, 5n),
          searchedThrough: null,
          exhausted: null,
        },
      })),
    };

    const plan = planSignerRecovery({
      identity: FACT_IDENTITY,
      snapshot,
      unattributedActivity: false,
      inspection: {
        status: 'unresolved',
        observation: factObservation(120n, 4n),
        observations: [],
        receipt: {
            status: 'receipt-not-found',
            observations: [],
          },
        search: null,
      },
    });

    expect(plan).toMatchObject({
      kind: 'inconsistent-observations',
      detail: {
        first: {
          kind: 'lowerBound',
          nonce: 4n,
          source: 'candidate',
        },
        second: {
          kind: 'lowerBound',
          nonce: 5n,
          source: 'retained',
        },
      },
    });
  });

  it('ordinary resolution only removes facts and does not compare removed facts', async () => {
    const snapshot = await searchFactFixture();

    const before = structuredClone(snapshot);

    const plan = planSignerRecovery({
      identity: FACT_IDENTITY,
      snapshot,
      unattributedActivity: false,
      inspection: {
        status: 'resolution-available',
        observation: factObservation(100n, 5n),
        observations: [],
        evidence: {
          outcome: 'success',
          anchor: factAnchor(100n),
          inclusion: factAnchor(100n),
          transactionHash: snapshot.attempts[0]!.signedTransactions[0].transactionHash,
        },
      },
    });

    expect(plan.kind).toBe('persist');

    if (plan.kind !== 'persist') {
      throw new Error('Expected a removal-only plan.');
    }

    expect(plan.snapshot.attempts).toEqual(snapshot.attempts.slice(1));
    expect(snapshot).toEqual(before);
  });
});
