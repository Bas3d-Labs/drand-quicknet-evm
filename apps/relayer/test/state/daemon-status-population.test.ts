import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Exercise population > detail limit without changing production capacity.
// This override is local to this test file.
vi.mock('../../src/state/journal-bounds.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/journal-bounds.js')
  >();

  return {
    ...actual,
    MAX_RETAINED_ATTEMPTS: 3,
  };
});

import {
  createDaemonStatusPublisher,
} from '../../src/daemon/daemon-status-publisher.js';

import {
  projectDaemonSnapshotStatusOutput,
  renderDaemonSnapshotStatusOutput,
} from '../../src/cli/output/daemon-snapshot-status-output.js';

import {
  readDaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

import type {
  writeDaemonStatusFile,
} from '../../src/state/file-daemon-status-store.js';

import type {
  SignerRuntimeObservation,
} from '../../src/state/read-signer-runtime-observation.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const AT = '2026-10-24T12:00:00.000Z';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'11'.repeat(20)}` as const,
};

function detail(
  nonce: number,
  phase: 'signed' | 'broadcast-may-have-occurred' | 'included',
) {
  return {
    attemptId:
      '00000000-0000-4000-8000-'
      + nonce.toString(16).padStart(12, '0'),
    workId: `test-work:${nonce}`,
    nonce: String(nonce),
    phase,
    transactionHashes: [HASH],
  };
}

function snapshot() {
  return {
    version: 1,
    identity: IDENTITY,
    runId: RUN_ID,
    observedAt: AT,
    journalInitialized: true,
    lastCompletedCycle: null,
    lastRetryObservation: null,
    attemptSummary: {
      retainedCount: 3,
      includedCount: 1,
      unresolvedCount: 2,
      lowestNonce: '4',
      highestNonce: '6',
      detailedCount: 1,
      omittedCount: 2,
    },
    attempts: [detail(5, 'broadcast-may-have-occurred')],
    lastObservedGate: {
      open: false,
      primaryReason: 'unresolved-attempt',
      blockers: ['unresolved-attempt'],
      recoveryComplete: true,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
      blockedSince: AT,
    },
  };
}

function outputInput() {
  return {
    source: 'daemon-snapshot',
    snapshot: 'present',
    gate: 'unknown',
    age: {
      status: 'fresh',
      ageMs: 0,
    },
    observation: snapshot(),
  };
}

function runtime(): SignerRuntimeObservation {
  return {
    journalInitialized: true,
    status: {
      open: false,
      primaryReason: 'unresolved-attempt',
      blockers: ['unresolved-attempt'],
      recoveryComplete: true,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
      blockedSince: AT,
    },
    attempts: [
      {
        ...detail(4, 'included'),
        nonce: 4n,
        transactionHashes: [HASH],
      },
      {
        ...detail(5, 'broadcast-may-have-occurred'),
        nonce: 5n,
        transactionHashes: [HASH],
      },
      {
        ...detail(6, 'signed'),
        nonce: 6n,
        transactionHashes: [HASH],
      },
    ],
  };
}

