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

const AT = '2026-10-12T12:00:00.000Z';
const EARLIER = '2026-10-12T11:59:00.000Z';
const LATER = '2026-10-12T12:01:00.000Z';

function snapshot(): DaemonStatusSnapshot {
  return {
    version: 1,
    identity: IDENTITY,
    runId: '11111111-1111-4111-8111-111111111111',
    observedAt: AT,
    lastCompletedCycle: null,
    lastRetryObservation: null,
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

describe('daemon status progress observations', () => {
  it('preserves absent observations without inventing progress', () => {
    const result = readDaemonStatusSnapshot(snapshot(), IDENTITY);

    expect(result.lastCompletedCycle).toBeNull();
    expect(result.lastRetryObservation).toBeNull();
  });

  it('projects detached, frozen observations and excludes extra fields', () => {
    const completed = {
      cycle: 7,
      completedAt: EARLIER,
      extra: 'cycle-private',
    };

    const retry = {
      observedAt: EARLIER,
      retryDelayMs: 5_000,
      extra: 'retry-private',
    };

    const result = readDaemonStatusSnapshot({
      ...snapshot(),
      lastCompletedCycle: completed,
      lastRetryObservation: retry,
    }, IDENTITY);

    expect(result.lastCompletedCycle).toEqual({
      cycle: 7,
      completedAt: EARLIER,
    });

    expect(result.lastRetryObservation).toEqual({
      observedAt: EARLIER,
      retryDelayMs: 5_000,
    });

    expect(Object.isFrozen(result.lastCompletedCycle)).toBe(true);
    expect(Object.isFrozen(result.lastRetryObservation)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');

    completed.cycle = 99;
    completed.completedAt = LATER;
    retry.retryDelayMs = 0;
    retry.observedAt = LATER;

    expect(result.lastCompletedCycle?.cycle).toBe(7);
    expect(result.lastCompletedCycle?.completedAt).toBe(EARLIER);
    expect(result.lastRetryObservation?.retryDelayMs).toBe(5_000);
    expect(result.lastRetryObservation?.observedAt).toBe(EARLIER);
  });

  it.each([null, 0, 5_000])(
    'preserves reported retry delay %s',
    (retryDelayMs) => {
      const result = readDaemonStatusSnapshot({
        ...snapshot(),
        lastRetryObservation: {
          observedAt: EARLIER,
          retryDelayMs,
        },
      }, IDENTITY);

      expect(result.lastRetryObservation).toEqual({
        observedAt: EARLIER,
        retryDelayMs,
      });
    },
  );

  it('preserves retry timing without inferring gate authorization', () => {
    const base = snapshot();

    const result = readDaemonStatusSnapshot({
      ...base,
      lastObservedGate: {
        ...base.lastObservedGate,
        open: false,
        primaryReason: 'unresolved-attempt',
        blockers: ['unresolved-attempt'],
      },
      lastRetryObservation: {
        observedAt: EARLIER,
        retryDelayMs: 0,
      },
    }, IDENTITY);

    expect(result.lastObservedGate.open).toBe(false);
    expect(result.lastRetryObservation?.retryDelayMs).toBe(0);
  });

  it('accepts recovery observations before any cycle has completed', () => {
    const result = readDaemonStatusSnapshot({
      ...snapshot(),
      lastRetryObservation: {
        observedAt: EARLIER,
        retryDelayMs: null,
      },
    }, IDENTITY);

    expect(result.lastCompletedCycle).toBeNull();
    expect(result.lastRetryObservation).not.toBeNull();
  });

  it.each([
    undefined,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
  ])('rejects invalid cycle number %s', (cycle) => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      lastCompletedCycle: {
        cycle,
        completedAt: EARLIER,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it.each([
    undefined,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '5000',
  ])('rejects invalid retry delay %s', (retryDelayMs) => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      lastRetryObservation: {
        observedAt: EARLIER,
        retryDelayMs,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it.each([
    undefined,
    null,
    'invalid',
    '2026-10-12T11:59:00Z',
  ])('rejects invalid observation timestamps: %s', (timestamp) => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      lastCompletedCycle: {
        cycle: 1,
        completedAt: timestamp,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');

    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      lastRetryObservation: {
        observedAt: timestamp,
        retryDelayMs: null,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it.each([undefined, [], 'invalid'])(
    'rejects malformed observation containers: %j',
    (value) => {
      expect(() => readDaemonStatusSnapshot({
        ...snapshot(),
        lastCompletedCycle: value,
      }, IDENTITY)).toThrow('Invalid daemon status snapshot.');

      expect(() => readDaemonStatusSnapshot({
        ...snapshot(),
        lastRetryObservation: value,
      }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
    },
  );

  it('preserves timestamps across a backward wall-clock adjustment', () => {
    const result = readDaemonStatusSnapshot({
      ...snapshot(),
      lastCompletedCycle: {
        cycle: 1,
        completedAt: LATER,
      },
      lastRetryObservation: {
        observedAt: LATER,
        retryDelayMs: 5_000,
      },
    }, IDENTITY);

    expect(result.observedAt).toBe(AT);
    expect(result.lastCompletedCycle?.completedAt).toBe(LATER);
    expect(result.lastRetryObservation?.observedAt).toBe(LATER);
  });
});