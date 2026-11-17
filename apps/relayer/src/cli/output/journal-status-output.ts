import {
  isWorkId,
} from '../../execution/work-identity.js';

import {
  isFixedHex,
} from '../../shared/hex.js';

import {
  MAX_UINT256,
} from '../../shared/uint.js';

import {
  isUuidV4,
} from '../../shared/uuid.js';

import {
  readOperatorHistory,
  readStatusDecimal,
  type OperatorHistoryObservation,
} from '../../state/status-observations.js';

import {
  renderOperatorHistory,
} from './status-observations-output.js';

const INVALID = 'Invalid journal status output.';

interface ObservationProjection {
  nonce: string;
  blockNumber: string;
  blockHash: string;
}

interface AttemptProjection {
  attemptId: string;
  workId: string;
  nonce: string;
  createdAt: string;
  phase: 'signed' | 'broadcast-may-have-occurred' | 'included';
  transactionHashes: string[];
}

interface RepairProjection {
  kind: 'sync-nonce';
  at: string;
  previousNextNonce: string;
  nextNonce: string;
  observation: ObservationProjection;
}

type JournalStatusProjection = {
  operatorHistory: OperatorHistoryObservation | null;
  queue: null;
  storedFactDispute: null;
} & (
  | {
      source: 'journal';
      gate: 'unknown';
      journal: 'missing';
    }
  | {
      source: 'journal';
      gate: 'unknown';
      journal: 'present';
      identity: {
        chainId: number;
        signer: string;
      },
      nextNonce: string;
      durableNextNonce: string;
      baseline: ObservationProjection;
      lastObservation: ObservationProjection;
      attempts: AttemptProjection[];
      repairs: RepairProjection[];
    }
);

/**
 * Copies and validates only declared public journal fields.
 */
export function projectJournalStatusOutput(
  input: unknown,
): JournalStatusProjection {
  if (
    own(input, 'source') !== 'journal' ||
    own(input, 'gate') !== 'unknown' 
  ) {
    throw new TypeError(INVALID);
  }

  const operatorHistory = readOperatorHistory(own(input, 'operatorHistory'));

  if (own(input, 'queue') !== null || own(input, 'storedFactDispute') !== null) {
    throw new TypeError(INVALID);
  }

  const observations = {
    operatorHistory,
    queue: null,
    storedFactDispute: null,
  };

  const journal = own(input, 'journal');

  if (journal === 'missing') {
    if (operatorHistory !== null) {
      throw new TypeError(INVALID);
    }

    return {
      ...observations,
      source: 'journal',
      gate: 'unknown',
      journal: 'missing',
    };
  }

  if (journal !== 'present' || operatorHistory === null) {
    throw new TypeError(INVALID);
  }

  const identity = own(input, 'identity');
  const chainId = own(identity, 'chainId');

  if (
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    throw new TypeError(INVALID);
  }

  const signer = hex(own(identity, 'signer'), 20);
  const nextNonce = decimal(own(input, 'nextNonce'));
  const durableNextNonce = decimal(own(input, 'durableNextNonce'));
  const baseline = projectObservation(own(input, 'baseline'));
  const lastObservation = projectObservation(
    own(input, 'lastObservation'),
  );

  const rawAttempts = array(own(input, 'attempts'));
  const attempts: AttemptProjection[] = [];

  for (let index = 0; index < rawAttempts.length; index += 1) {
    const attempt = own(rawAttempts, String(index));
    const attemptId = own(attempt, 'attemptId');
    const workId = own(attempt, 'workId');
    const phase = own(attempt, 'phase');

    if (
      !isUuidV4(attemptId) ||
      !isWorkId(workId) ||
      (
        phase !== 'signed' &&
        phase !== 'broadcast-may-have-occurred' &&
        phase !== 'included'
      )
    ) {
      throw new TypeError(INVALID);
    }

    const hashes = array(own(attempt, 'transactionHashes'));
    if (hashes.length === 0) {
      throw new TypeError(INVALID);
    }

    const nonce = decimal(own(attempt, 'nonce'));
    const createdAt = timestamp(own(attempt, 'createdAt'));
    const transactionHashes: string[] = [];

    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      transactionHashes.push(
        hex(own(hashes, String(hashIndex)), 32),
      );
    }

    attempts.push({
      attemptId,
      workId,
      nonce,
      createdAt,
      phase,
      transactionHashes,
    });
  }

  const rawRepairs = array(own(input, 'repairs'));
  const repairs: RepairProjection[] = [];

  for (let index = 0; index < rawRepairs.length; index += 1) {
    const repair = own(rawRepairs, String(index));

    if (own(repair, 'kind') !== 'sync-nonce') {
      throw new TypeError(INVALID);
    }

    const previousNextNonce = decimal(
      own(repair, 'previousNextNonce'),
    );
    const nextNonce = decimal(own(repair, 'nextNonce'));
    const observation = own(repair, 'observation');

    if (
      BigInt(nextNonce) <= BigInt(previousNextNonce) ||
      decimal(own(observation, 'nonce')) !== nextNonce
    ) {
      throw new TypeError(INVALID);
    }

    const at = timestamp(own(repair, 'at'));
    const projectedObservation = projectObservation(observation);

    repairs.push({
      kind: 'sync-nonce',
      at,
      previousNextNonce,
      nextNonce,
      observation: projectedObservation,
    });
  }

  return {
    source: 'journal',
    gate: 'unknown',
    journal: 'present',
    ...observations,
    identity: { chainId, signer },
    nextNonce,
    durableNextNonce,
    baseline,
    lastObservation,
    attempts,
    repairs,
  };
}