describe('daemon status population summary', () => {
  it('accepts a larger population with bounded detached details', () => {
    const input = snapshot();
    const result = readDaemonStatusSnapshot(input, IDENTITY);

    expect(result).toEqual(input);
    expect(result.attemptSummary).not.toBe(input.attemptSummary);
    expect(Object.isFrozen(result.attemptSummary)).toBe(true);
    expect(Object.isFrozen(result.attempts)).toBe(true);

    input.attemptSummary.retainedCount = 0;

    expect(result.attemptSummary.retainedCount).toBe(3);
  });

  it.each([
    { name: 'missing', value: undefined },
    { name: 'null', value: null },
    { name: 'array', value: [] },
  ])('rejects a $name summary', ({ value }) => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      attemptSummary: value,
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it.each([
    { name: 'negative count', patch: { retainedCount: -1 } },
    { name: 'fractional count', patch: { unresolvedCount: 1.5 } },
    { name: 'unsafe count', patch: { retainedCount: Number.MAX_VALUE } },
    { name: 'population over capacity', patch: { retainedCount: 4 } },
    { name: 'phase sum mismatch', patch: { includedCount: 0 } },
    { name: 'detail count mismatch', patch: { detailedCount: 0 } },
    { name: 'omitted count mismatch', patch: { omittedCount: 1 } },
    { name: 'negative omitted count', patch: { omittedCount: -1 } },
    { name: 'missing lower bound', patch: { lowestNonce: null } },
    { name: 'missing upper bound', patch: { highestNonce: null } },
    { name: 'noncanonical nonce', patch: { lowestNonce: '04' } },
    { name: 'reversed range', patch: { lowestNonce: '7' } },
    {
      name: 'range too small for population',
      patch: { lowestNonce: '5', highestNonce: '6' },
    },
    {
      name: 'detail outside range',
      patch: { lowestNonce: '6', highestNonce: '8' },
    },
    {
      name: 'detail phase exceeds summary',
      patch: { includedCount: 3, unresolvedCount: 0 },
    },
  ])('rejects $name', ({ patch }) => {
    const input = snapshot();

    expect(() => readDaemonStatusSnapshot({
      ...input,
      attemptSummary: {
        ...input.attemptSummary,
        ...patch,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it('rejects included detail while unresolved records are omitted', () => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      attempts: [detail(4, 'included')],
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it('rejects a detail list above its own limit', () => {
    const input = snapshot();

    expect(() => readDaemonStatusSnapshot({
      ...input,
      attempts: [
        detail(5, 'broadcast-may-have-occurred'),
        detail(6, 'signed'),
      ],
      attemptSummary: {
        ...input.attemptSummary,
        detailedCount: 2,
        omittedCount: 1,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it('rejects omitted details when the population fits the detail limit', () => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      attempts: [],
      attemptSummary: {
        retainedCount: 1,
        includedCount: 0,
        unresolvedCount: 1,
        lowestNonce: '4',
        highestNonce: '4',
        detailedCount: 0,
        omittedCount: 1,
      },
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it('rejects retained population for an uninitialized journal', () => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      journalInitialized: false,
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it('renders total population and explicit omission separately from details', () => {
    const output = renderDaemonSnapshotStatusOutput(outputInput());

    expect(output).toContain('Last observed retained attempts: 3');
    expect(output).toContain('Stored included attempts: 1');
    expect(output).toContain('Stored unresolved attempts: 2');
    expect(output).toContain('Retained nonce range: 4-6');
    expect(output).toContain('Attempt details shown: 1 of 3');
    expect(output).toContain(
      'Attempt details omitted: 2; oldest unresolved attempts take priority.',
    );
    expect(output).toContain('Work identity: test-work:5');
    expect(output).not.toContain('Work identity: test-work:4');
    expect(output).not.toContain('Work identity: test-work:6');
  });

  it('rejects a summary getter without invoking it', () => {
    const input = outputInput();
    const getter = vi.fn(() => snapshot().attemptSummary);

    Object.defineProperty(input.observation, 'attemptSummary', {
      enumerable: true,
      get: getter,
    });

    expect(() => projectDaemonSnapshotStatusOutput(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    'retainedCount',
    'includedCount',
    'unresolvedCount',
    'lowestNonce',
    'highestNonce',
    'detailedCount',
    'omittedCount',
  ] as const)(
    'rejects a summary field getter without invoking it: %s',
    (field) => {
      const input = outputInput();
      const getter = vi.fn();

      Object.defineProperty(input.observation.attemptSummary, field, {
        enumerable: true,
        get: getter,
      });

      expect(() => projectDaemonSnapshotStatusOutput(input)).toThrow();
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('rejects inherited summary fields', () => {
    const input = outputInput();
    const summary = input.observation.attemptSummary;

    Reflect.deleteProperty(summary, 'retainedCount');
    Object.setPrototypeOf(summary, { retainedCount: 3 });

    expect(() => projectDaemonSnapshotStatusOutput(input)).toThrow();
  });

  it('publishes full population counts and prioritizes unresolved detail', async () => {
    const write = vi.fn<typeof writeDaemonStatusFile>()
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();

    const publisher = createDaemonStatusPublisher({
      identity: IDENTITY,
      runId: RUN_ID,
      now: () => Date.parse(AT),
      env: {},
      write,
      onFailure,
    });

    publisher.onInitialized(() => runtime());
    await publisher.publish();

    expect(onFailure).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();

    expect(write.mock.calls[0]![0].snapshot).toMatchObject({
      version: 1,
      attemptSummary: snapshot().attemptSummary,
      attempts: snapshot().attempts,
    });
  });

  it('rejects malformed omitted runtime records before projection', async () => {
    const write = vi.fn<typeof writeDaemonStatusFile>()
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const input = runtime();

    // The first included attempt would be omitted in favor of nonce 5.
    const invalid: SignerRuntimeObservation = {
      ...input,
      attempts: input.attempts.map((attempt, index) => {
        if (index === 0) {
          return {
            ...attempt,
            workId: '',
          };
        }

        return attempt;
      }),
    };

    const publisher = createDaemonStatusPublisher({
      identity: IDENTITY,
      runId: RUN_ID,
      now: () => Date.parse(AT),
      env: {},
      write,
      onFailure,
    });

    publisher.onInitialized(() => invalid);
    await publisher.publish();

    expect(write).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});