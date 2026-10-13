import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  classifySnapshotAge,
  readDaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

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