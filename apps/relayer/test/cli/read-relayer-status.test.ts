import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../../src/cli/read-journal-status.js', () => ({
  readJournalStatus: vi.fn(),
}));

vi.mock('../../src/state/file-daemon-status-store.js', () => ({
  readDaemonStatusFile: vi.fn(),
}));

import {
  readRelayerStatus,
} from '../../src/cli/read-relayer-status.js';

import {
  readJournalStatus,
} from '../../src/cli/read-journal-status.js';

import {
  readDaemonStatusFile,
} from '../../src/state/file-daemon-status-store.js';

import {
  readDaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

const AT = '2026-10-12T12:00:00.000Z';
const AT_MS = Date.parse(AT);

const ENV = {
  QUICKNET_STATE_DIR: '/verified-state',
};

const SNAPSHOT = readDaemonStatusSnapshot({
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
}, IDENTITY);

describe('readRelayerStatus', () => {
  beforeEach(() => {
    vi.mocked(readJournalStatus)
      .mockReset()
      .mockResolvedValue({
        source: 'journal',
        journal: 'missing',
        gate: 'unknown',
      });

    vi.mocked(readDaemonStatusFile)
      .mockReset()
      .mockResolvedValue(SNAPSHOT);
  });

  it('delegates journal inspection without reading a daemon snapshot', async () => {
    const controller = new AbortController();

    const result = await readRelayerStatus({
      source: 'journal',
      identity: IDENTITY,
      env: ENV,
      signal: controller.signal,
    });

    expect(result).toEqual({
      source: 'journal',
      journal: 'missing',
      gate: 'unknown',
    });

    expect(readJournalStatus).toHaveBeenCalledExactlyOnceWith({
      identity: IDENTITY,
      env: ENV,
      signal: controller.signal,
    });

    expect(readDaemonStatusFile).not.toHaveBeenCalled();
  });

  it('preserves journal failure without falling back to a snapshot', async () => {
    const failure = new Error('Journal inspection failed');

    vi.mocked(readJournalStatus).mockRejectedValueOnce(failure);

    await expect(readRelayerStatus({
      source: 'journal',
      identity: IDENTITY,
      env: ENV,
    })).rejects.toBe(failure);

    expect(readDaemonStatusFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      elapsed: 0,
      age: { status: 'fresh', ageMs: 0 },
    },
    {
      elapsed: 120_000,
      age: { status: 'fresh', ageMs: 120_000 },
    },
    {
      elapsed: 120_001,
      age: { status: 'stale', ageMs: 120_001 },
    },
    {
      elapsed: -1,
      age: { status: 'clock-skew', ageMs: null },
    },
  ] as const)(
    'reports snapshot age at elapsed $elapsed without claiming authorization',
    async ({ elapsed, age }) => {
      const result = await readRelayerStatus({
        source: 'daemon-snapshot',
        identity: IDENTITY,
        env: ENV,
        maxAgeMs: 120_000,
        now: () => AT_MS + elapsed,
      });

      expect(result).toEqual({
        source: 'daemon-snapshot',
        snapshot: 'present',
        gate: 'unknown',
        age,
        observation: SNAPSHOT,
      });

      expect(readDaemonStatusFile).toHaveBeenCalledExactlyOnceWith({
        identity: IDENTITY,
        env: ENV,
      });

      expect(readJournalStatus).not.toHaveBeenCalled();
    },
  );

  it('reports a missing snapshot without fabricating an observation', async () => {
    vi.mocked(readDaemonStatusFile).mockResolvedValueOnce(null);

    const now = vi.fn(() => AT_MS);

    const result = await readRelayerStatus({
      source: 'daemon-snapshot',
      identity: IDENTITY,
      env: ENV,
      maxAgeMs: 120_000,
      now,
    });

    expect(result).toEqual({
      source: 'daemon-snapshot',
      snapshot: 'missing',
      gate: 'unknown',
    });

    expect(now).not.toHaveBeenCalled();
    expect(readJournalStatus).not.toHaveBeenCalled();
  });

  it('preserves snapshot read failure without falling back to the journal', async () => {
    const failure = new Error('Snapshot validation failed');

    vi.mocked(readDaemonStatusFile).mockRejectedValueOnce(failure);

    await expect(readRelayerStatus({
      source: 'daemon-snapshot',
      identity: IDENTITY,
      env: ENV,
      maxAgeMs: 120_000,
    })).rejects.toBe(failure);

    expect(readJournalStatus).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maximum age %s before reading',
    async (maxAgeMs) => {
      await expect(readRelayerStatus({
        source: 'daemon-snapshot',
        identity: IDENTITY,
        env: ENV,
        maxAgeMs,
      })).rejects.toThrow('Invalid daemon snapshot maximum age.');

      expect(readDaemonStatusFile).not.toHaveBeenCalled();
      expect(readJournalStatus).not.toHaveBeenCalled();
    },
  );

  it('checks cancellation before reading either source', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled');

    controller.abort(reason);

    await expect(readRelayerStatus({
      source: 'journal',
      identity: IDENTITY,
      env: ENV,
      signal: controller.signal,
    })).rejects.toBe(reason);

    await expect(readRelayerStatus({
      source: 'daemon-snapshot',
      identity: IDENTITY,
      env: ENV,
      maxAgeMs: 120_000,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(readJournalStatus).not.toHaveBeenCalled();
    expect(readDaemonStatusFile).not.toHaveBeenCalled();
  });

  it('checks cancellation after a snapshot read completes', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled during read');
    const now = vi.fn(() => AT_MS);

    vi.mocked(readDaemonStatusFile).mockImplementationOnce(async () => {
      controller.abort(reason);
      return SNAPSHOT;
    });

    await expect(readRelayerStatus({
      source: 'daemon-snapshot',
      identity: IDENTITY,
      env: ENV,
      maxAgeMs: 120_000,
      now,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(now).not.toHaveBeenCalled();
  });
});