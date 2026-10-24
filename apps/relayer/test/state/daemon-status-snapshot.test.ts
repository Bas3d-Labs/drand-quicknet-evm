import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  classifySnapshotAge,
  readDaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

import {
  MAX_RETAINED_ATTEMPTS,
  MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
} from '../../src/state/journal-bounds.js';

import {
  MAX_DAEMON_STATUS_ATTEMPT_DETAILS,
} from '../../src/state/project-daemon-status-attempts.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

const AT = '2026-10-12T12:00:00.000Z';
const AT_MS = Date.parse(AT);
const RUN_ID = '11111111-1111-4111-8111-111111111111';

function snapshot() {
  return {
    version: 1,
    identity: { ...IDENTITY },
    runId: RUN_ID,
    observedAt: AT,
    journalInitialized: true,
    attemptSummary: {
      retainedCount: 0,
      includedCount: 0,
      unresolvedCount: 0,
      lowestNonce: null,
      highestNonce: null,
      detailedCount: 0,
      omittedCount: 0,
    },
    attempts: [],
    lastCompletedCycle: null,
    lastRetryObservation: null,
    lastObservedGate: {
      open: false,
      primaryReason: 'unresolved-attempt',
      blockers: ['unresolved-attempt'],
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle',
      blockedSince: null,
    },
  };
}

function rpcUsage() {
  return {
    collectorId: '22222222-2222-4222-8222-222222222222',
    startedAt: '2026-10-12T11:00:00.000Z',
    observedAt: '2026-10-12T12:00:00.000Z',
    logical: [],
    http: [{
      client: 'public' as const,
      started: 3,
      responses: 2,
      transportFailures: 1,
      inFlight: 0,
      statuses: {
        '2xx': 1,
        '3xx': 0,
        '4xx': 0,
        '5xx': 1,
      },
      durationMs: 12.3456789,
    }],
  };
}

function statusAttempts(
  count: number,
  hashesPerAttempt: number,
) {
  let hashNumber = 1;

  return Array.from({ length: count }, (_, index) => ({
    attemptId:
      '00000000-0000-4000-8000-'
      + (index + 1).toString(16).padStart(12, '0'),
    workId: 'status-bounds:' + index,
    nonce: String(index),
    phase: 'broadcast-may-have-occurred',
    transactionHashes: Array.from(
      { length: hashesPerAttempt },
      () => {
        const hash = '0x' + hashNumber.toString(16).padStart(64, '0');
        hashNumber += 1;
        return hash;
      },
    ),
  }));
}

function unresolvedSummary(
  retainedCount: number,
  detailedCount: number,
) {
  let lowestNonce: string | null = null;
  let highestNonce: string | null = null;

  if (retainedCount > 0) {
    lowestNonce = '0';
    highestNonce = String(retainedCount - 1);
  }

  return {
    retainedCount,
    includedCount: 0,
    unresolvedCount: retainedCount,
    lowestNonce,
    highestNonce,
    detailedCount,
    omittedCount: retainedCount - detailedCount,
  };
}

