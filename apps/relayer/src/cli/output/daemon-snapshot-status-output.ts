import type {
  RpcUsageSnapshot,
} from '../../diagnostics/rpc/rpc-usage-snapshot.js';

import {
  isFixedHex,
} from '../../shared/hex.js';

import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from '../../shared/integer.js';

import {
  readDaemonStatusSnapshot,
  type SnapshotAge,
} from '../../state/daemon-status-snapshot.js';

const INVALID = 'Invalid daemon snapshot status output.';

type DaemonSnapshotStatusProjection =
  | {
      source: 'daemon-snapshot';
      gate: 'unknown';
      snapshot: 'missing';
    }
  | {
      source: 'daemon-snapshot';
      gate: 'unknown';
      snapshot: 'present';
      age: SnapshotAge;
      observation: ReturnType<typeof readDaemonStatusSnapshot>;
    };

export function projectDaemonSnapshotStatusOutput(
  input: unknown,
): DaemonSnapshotStatusProjection {
  if (
    own(input, 'source') !== 'daemon-snapshot' ||
    own(input, 'gate') !== 'unknown'
  ) {
    throw new TypeError(INVALID);
  }

  const state = own(input, 'snapshot');

  if (state === 'missing') {
    return {
      source: 'daemon-snapshot',
      gate: 'unknown',
      snapshot: 'missing',
    };
  }

  if (state !== 'present') {
    throw new TypeError(INVALID);
  }

  const age = readAge(own(input, 'age'));
  const raw = own(input, 'observation');
  const identity = fields(own(raw, 'identity'), [
    'chainId',
    'signer',
  ]);

  const chainId = identity.chainId;
  const signer = identity.signer;

  if (
    !isPositiveSafeInteger(chainId) ||
    !isFixedHex(signer, 20)
  ) {
    throw new TypeError(INVALID);
  }

  const rpcFields = projectOptionalRpcUsage(raw);

  // Copy only declared data properties before calling the shared validator.
  const observation = readDaemonStatusSnapshot({
    ...fields(raw, [
      'version',
      'runId',
      'observedAt',
      'journalInitialized',
    ]),
    identity,
    lastObservedGate: {
      ...fields(own(raw, 'lastObservedGate'), [
        'open',
        'primaryReason',
        'recoveryComplete',
        'inclusionChecksComplete',
        'persistenceState',
        'blockedSince',
      ]),
      blockers: elements(
        own(own(raw, 'lastObservedGate'), 'blockers'),
      ),
    },
    attempts: elements(own(raw, 'attempts')).map((attempt) => ({
      ...fields(attempt, ['attemptId', 'workId', 'nonce', 'phase']),
      transactionHashes: elements(own(attempt, 'transactionHashes')),
    })),
    lastCompletedCycle: nullableFields(
      own(raw, 'lastCompletedCycle'),
      ['cycle', 'completedAt'],
    ),
    lastRetryObservation: nullableFields(
      own(raw, 'lastRetryObservation'),
      ['observedAt', 'retryDelayMs'],
    ),
    ...rpcFields,
  }, { chainId, signer });

  return {
    source: 'daemon-snapshot',
    gate: 'unknown',
    snapshot: 'present',
    age,
    observation,
  };
}

/**
 * Renders historical daemon observations.
 */
export function renderDaemonSnapshotStatusOutput(
  input: unknown,
): string {
  const projection = projectDaemonSnapshotStatusOutput(input);

  const lines = [
    'Status source: daemon snapshot',
    'Current signing authorization: unknown',
  ];

  if (projection.snapshot === 'missing') {
    return [
      ...lines,
      'Snapshot: missing',
      'No daemon observation is available.',
    ].join('\n');
  }

  const { age, observation } = projection;

  lines.push(
    'Snapshot: present',
    'Chain ID: ' + observation.identity.chainId,
    'Signer: ' + observation.identity.signer,
    'Run ID: ' + observation.runId,
    'Observed at: ' + observation.observedAt,
    'Snapshot age classification: ' + age.status,
  );

  if (age.status === 'clock-skew') {
    lines.push('Snapshot age (ms): unavailable. Observation is in the future');
  } else {
    lines.push('Snapshot age (ms): ' + age.ageMs);
  }

  const gate = observation.lastObservedGate;

  lines.push(
    'Last observed journal initialized: ' + observation.journalInitialized,
    'Last observed gate: ' + (gate.open ? 'open' : 'closed'),
    'Last observed primary blocker: ' + (gate.primaryReason ?? 'none reported'),
    'Last observed blockers: ' + (
      gate.blockers.length === 0
        ? 'none reported'
        : gate.blockers.join(', ')
    ),
    'Last observed recovery complete: ' + gate.recoveryComplete,
    'Last observed inclusion checks complete: ' + gate.inclusionChecksComplete,
    'Last observed persistence state: ' + gate.persistenceState,
    'Coordinator-reported blocking episode start: ' + (
      gate.blockedSince ?? 'not reported'
    ),
  );

  if (!gate.open && gate.blockers.length === 0) {
    lines.push(
      'The gate was closed without a reported blocker. Its cause is unknown.',
    );
  }

  lines.push('Last observed retained attempts: ' + observation.attempts.length);

  for (const attempt of observation.attempts) {
    lines.push(
      '  Attempt: ' + attempt.attemptId,
      '    Work identity: ' + attempt.workId,
      '    Nonce: ' + attempt.nonce,
      '    Phase: ' + attempt.phase,
      '    Candidate transaction hashes:',
      ...attempt.transactionHashes.map((hash) => '      ' + hash),
    );
  }

  const cycle = observation.lastCompletedCycle;

  if (cycle === null) {
    lines.push('Last completed cycle: not observed');
  } else {
    lines.push(
      'Last completed cycle: ' + cycle.cycle,
      'Cycle completed at: ' + cycle.completedAt,
      'Cycle completion does not imply every consumer succeeded.',
    );
  }

  const retry = observation.lastRetryObservation;

  if (retry === null) {
    lines.push('Last retry observation: unavailable');
  } else {
    lines.push(
      'Retry observed at: ' + retry.observedAt,
      'Historical retry delay (ms): ' + (
        retry.retryDelayMs === null
          ? 'none reported'
          : retry.retryDelayMs
      ),
      'The retry delay is historical, not a countdown or permission to send.',
    );
  }

  lines.push(...renderRpcUsage(observation.rpcUsage));

  lines.push(
    'A fresh snapshot does not authorize signing or establish daemon health.',
  )

  return lines.join('\n');
}

