import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  projectDaemonSnapshotStatusOutput,
  renderDaemonSnapshotStatusOutput,
} from '../../../src/cli/output/daemon-snapshot-status-output.js';

const SIGNER = `0x${'ab'.repeat(20)}`;
const HASH = `0x${'aa'.repeat(32)}`;
const SECOND_HASH = `0x${'bb'.repeat(32)}`;
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const WORK_ID = ' work:e\u0301 ';
const AT = '2026-10-12T12:00:00.000Z';
const EARLIER = '2026-10-12T11:59:00.000Z';
const SECRET = 'signed-bytes-canary';

function status() {
  return {
    source: 'daemon-snapshot',
    snapshot: 'present',
    gate: 'unknown',
    age: {
      status: 'fresh',
      ageMs: 0,
    },
    observation: {
      version: 1,
      identity: {
        chainId: 4663,
        signer: SIGNER,
      },
      runId: RUN_ID,
      observedAt: AT,
      journalInitialized: true,
      lastObservedGate: {
        open: false,
        primaryReason: 'unresolved-attempt',
        blockers: ['unresolved-attempt'],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
        blockedSince: EARLIER,
      },
      attempts: [{
        attemptId: ATTEMPT_ID,
        workId: WORK_ID,
        nonce: '8',
        phase: 'signed',
        transactionHashes: [HASH, SECOND_HASH],
      }],
      lastCompletedCycle: {
        cycle: 2,
        completedAt: EARLIER,
      },
      lastRetryObservation: {
        observedAt: EARLIER,
        retryDelayMs: 5_000,
      },
    },
  };
}

