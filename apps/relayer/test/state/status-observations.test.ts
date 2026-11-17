import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  projectDaemonSnapshotStatusOutput,
  renderDaemonSnapshotStatusOutput,
} from '../../src/cli/output/daemon-snapshot-status-output.js';

import {
  renderJournalStatusOutput,
} from '../../src/cli/output/journal-status-output.js';

import {
  MAX_UINT64,
} from '../../src/shared/uint.js';

import {
  readDaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

import {
  projectJournalStatus,
} from '../../src/state/project-journal-status.js';

import {
  observeStoredFactDispute,
  readOperatorHistory,
  readQueueObservation,
  readStoredFactDispute,
} from '../../src/state/status-observations.js';

import {
  FACT_CONFLICT,
  FACT_IDENTITY,
} from '../helpers/search-fact-fixture.js';

const AT = '2026-11-17T10:00:00.000Z';

function snapshot() {
  return {
    version: 1,
    identity: FACT_IDENTITY,
    runId: '11111111-1111-4111-8111-111111111111',
    observedAt: AT,
    journalInitialized: true,
    operatorHistory: {
      count: 0,
      limit: 32,
    },
    queue: {
      queuedCount: 2,
      dueCount: 1,
      limit: 1024,
      rejectedOffers: '0',
    },
    storedFactDispute: observeStoredFactDispute(FACT_CONFLICT, 'preparation', AT),
    lastCompletedCycle: null,
    lastRetryObservation: null,
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
      open: false,
      primaryReason: 'recovery-incomplete',
      blockers: ['recovery-incomplete'],
      recoveryComplete: false,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
      blockedSince: AT,
    },
  };
}

describe('status observation boundary', () => {
  it.each(['operatorHistory', 'queue', 'storedFactDispute'] as const)(
    'requires own %s, accepts null and rejects undefined',
    (key) => {
      const input: Record<string, unknown> = snapshot();

      delete input[key];

      expect(() => readDaemonStatusSnapshot(input, FACT_IDENTITY)).toThrow();

      input[key] = undefined;

      expect(() => readDaemonStatusSnapshot(input, FACT_IDENTITY)).toThrow();

      const get = vi.fn(() => null);

      Object.defineProperty(input, key, {
        get,
        configurable: true,
      });

      expect(() => readDaemonStatusSnapshot(input, FACT_IDENTITY)).toThrow();
      expect(get).not.toHaveBeenCalled();

      Object.defineProperty(input, key, { value: null });

      expect(readDaemonStatusSnapshot(input, FACT_IDENTITY)[key]).toBeNull();
    },
  );

  it('preserves exact counters and rejects the diagnostic overflow', () => {
    const queue = {
      queuedCount: 1024,
      dueCount: 1024,
      limit: 1024,
      rejectedOffers: MAX_UINT64.toString(),
    };

    expect(readQueueObservation(queue)).toEqual(queue);

    expect(() => readQueueObservation({
      ...queue,
      rejectedOffers: (MAX_UINT64 + 1n).toString(),
    })).toThrow();
  });

  it.each(['', '00', '01', '-1', '+1', '1.0', ' 1', '1e3', '１'])(
    'rejects noncanonical rejected offers %j',
    (rejectedOffers) => {
      expect(() => readQueueObservation({
        ...snapshot().queue,
        rejectedOffers,
      })).toThrow();
    },
  );

  it.each([
    { queuedCount: -1 },
    { queuedCount: 1025 },
    { dueCount: 3 },
    { dueCount: 0.5 },
    { limit: 16 },
    { rejectedOffers: 0 },
  ])('rejects invalid queue relations %j', (change) => {
    expect(() => readQueueObservation({
      ...snapshot().queue,
      ...change,
    })).toThrow();
  });

  it('validates history counts without confusing null and zero', () => {
    expect(readOperatorHistory(null)).toBeNull();
    expect(readOperatorHistory({
      count: 0,
      limit: 32,
    })).toEqual({ count: 0, limit: 32 });
    expect(readOperatorHistory({
      count: 32,
      limit: 32,
    })?.count).toBe(32);

    for (const count of [-1, 33, 0.5, '0', undefined]) {
      expect(() => readOperatorHistory({
        count,
        limit: 32,
      })).toThrow();
    }
  });

  it('projects bounded dispute fields without leaking extras or mutating input', () => {
    const input = {
      ...snapshot().storedFactDispute,
      secret: 'private',
      detail: {
        ...snapshot().storedFactDispute.detail,
        secret: 'private',
      },
    };

    const before = structuredClone(input);

    const result = readStoredFactDispute(input);

    expect(input).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(Object.isFrozen(result?.detail.first)).toBe(true);
    expect(result?.detail.first.nonce).toBe('6');
    expect(result?.detail.second.nonce).toBe('5');
  });

  it.each([
    ['origin', 'other'],
    ['observedAt', 'not-a-date'],
    ['detail', null],
  ])('rejects malformed dispute %s', (key, value) => {
    expect(() => readStoredFactDispute({
      ...snapshot().storedFactDispute,
      [key]: value,
    })).toThrow();
  });

  it('renders the observations under freshness and signing caveats', () => {
    const input = {
      source: 'daemon-snapshot',
      gate: 'unknown',
      snapshot: 'present',
      age: {
        status: 'stale',
        ageMs: 120001,
      },
      observation: snapshot(),
    };

    const output = renderDaemonSnapshotStatusOutput(input);

    expect(output).toContain('Acknowledged operator history: 0 / 32');
    expect(output).toContain('Last observed queued work: 2 / 1024');
    expect(output).toContain('Last observed due work: 1');
    expect(output).toContain('Last observed stored-fact dispute: stored-fact-nonce-conflict');
    expect(output).toContain('Dispute origin: preparation');
    expect(output).toContain(FACT_CONFLICT.first.attemptId);
    expect(output).toContain(FACT_CONFLICT.second.attemptId);
    expect(output).toContain('Snapshot age classification: stale');
    expect(output).toContain('Current signing authorization: unknown');

    const json = projectDaemonSnapshotStatusOutput(input);

    expect(json).toMatchObject({ observation: { queue: snapshot().queue } });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('keeps journal-only runtime observations unavailable', () => {
    const output = renderJournalStatusOutput(projectJournalStatus({ kind: 'missing' }));

    expect(output).toContain('Operator history: unavailable');
    expect(output).toContain('Queued work: unavailable from journal source');
    expect(output).toContain('Last observed stored-fact dispute: unavailable from journal source');
  });
});
