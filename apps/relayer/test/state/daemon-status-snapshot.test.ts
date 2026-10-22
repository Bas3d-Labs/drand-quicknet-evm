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

  it('accepts both supported bounds without dropping attempt or gate information', () => {
    const input = {
      ...snapshot(),
      attempts: statusAttempts(
        MAX_RETAINED_ATTEMPTS,
        MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      ),
    };
    const before = structuredClone(input);

    const result = readDaemonStatusSnapshot(input, IDENTITY);

    expect(result).toEqual(before);
    expect(input).toEqual(before);
    expect(result.attempts).toHaveLength(MAX_RETAINED_ATTEMPTS);
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

  it('rejects one retained attempt above the supported maximum', () => {
    const input = {
      ...snapshot(),
      attempts: statusAttempts(MAX_RETAINED_ATTEMPTS + 1, 1),
    };
    const before = structuredClone(input);

    expect(() => readDaemonStatusSnapshot(input, IDENTITY)).toThrow(
      'Invalid daemon status snapshot.',
    );

    expect(input).toEqual(before);
  });

  it('rejects one transaction hash above the per-attempt maximum', () => {
    const input = {
      ...snapshot(),
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

  it('counts included attempts toward the supported maximum', () => {
    const input = {
      ...snapshot(),
      attempts: statusAttempts(MAX_RETAINED_ATTEMPTS + 1, 1).map(
        (attempt) => ({
          ...attempt,
          phase: 'included',
        }),
      ),
    };

    expect(() => readDaemonStatusSnapshot(input, IDENTITY)).toThrow(
      'Invalid daemon status snapshot.',
    );
  });

  it('still rejects an empty transaction-hash list', () => {
    const input = {
      ...snapshot(),
      attempts: statusAttempts(1, 0),
    };

    expect(() => readDaemonStatusSnapshot(input, IDENTITY)).toThrow(
      'Invalid daemon status snapshot.',
    );
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