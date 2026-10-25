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
      attemptSummary: {
        retainedCount: 1,
        includedCount: 0,
        unresolvedCount: 1,
        lowestNonce: '8',
        highestNonce: '8',
        detailedCount: 1,
        omittedCount: 0,
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

function statusWithRpcUsage() {
  const input = status();

  return {
    ...input,
    observation: {
      ...input.observation,
      rpcUsage: {
        collectorId: '33333333-3333-4333-8333-333333333333',
        startedAt: EARLIER,
        observedAt: AT,
        logical: [{
          client: 'public',
          method: 'eth_call',
          started: 4,
          completed: 3,
          failed: 1,
          inFlight: 1,
          durationMs: 12.75,
        }],
        http: [{
          client: 'public',
          started: 5,
          responses: 3,
          transportFailures: 1,
          inFlight: 1,
          statuses: {
            '2xx': 1,
            '3xx': 0,
            '4xx': 0,
            '5xx': 1,
          },
          durationMs: 10.5,
        }],
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

    expect(output).toContain('Last observed retained attempts: 1');
    expect(output).toContain('Attempt details shown: 1 of 1');
    expect(output).not.toContain('Attempt details omitted:');
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

    Object.assign(input.observation.attemptSummary, {
      retainedCount: 0,
      includedCount: 0,
      unresolvedCount: 0,
      lowestNonce: null,
      highestNonce: null,
      detailedCount: 0,
      omittedCount: 0,
    });

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

    Object.assign(input.observation.attemptSummary, {
      retainedCount: 0,
      includedCount: 0,
      unresolvedCount: 0,
      lowestNonce: null,
      highestNonce: null,
      detailedCount: 0,
      omittedCount: 0,
    });

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

describe('daemon snapshot RPC usage projection', () => {
  it('preserves older snapshots without RPC usage', () => {
    const projection = projectDaemonSnapshotStatusOutput(status());

    if (projection.snapshot !== 'present') {
      throw new Error('Expected a present snapshot projection.');
    }

    expect(Object.hasOwn(projection.observation, 'rpcUsage')).toBe(false);
  });

  it('projects detached frozen RPC usage without changing the input', () => {
    const input = statusWithRpcUsage();
    const before = structuredClone(input);

    const projection = projectDaemonSnapshotStatusOutput(input);

    if (projection.snapshot !== 'present') {
      throw new Error('Expected a present snapshot projection.');
    }

    const usage = projection.observation.rpcUsage;

    expect(usage).toEqual(input.observation.rpcUsage);
    expect(usage).not.toBe(input.observation.rpcUsage);
    expect(usage?.logical[0])
      .not.toBe(input.observation.rpcUsage.logical[0]);
    expect(usage?.http[0]?.statuses)
      .not.toBe(input.observation.rpcUsage.http[0]!.statuses);

    expect(Object.isFrozen(usage)).toBe(true);
    expect(Object.isFrozen(usage?.logical)).toBe(true);
    expect(Object.isFrozen(usage?.logical[0])).toBe(true);
    expect(Object.isFrozen(usage?.http)).toBe(true);
    expect(Object.isFrozen(usage?.http[0])).toBe(true);
    expect(Object.isFrozen(usage?.http[0]?.statuses)).toBe(true);

    expect(input).toEqual(before);
    expect(Object.isFrozen(input.observation.rpcUsage)).toBe(false);

    input.observation.rpcUsage.http[0]!.statuses['2xx'] = 0;

    expect(usage?.http[0]?.statuses['2xx']).toBe(1);
  });

  it('excludes undeclared RPC fields and serialization hooks', () => {
    const input = statusWithRpcUsage();
    const usage = input.observation.rpcUsage;
    const toJSON = vi.fn(() => SECRET);
    const getter = vi.fn(() => SECRET);

    for (const target of [
      usage,
      usage.logical[0]!,
      usage.http[0]!,
      usage.http[0]!.statuses,
    ]) {
      Object.assign(target, {
        secret: SECRET,
        toJSON,
      });

      Object.defineProperty(target, 'extra', {
        get: getter,
      });
    }

    const projection = projectDaemonSnapshotStatusOutput(input);
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('toJSON');
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    'rpcUsage',
    'collectorId',
    'logical',
    'logical element',
    'logical counter',
    'http',
    'HTTP element',
    'HTTP counter',
    'statuses',
    'status bucket',
  ] as const)(
    'rejects a getter for %s without invoking it',
    (field) => {
      const input = statusWithRpcUsage();
      const usage = input.observation.rpcUsage;
      const getter = vi.fn(() => {
        throw new Error(SECRET);
      });

      let target: object;
      let key: string;

      switch (field) {
        case 'rpcUsage':
          target = input.observation;
          key = 'rpcUsage';
          break;

        case 'collectorId':
          target = usage;
          key = 'collectorId';
          break;

        case 'logical':
          target = usage;
          key = 'logical';
          break;

        case 'logical element':
          target = usage.logical;
          key = '0';
          break;

        case 'logical counter':
          target = usage.logical[0]!;
          key = 'completed';
          break;

        case 'http':
          target = usage;
          key = 'http';
          break;

        case 'HTTP element':
          target = usage.http;
          key = '0';
          break;

        case 'HTTP counter':
          target = usage.http[0]!;
          key = 'responses';
          break;

        case 'statuses':
          target = usage.http[0]!;
          key = 'statuses';
          break;

        case 'status bucket':
          target = usage.http[0]!.statuses;
          key = '2xx';
          break;
      }

      Object.defineProperty(target, key, {
        get: getter,
      });

      expect(() => projectDaemonSnapshotStatusOutput(input))
        .toThrow('Invalid daemon snapshot status output.');

      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(['logical', 'http'] as const)(
    'rejects sparse RPC %s arrays',
    (kind) => {
      const input = statusWithRpcUsage();

      Reflect.deleteProperty(input.observation.rpcUsage[kind], '0');

      expect(() => projectDaemonSnapshotStatusOutput(input))
        .toThrow('Invalid daemon snapshot status output.');
    },
  );

  it('rejects inherited required RPC fields', () => {
    const input = statusWithRpcUsage();
    const row = input.observation.rpcUsage.logical[0]!;

    Object.setPrototypeOf(row, {
      completed: row.completed,
    });
    Reflect.deleteProperty(row, 'completed');

    expect(() => projectDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid daemon snapshot status output.');
  });

  it('passes RPC counter consistency through shared validation', () => {
    const input = statusWithRpcUsage();
    input.observation.rpcUsage.http[0]!.responses = 6;

    expect(() => projectDaemonSnapshotStatusOutput(input))
      .toThrow('Invalid RPC usage snapshot.');
  });

  it('rejects null RPC usage', () => {
    const input = status();

    expect(() => projectDaemonSnapshotStatusOutput({
      ...input,
      observation: {
        ...input.observation,
        rpcUsage: null,
      },
    })).toThrow('Invalid daemon snapshot status output.');
  });
});

describe('daemon snapshot RPC usage rendering', () => {
  it('reports absent RPC usage without inventing measurements', () => {
    const output = renderDaemonSnapshotStatusOutput(status());

    expect(output).toContain('RPC usage: not reported');
    expect(output).not.toContain('RPC collector ID:');
    expect(output).not.toContain('Logical RPC rows:');
  });

  it('renders cumulative counters and completion-based averages', () => {
    const input = statusWithRpcUsage();

    // RPC measurement time remains distinct from status publication time.
    input.observation.rpcUsage.observedAt = EARLIER;

    const output = renderDaemonSnapshotStatusOutput(input);

    expect(output).toContain('Observed at: ' + AT);
    expect(output).toContain('RPC usage observed at: ' + EARLIER);
    expect(output).toContain('RPC collector started at: ' + EARLIER);
    expect(output).toContain(
      'RPC collector ID: 33333333-3333-4333-8333-333333333333',
    );

    expect(output).toContain([
      'Logical RPC rows: 1',
      '  Logical RPC: public / eth_call',
      '    Started: 4',
      '    Completed: 3',
      '    Failed: 1',
      '    In flight: 1',
      '    Total duration (ms): 12.75',
      '    Average duration (ms): 4.25',
    ].join('\n'));

    expect(output).toContain([
      'HTTP RPC rows: 1',
      '  HTTP RPC: public',
      '    Started: 5',
      '    Responses: 3',
      '    Transport failures: 1',
      '    In flight: 1',
      '    Status 2xx: 1',
      '    Status 3xx: 0',
      '    Status 4xx: 0',
      '    Status 5xx: 1',
      '    Total duration (ms): 10.5',
      '    Average duration (ms): 2.625',
    ].join('\n'));

    expect(output).toContain('RPC scope: JSON-RPC only');
    expect(output).toContain(
      'Counts: logical calls and HTTP requests are independent',
    );
    expect(output).toContain(
      'Durations: logical completion or HTTP headers/rejection',
    );
    expect(output).toContain(
      'Current signing authorization: unknown',
    );
  });

  it('renders unavailable averages for pending-only work', () => {
    const input = statusWithRpcUsage();

    Object.assign(input.observation.rpcUsage.logical[0]!, {
      completed: 0,
      failed: 0,
      inFlight: 4,
      durationMs: 0,
    });

    Object.assign(input.observation.rpcUsage.http[0]!, {
      responses: 0,
      transportFailures: 0,
      inFlight: 5,
      durationMs: 0,
      statuses: {
        '2xx': 0,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      },
    });

    const output = renderDaemonSnapshotStatusOutput(input);
    const unavailable = output.split('\n').filter((line) => (
      line === '    Average duration (ms): unavailable (no completions)'
    ));

    expect(unavailable).toHaveLength(2);
    expect(output).not.toContain('NaN');
    expect(output).not.toContain('Infinity');
  });

  it('renders measured zero-duration averages as zero', () => {
    const input = statusWithRpcUsage();

    input.observation.rpcUsage.logical[0]!.durationMs = 0;
    input.observation.rpcUsage.http[0]!.durationMs = 0;

    const output = renderDaemonSnapshotStatusOutput(input);
    const averages = output.split('\n').filter((line) => (
      line === '    Average duration (ms): 0'
    ));

    expect(averages).toHaveLength(2);
  });

  it('distinguishes an empty collector from unreported usage', () => {
    const input = statusWithRpcUsage();

    input.observation.rpcUsage.logical = [];
    input.observation.rpcUsage.http = [];

    const output = renderDaemonSnapshotStatusOutput(input);

    expect(output).toContain('RPC usage: cumulative');
    expect(output).toContain('Logical RPC rows: 0');
    expect(output).toContain('HTTP RPC rows: 0');
    expect(output).not.toContain('RPC usage: not reported');
    expect(output).not.toContain('Average duration (ms):');
  });
});