describe('renderDaemonSnapshotStatusOutput', () => {
  it('reports a missing snapshot without inventing observations', () => {
    expect(renderDaemonSnapshotStatusOutput({
      source: 'daemon-snapshot',
      snapshot: 'missing',
      gate: 'unknown',
    })).toBe([
      'Status source: daemon snapshot',
      'Current signing authorization: unknown',
      'Snapshot: missing',
      'No daemon observation is available.',
    ].join('\n'));
  });

  it('renders historical gate state and every candidate hash', () => {
    const output = renderDaemonSnapshotStatusOutput(status());

    expect(output).toContain('Chain ID: 4663');
    expect(output).toContain('Signer: ' + SIGNER);
    expect(output).toContain('Run ID: ' + RUN_ID);
    expect(output).toContain('Observed at: ' + AT);
    expect(output).toContain('Last observed gate: closed');
    expect(output).toContain(
      'Last observed primary blocker: unresolved-attempt',
    );
    expect(output).toContain(
      'Coordinator-reported blocking episode start: ' + EARLIER,
    );
    expect(output).toContain('Attempt: ' + ATTEMPT_ID);
    expect(output.split('\n')).toContain('    Work identity: ' + WORK_ID);
    expect(output).toContain('      ' + HASH);
    expect(output).toContain('      ' + SECOND_HASH);
    expect(output).toContain('Current signing authorization: unknown');
  });

  it('rejects a missing work identity', () => {
    const input = status();
    Reflect.deleteProperty(input.observation.attempts[0]!, 'workId');

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon snapshot status output.');
  });

  it('passes work identity through shared snapshot validation', () => {
    const input = status();
    input.observation.attempts[0]!.workId = 'work\nforged';

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon status snapshot.');
  });

  it('rejects a work identity getter without invoking it', () => {
    const input = status();
    const getter = vi.fn(() => WORK_ID);

    Object.defineProperty(input.observation.attempts[0]!, 'workId', {
      get: getter,
    });

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon snapshot status output.');

    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'fresh', ageMs: 0 },
    { status: 'stale', ageMs: 120_001 },
    { status: 'clock-skew', ageMs: null },
  ])('renders age classification $status', (age) => {
    const output = renderDaemonSnapshotStatusOutput({
      ...status(),
      age,
    });

    expect(output).toContain(
      'Snapshot age classification: ' + age.status,
    );

    expect(output).toContain(
      age.ageMs === null
        ? 'Snapshot age (ms): unavailable. Observation is in the future'
        : 'Snapshot age (ms): ' + age.ageMs,
    );
  });

  it('does not turn a historically open gate into authorization', () => {
    const input = status();

    Object.assign(input.observation.lastObservedGate, {
      open: true,
      primaryReason: null,
      blockers: [],
      blockedSince: null,
    });
    input.observation.attempts = [];

    const output = renderDaemonSnapshotStatusOutput(input);

    expect(output).toContain('Last observed gate: open');
    expect(output).toContain('Current signing authorization: unknown');
    expect(output).toContain(
      'A fresh snapshot does not authorize signing or establish daemon health.',
    );
  });

  it('does not classify a closed gate without blockers as busy', () => {
    const input = status();

    Object.assign(input.observation.lastObservedGate, {
      primaryReason: null,
      blockers: [],
      blockedSince: null,
    });
    input.observation.attempts = [];

    const output = renderDaemonSnapshotStatusOutput(input);

    expect(output).toContain(
      'The gate was closed without a reported blocker. Its cause is unknown.',
    );
    expect(output).not.toContain('busy');
    expect(output).not.toContain('action required');
  });

  it('keeps publication, cycle, and retry timestamps distinct', () => {
    const output = renderDaemonSnapshotStatusOutput(status());

    expect(output).toContain('Observed at: ' + AT);
    expect(output).toContain('Last completed cycle: 2');
    expect(output).toContain('Cycle completed at: ' + EARLIER);
    expect(output).toContain('Retry observed at: ' + EARLIER);
    expect(output).toContain('Historical retry delay (ms): 5000');
    expect(output).toContain(
      'The retry delay is historical, not a countdown or permission to send.',
    );
  });

  it('reports absent cycle and retry observations explicitly', () => {
    const input = status();

    const output = renderDaemonSnapshotStatusOutput({
      ...input,
      observation: {
        ...input.observation,
        lastCompletedCycle: null,
        lastRetryObservation: null,
      },
    });

    expect(output).toContain('Last completed cycle: not observed');
    expect(output).toContain('Last retry observation: unavailable');
  });

  it.each([null, 0])(
    'preserves historical retry delay %s',
    (retryDelayMs) => {
      const input = status();

      const output = renderDaemonSnapshotStatusOutput({
        ...input,
        observation: {
          ...input.observation,
          lastRetryObservation: {
            observedAt: EARLIER,
            retryDelayMs,
          },
        },
      });

      expect(output).toContain(
        'Historical retry delay (ms): ' + (
          retryDelayMs === null ? 'none reported' : '0'
        ),
      );
    },
  );

  it('ignores undeclared fields and serialization hooks without mutation', () => {
    const input = status();
    const before = structuredClone(input);
    const toJSON = vi.fn(() => SECRET);
    const getter = vi.fn(() => SECRET);

    Object.assign(input.observation, {
      signedTransaction: SECRET,
      toJSON,
    });
    Object.assign(input.observation.attempts[0]!, {
      signedTransaction: SECRET,
    });
    Object.defineProperty(input.observation, 'extra', {
      get: getter,
    });

    const output = renderDaemonSnapshotStatusOutput(input);

    expect(output).not.toContain(SECRET);
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(input).toMatchObject(before);
  });

  it.each([
    { status: 'unknown', ageMs: 0 },
    { status: 'fresh', ageMs: -1 },
    { status: 'fresh', ageMs: 1.5 },
    { status: 'fresh', ageMs: Number.NaN },
    { status: 'stale', ageMs: null },
    { status: 'clock-skew', ageMs: 0 },
  ])('rejects malformed age: %j', (age) => {
    expect(() => renderDaemonSnapshotStatusOutput({
      ...status(),
      age,
    })).toThrow('Invalid daemon snapshot status output.');
  });

  it.each([
    { source: 'journal' },
    { snapshot: 'unknown' },
    { gate: 'open' },
  ])('rejects malformed result fields: %j', (patch) => {
    expect(() => renderDaemonSnapshotStatusOutput({
      ...status(),
      ...patch,
    })).toThrow('Invalid daemon snapshot status output.');
  });

  it('uses the shared validator for gate consistency', () => {
    const input = status();
    input.observation.lastObservedGate.open = true;

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon status snapshot.');
  });

  it('rejects an invalid candidate hash through the shared validator', () => {
    const input = status();
    input.observation.attempts[0]!.transactionHashes.push(SECRET);

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon status snapshot.');
  });

  it('rejects a displayed getter without invoking it', () => {
    const input = status();
    const getter = vi.fn(() => SECRET);

    Object.defineProperty(input.observation, 'runId', {
      get: getter,
    });

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon snapshot status output.');

    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects inherited displayed fields', () => {
    const input = status();

    Object.setPrototypeOf(input.observation.identity, {
      signer: SIGNER,
    });
    Reflect.deleteProperty(input.observation.identity, 'signer');

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon snapshot status output.');
  });

  it('rejects sparse candidate hash arrays', () => {
    const input = status();
    input.observation.attempts[0]!.transactionHashes = new Array(1);

    expect(() => renderDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon snapshot status output.');
  });

  it('projects detached fields without retaining undeclared properties', () => {
    const input = status();

    const projection = projectDaemonSnapshotStatusOutput({
      ...input,
      secret: SECRET,
      observation: {
        ...input.observation,
        secret: SECRET,
      },
    });

    expect(projection.snapshot).toBe('present');

    if (projection.snapshot !== 'present') {
      throw new Error('Expected a present snapshot projection.');
    }

    expect(projection).not.toHaveProperty('secret');
    expect(projection.observation).not.toHaveProperty('secret');

    input.observation.attempts[0]!.transactionHashes.push(HASH);
    input.age.ageMs = 100;

    expect(projection.observation.attempts[0]!.transactionHashes)
      .toEqual([HASH, SECOND_HASH]);
    expect(projection.age.ageMs).toBe(0);
  });
});