function readAge(input: unknown): SnapshotAge {
  const status = own(input, 'status');
  const ageMs = own(input, 'ageMs');

  if (status === 'clock-skew' && ageMs === null) {
    return { status, ageMs };
  }

  if (
    (status === 'fresh' || status === 'stale') &&
    isNonNegativeSafeInteger(ageMs)
  ) {
    return { status, ageMs };
  }

  throw new TypeError(INVALID);
}

function projectOptionalRpcUsage(
  input: unknown,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(INVALID);
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, 'rpcUsage');
  if (descriptor === undefined) {
    return {};
  }

  if (!Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(INVALID);
  }

  const usage: unknown = descriptor.value;
  if (usage === undefined) {
    return {};
  }

  return {
    rpcUsage: {
      ...fields(usage, [
        'collectorId',
        'startedAt',
        'observedAt',
      ]),
      logical: elements(own(usage, 'logical')).map((row) => (
        fields(row, [
          'client',
          'method',
          'started',
          'completed',
          'failed',
          'inFlight',
          'durationMs',
        ])
      )),
      http: elements(own(usage, 'http')).map((row) => ({
        ...fields(row, [
          'client',
          'started',
          'responses',
          'transportFailures',
          'inFlight',
          'durationMs',
        ]),
        statuses: fields(own(row, 'statuses'), [
          '2xx',
          '3xx',
          '4xx',
          '5xx',
        ]),
      })),
    },
  };
}

function renderAverageDuration(
  durationMs: number,
  completed: number,
): string {
  if (completed === 0) {
    return 'unavailable (no completions)';
  }

  return String(durationMs / completed);
}

function renderRpcUsage(
  usage: RpcUsageSnapshot | undefined,
): string[] {
  if (usage === undefined) {
    return ['RPC usage: not reported'];
  }

  const lines = [
    'RPC usage: cumulative',
    'RPC collector ID: ' + usage.collectorId,
    'RPC collector started at: ' + usage.startedAt,
    'RPC usage observed at: ' + usage.observedAt,
    'RPC scope: JSON-RPC only',
    'Counts: logical calls and HTTP requests are independent',
    'Durations: logical completion or HTTP headers/rejection',
    'Logical RPC rows: ' + usage.logical.length,
  ];

  for (const row of usage.logical) {
    lines.push(
      '  Logical RPC: ' + row.client + ' / ' + row.method,
      '    Started: ' + row.started,
      '    Completed: ' + row.completed,
      '    Failed: ' + row.failed,
      '    In flight: ' + row.inFlight,
      '    Total duration (ms): ' + row.durationMs,
      '    Average duration (ms): ' + renderAverageDuration(
        row.durationMs,
        row.completed,
      ),
    );
  }

  lines.push('HTTP RPC rows: ' + usage.http.length);

  for (const row of usage.http) {
    lines.push(
      '  HTTP RPC: ' + row.client,
      '    Started: ' + row.started,
      '    Responses: ' + row.responses,
      '    Transport failures: ' + row.transportFailures,
      '    In flight: ' + row.inFlight,
      '    Status 2xx: ' + row.statuses['2xx'],
      '    Status 3xx: ' + row.statuses['3xx'],
      '    Status 4xx: ' + row.statuses['4xx'],
      '    Status 5xx: ' + row.statuses['5xx'],
      '    Total duration (ms): ' + row.durationMs,
      '    Average duration (ms): ' + renderAverageDuration(
        row.durationMs,
        row.responses + row.transportFailures,
      ),
    );
  }

  return lines;
}

function own(
  input: unknown,
  key: string,
): unknown {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(INVALID);
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);

  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw new TypeError(INVALID);
  }

  return descriptor.value;
}

function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of keys) {
    result[key] = own(input, key);
  }

  return result;
}

function nullableFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  return input === null ? null : fields(input, keys);
}

function elements(input: unknown): unknown[] {
  if (!Array.isArray(input)) {
    throw new TypeError(INVALID);
  }

  const result: unknown[] = [];

  for (let index = 0; index < input.length; index += 1) {
    result.push(own(input, String(index)));
  }

  return result;
}