describe('readDaemonStatusSnapshot', () => {
  it('returns detached, frozen public fields', () => {
    const input = {
      ...snapshot(),
      signedTransaction: 'must-not-appear',
    };

    const result = readDaemonStatusSnapshot(input, IDENTITY);

    expect(result).toEqual(snapshot());
    expect(JSON.stringify(result)).not.toContain('must-not-appear');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(Object.isFrozen(result.lastObservedGate)).toBe(true);
    expect(Object.isFrozen(result.lastObservedGate.blockers)).toBe(true);

    input.identity.chainId = 999;
    input.lastObservedGate.blockers.push('persistence-failure');

    expect(result.identity.chainId).toBe(4663);
    expect(result.lastObservedGate.blockers)
      .toEqual(['unresolved-attempt']);
  });

  it('accepts signer casing differences', () => {
    const input = snapshot();
    input.identity.signer = `0x${'AB'.repeat(20)}`;

    expect(readDaemonStatusSnapshot(input, IDENTITY).identity)
      .toEqual(IDENTITY);
  });

  it.each([true, false])(
    'accepts an empty blocker list with open:%s',
    (open) => {
      const base = snapshot();

      const input = {
        ...base,
        lastObservedGate: {
          ...base.lastObservedGate,
          open,
          primaryReason: null,
          blockers: [],
        },
      };

      expect(readDaemonStatusSnapshot(input, IDENTITY).lastObservedGate)
        .toEqual(input.lastObservedGate);
    },
  );

  it.each([
    { name: 'unsupported version', patch: { version: 2 } },
    { name: 'invalid run ID', patch: { runId: 'not-a-run-id' } },
    { name: 'invalid timestamp', patch: { observedAt: 'invalid' } },
    {
      name: 'noncanonical timestamp',
      patch: { observedAt: '2026-10-12T12:00:00Z' },
    },
    {
      name: 'wrong chain',
      patch: { identity: { ...IDENTITY, chainId: 1 } },
    },
    {
      name: 'wrong signer',
      patch: {
        identity: {
          ...IDENTITY,
          signer: `0x${'cd'.repeat(20)}`,
        },
      },
    },
    {
      name: 'unknown blocker',
      patch: {
        lastObservedGate: {
          open: false,
          primaryReason: 'unknown',
          blockers: ['unknown'],
        },
      },
    },
    {
      name: 'duplicate blockers',
      patch: {
        lastObservedGate: {
          open: false,
          primaryReason: 'unresolved-attempt',
          blockers: ['unresolved-attempt', 'unresolved-attempt'],
        },
      },
    },
    {
      name: 'inconsistent primary reason',
      patch: {
        lastObservedGate: {
          open: false,
          primaryReason: null,
          blockers: ['unresolved-attempt'],
        },
      },
    },
    {
      name: 'open gate with blockers',
      patch: {
        lastObservedGate: {
          open: true,
          primaryReason: 'unresolved-attempt',
          blockers: ['unresolved-attempt'],
        },
      },
    },
  ])('rejects $name', ({ patch }) => {
    const base = snapshot();

    const input = {
      ...base,
      ...patch,
      lastObservedGate: {
        ...base.lastObservedGate,
        ...('lastObservedGate' in patch
          ? patch.lastObservedGate
          : {}),
      },
    };

    expect(() => readDaemonStatusSnapshot(input, IDENTITY))
      .toThrow('Invalid daemon status snapshot.');
  });

  it('accepts bounded details and maximum candidate hashes without losing summary or gate information', () => {
    const detailedCount = Math.min(
      MAX_RETAINED_ATTEMPTS,
      MAX_DAEMON_STATUS_ATTEMPT_DETAILS,
    );

    const input = {
      ...snapshot(),
      attemptSummary: unresolvedSummary(
        MAX_RETAINED_ATTEMPTS,
        detailedCount,
      ),
      attempts: statusAttempts(
        detailedCount,
        MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      ),
    };
    const before = structuredClone(input);

    const result = readDaemonStatusSnapshot(input, IDENTITY);

    expect(result).toEqual(before);
    expect(input).toEqual(before);
    expect(result.attempts).toHaveLength(detailedCount);
    expect(result.attemptSummary).toEqual(input.attemptSummary);
    expect(Object.isFrozen(result.attemptSummary)).toBe(true);
    expect(result.attempts).not.toBe(input.attempts);
    expect(Object.isFrozen(result.attempts)).toBe(true);

    for (const [index, attempt] of result.attempts.entries()) {
      expect(attempt.transactionHashes).toHaveLength(
        MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      );

      expect(attempt).not.toBe(input.attempts[index]);
      expect(attempt.transactionHashes).not.toBe(
        input.attempts[index]!.transactionHashes,
      );

      expect(Object.isFrozen(attempt)).toBe(true);
      expect(Object.isFrozen(attempt.transactionHashes)).toBe(true);
    }

    expect(result.lastObservedGate).toEqual(input.lastObservedGate);
  });

  it('rejects a population above the retention maximum even when details fit', () => {
    const retainedCount = MAX_RETAINED_ATTEMPTS + 1;

    const input = {
      ...snapshot(),
      attemptSummary: unresolvedSummary(retainedCount, 1),
      attempts: statusAttempts(1, 1),
    };

    const before = structuredClone(input);

    expect(() => readDaemonStatusSnapshot(input, IDENTITY))
      .toThrow('Invalid daemon status snapshot.');

    expect(input).toEqual(before);
  });

  it('rejects one transaction hash above the per-attempt maximum', () => {
    const input = {
      ...snapshot(),
      attemptSummary: unresolvedSummary(1, 1),
      attempts: statusAttempts(
        1,
        MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1,
      ),
    };
    const before = structuredClone(input);

    expect(() => readDaemonStatusSnapshot(input, IDENTITY)).toThrow(
      'Invalid daemon status snapshot.',
    );

    expect(input).toEqual(before);
  });

  it('counts omitted included attempts toward the retention maximum', () => {
    const retainedCount = MAX_RETAINED_ATTEMPTS + 1;

    const input = {
      ...snapshot(),
      attemptSummary: {
        ...unresolvedSummary(retainedCount, 1),
        includedCount: retainedCount,
        unresolvedCount: 0,
      },
      attempts: statusAttempts(1, 1).map((attempt) => ({
        ...attempt,
        phase: 'included',
      })),
    };

    expect(() => readDaemonStatusSnapshot(input, IDENTITY))
      .toThrow('Invalid daemon status snapshot.');
  });

  it('still rejects an empty transaction-hash list', () => {
    const input = {
      ...snapshot(),
      attemptSummary: unresolvedSummary(1, 1),
      attempts: statusAttempts(1, 0),
    };

    expect(() => readDaemonStatusSnapshot(input, IDENTITY)).toThrow(
      'Invalid daemon status snapshot.',
    );
  });

  it('preserves compatibility with snapshots without RPC usage', () => {
    const input = snapshot();
    const result = readDaemonStatusSnapshot(input, IDENTITY);

    expect(result).toEqual(input);
    expect(Object.hasOwn(result, 'rpcUsage')).toBe(false);
  });

  it('retains detached and frozen RPC usage when present', () => {
    const usage = rpcUsage();
    const input = {
      ...snapshot(),
      rpcUsage: usage,
    };

    const result = readDaemonStatusSnapshot(input, IDENTITY);

    expect(result.rpcUsage).toEqual(usage);
    expect(result.rpcUsage).not.toBe(usage);
    expect(result.rpcUsage?.http).not.toBe(usage.http);
    expect(result.rpcUsage?.http[0]?.statuses)
      .not.toBe(usage.http[0]!.statuses);

    expect(Object.isFrozen(result.rpcUsage)).toBe(true);
    expect(Object.isFrozen(result.rpcUsage?.http)).toBe(true);
    expect(Object.isFrozen(result.rpcUsage?.http[0])).toBe(true);
    expect(Object.isFrozen(result.rpcUsage?.http[0]?.statuses))
      .toBe(true);

    usage.http[0]!.statuses['2xx'] = 0;

    expect(result.rpcUsage?.http[0]?.statuses['2xx']).toBe(1);
  });

  it.each([
    { name: 'null', value: null },
    { name: 'missing fields', value: {} },
    {
      name: 'invalid counters',
      value: {
        ...rpcUsage(),
        http: [{
          ...rpcUsage().http[0]!,
          responses: 4,
        }],
      },
    },
  ])('rejects RPC usage with $name', ({ value }) => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      rpcUsage: value,
    }, IDENTITY)).toThrow('Invalid RPC usage snapshot.');
  });
});

describe('classifySnapshotAge', () => {
  it.each([
    { elapsed: 0, status: 'fresh' },
    { elapsed: 120_000, status: 'fresh' },
    { elapsed: 120_001, status: 'stale' },
  ])('classifies age $elapsed as $status', ({ elapsed, status }) => {
    expect(classifySnapshotAge(AT, AT_MS + elapsed, 120_000))
      .toEqual({
        status,
        ageMs: elapsed,
      });
  });

  it('reports a future observation as clock skew', () => {
    expect(classifySnapshotAge(AT, AT_MS - 1, 120_000))
      .toEqual({
        status: 'clock-skew',
        ageMs: null,
      });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maximum age %s',
    (maxAgeMs) => {
      expect(() => classifySnapshotAge(AT, AT_MS, maxAgeMs))
        .toThrow('Invalid snapshot age parameters.');
    },
  );
});