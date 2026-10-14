import {
  isFixedHex,
} from '../shared/hex.js';

import {
  readDaemonStatusSnapshot,
  type SnapshotAge,
} from '../state/daemon-status-snapshot.js';

const INVALID = 'Invalid daemon snapshot status output.';

/**
 * Renders historical daemon observations.
 */
export function renderDaemonSnapshotStatusOutput(
  input: unknown,
): string {
  if (
    own(input, 'source') !== 'daemon-snapshot' ||
    own(input, 'gate') !== 'unknown'
  ) {
    throw new TypeError(INVALID);
  }

  const state = own(input, 'snapshot');

  const lines = [
    'Status source: daemon snapshot',
    'Current signing authorization: unknown',
  ];

  if (state === 'missing') {
    return [
      ...lines,
      'Snapshot: missing',
      'No daemon observation is available.',
    ].join('\n');
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
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !isFixedHex(signer, 20)
  ) {
    throw new TypeError(INVALID);
  }

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
  }, { chainId, signer });

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
    typeof ageMs === 'number' &&
    Number.isSafeInteger(ageMs) &&
    ageMs >= 0
  ) {
    return { status, ageMs };
  }

  throw new TypeError(INVALID);
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
