import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  readDaemonStatusSnapshot,
  type DaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

function snapshot(): DaemonStatusSnapshot {
  return {
    version: 1,
    identity: IDENTITY,
    runId: '12345678-1234-4123-8123-123456789abc',
    observedAt: '2026-10-12T12:00:00.000Z',
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
      open: true,
      primaryReason: null,
      blockers: [],
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle',
      blockedSince: null,
    },
  };
}

describe('daemon status gate diagnostics', () => {
  it('projects recovery and persistence diagnostics explicitly', () => {
    const input = {
      ...snapshot(),
      lastObservedGate: {
        open: false,
        primaryReason: 'persistence-failure',
        blockers: ['persistence-failure'],
        recoveryComplete: false,
        inclusionChecksComplete: false,
        persistenceState: 'failed',
        blockedSince: '2026-10-12T11:59:00.000Z',
        signedTransaction: 'must-not-be-projected',
      },
    };

    const result = readDaemonStatusSnapshot(input, IDENTITY);

    expect(result.lastObservedGate).toEqual({
      open: false,
      primaryReason: 'persistence-failure',
      blockers: ['persistence-failure'],
      recoveryComplete: false,
      inclusionChecksComplete: false,
      persistenceState: 'failed',
      blockedSince: '2026-10-12T11:59:00.000Z',
    });

    expect(Object.isFrozen(result.lastObservedGate)).toBe(true);
  });

  it('rejects the retired journal-capacity blocker in persisted status', () => {
    const input = snapshot();

    const current = {
      ...input,
      lastObservedGate: {
        ...input.lastObservedGate,
        open: false,
        primaryReason: 'retention-capacity-reached',
        blockers: ['retention-capacity-reached'],
        blockedSince: '2026-10-12T11:59:00.000Z',
      },
    };

    // Establish that the surrounding snapshot and current spelling
    // are accepted before checking the retired spelling.
    expect(
      readDaemonStatusSnapshot(current, IDENTITY)
        .lastObservedGate.blockers,
    ).toEqual(['retention-capacity-reached']);

    expect(() => readDaemonStatusSnapshot({
      ...current,
      lastObservedGate: {
        ...current.lastObservedGate,
        primaryReason: 'journal-capacity-reached',
        blockers: ['journal-capacity-reached'],
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it.each([
    { recoveryComplete: false },
    { inclusionChecksComplete: false },
    { persistenceState: 'writing' },
    { persistenceState: 'failed' },
  ])('rejects an open gate with incompatible state: %j', (patch) => {
    const input = snapshot();

    expect(() => readDaemonStatusSnapshot({
      ...input,
      lastObservedGate: {
        ...input.lastObservedGate,
        ...patch,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it('rejects an open gate without an initialized journal', () => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      journalInitialized: false,
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it.each([
    { recoveryComplete: undefined },
    { recoveryComplete: 'true' },
    { inclusionChecksComplete: undefined },
    { inclusionChecksComplete: 1 },
    { persistenceState: undefined },
    { persistenceState: 'unknown' },
    { blockedSince: undefined },
    { blockedSince: 'invalid' },
    { blockedSince: '2026-10-12T11:59:00Z' },
  ])('rejects malformed gate diagnostics: %j', (patch) => {
    const input = snapshot();

    expect(() => readDaemonStatusSnapshot({
      ...input,
      lastObservedGate: {
        ...input.lastObservedGate,
        open: false,
        ...patch,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it.each([undefined, null, 'true', 1])(
    'rejects invalid journal initialization state: %j',
    (journalInitialized) => {
      expect(() => readDaemonStatusSnapshot({
        ...snapshot(),
        journalInitialized,
      }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
    },
  );

  it('preserves a closed gate without reported blockers', () => {
    const input = snapshot();

    const result = readDaemonStatusSnapshot({
      ...input,
      lastObservedGate: {
        ...input.lastObservedGate,
        open: false,
        persistenceState: 'writing',
      },
    }, IDENTITY);

    expect(result.lastObservedGate).toMatchObject({
      open: false,
      primaryReason: null,
      blockers: [],
      persistenceState: 'writing',
    });
  });

  it('does not infer timestamp ordering across wall-clock changes', () => {
    const input = snapshot();

    const result = readDaemonStatusSnapshot({
      ...input,
      lastObservedGate: {
        ...input.lastObservedGate,
        open: false,
        blockedSince: '2026-10-12T12:01:00.000Z',
      },
    }, IDENTITY);

    expect(result.lastObservedGate.blockedSince)
      .toBe('2026-10-12T12:01:00.000Z');
  });
});