/**
 * Renders the validated public journal projection.
 */
export function renderJournalStatusOutput(
  input: unknown,
): string {
  const projection = projectJournalStatusOutput(input);

  const lines = [
    'Status source: journal',
    'Current signing authorization: unknown',
    ...renderOperatorHistory(projection.operatorHistory),
    'Queued work: unavailable from journal source',
    'Last observed stored-fact dispute: unavailable from journal source',
  ];

  if (projection.journal === 'missing') {
    return [
      ...lines,
      'Journal: missing',
      'A missing journal does not establish signer readiness.',
    ].join('\n');
  }

  lines.push(
    'Journal: present',
    'Chain ID: ' + projection.identity.chainId,
    'Signer: ' + projection.identity.signer,
    'Next nonce: ' + projection.nextNonce,
    'Durable next nonce: ' + projection.durableNextNonce,
    ...observationLines('Baseline', projection.baseline),
    ...observationLines(
      'Last accepted observation',
      projection.lastObservation,
    ),
    'Retained attempts: ' + projection.attempts.length,
  );
  
  for (const attempt of projection.attempts) {
    lines.push(
      '  Attempt: ' + attempt.attemptId,
      '    Work identity: ' + attempt.workId,
      '    Nonce: ' + attempt.nonce,
      '    Created at: ' + attempt.createdAt,
      '    Phase: ' + attempt.phase,
      '    Candidate transaction hashes:',
    );

    for (const hash of attempt.transactionHashes) {
      lines.push('      ' + hash);
    }
  }

  lines.push('Retained nonce repairs: ' + projection.repairs.length);

  for (const repair of projection.repairs) {
    lines.push(
      '  Repair: sync-nonce',
      '    Recorded at: ' + repair.at,
      '    Previous next nonce: ' + repair.previousNextNonce,
      '    Next nonce: ' + repair.nextNonce,
      ...observationLines(
        'Accepted observation',
        repair.observation,
      ).map((line) => '    ' + line),
    );
  }

  lines.push(
    'Journal state does not establish current signing authorization.'
  );

  return lines.join('\n');
}

function projectObservation(
  input: unknown,
): ObservationProjection {
  const anchor = own(input, 'anchor');

  return {
    nonce: decimal(own(input, 'nonce')),
    blockNumber: decimal(own(anchor, 'blockNumber')),
    blockHash: hex(own(anchor, 'blockHash'), 32),
  };
}

function observationLines(
  label: string,
  observation: ObservationProjection,
): string[] {
  return [
    label + ' nonce: ' + observation.nonce,
    label + ' block: ' + observation.blockNumber,
    label + ' block hash: ' + observation.blockHash,
  ];
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

function array(input: unknown): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new TypeError(INVALID);
  }

  return input;
}

function decimal(input: unknown): string {
  try {
    return readStatusDecimal(input, MAX_UINT256);
  } catch {
    throw new TypeError(INVALID);
  }
}

function hex(
  input: unknown,
  bytes: number,
): string {
  if (!isFixedHex(input, bytes)) {
    throw new TypeError(INVALID);
  }

  return input;
}

function timestamp(input: unknown): string {
  if (typeof input !== 'string') {
    throw new TypeError(INVALID);
  }

  const milliseconds = Date.parse(input);

  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== input
  ) {
    throw new TypeError(INVALID);
  }

  return input;
}
