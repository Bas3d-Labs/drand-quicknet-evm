import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

const INVALID = 'Invalid journal status output.';

/**
 * Validates and renders the public journal projection.
 * Never serializes the supplied object or its undeclared finish.
 */
export function renderJournalStatusOutput(
  input: unknown,
): string {
  if (
    own(input, 'source') !== 'journal' ||
    own(input, 'gate') !== 'unknown' 
  ) {
    throw new TypeError(INVALID);
  }

  const journal = own(input, 'journal');

  const lines = [
    'Status source: journal',
    'Current signing authorization: unknown',
  ];

  if (journal === 'missing') {
    return [
      ...lines,
      'Journal: missing',
      'A missing journal does not establish signer readiness.',
    ].join('\n');
  }

  if (journal !== 'present') {
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

  lines.push(
    'Journal: present',
    'Chain ID: ' + chainId,
    'Signer: ' + hex(own(identity, 'signer'), 20),
    'Next nonce: ' + decimal(own(input, 'nextNonce')),
    'Durable next nonce: ' + decimal(own(input, 'durableNextNonce')),
    ...observationLines('Baseline', own(input, 'baseline')),
    ...observationLines(
      'Last accepted observation',
      own(input, 'lastObservation'),
    ),
  );

  const attempts = array(own(input, 'attempts'));
  lines.push('Retained attempts: ' + attempts.length);

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = own(attempts, String(index));
    const attemptId = own(attempt, 'attemptId');
    const phase = own(attempt, 'phase');

    if (
      !isUuidV4(attemptId) ||
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

    lines.push(
      '  Attempt: ' + attemptId,
      '    Nonce: ' + decimal(own(attempt, 'nonce')),
      '    Created at: ' + timestamp(own(attempt, 'createdAt')),
      '    Phase: ' + phase,
      '    Candidate transaction hashes:',
    );

    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      lines.push(
        '      ' + hex(own(hashes, String(hashIndex)), 32),
      );
    }
  }

  const repairs = array(own(input, 'repairs'));
  lines.push('Retained nonce repairs: ' + repairs.length);

  for (let index = 0; index < repairs.length; index += 1) {
    const repair = own(repairs, String(index));

    if (own(repair, 'kind') !== 'sync-nonce') {
      throw new TypeError(INVALID);
    }

    const previous = decimal(own(repair, 'previousNextNonce'));
    const next = decimal(own(repair, 'nextNonce'));
    const observation = own(repair, 'observation');

    if (
      BigInt(next) <= BigInt(previous) ||
      decimal(own(observation, 'nonce')) !== next
    ) {
      throw new TypeError(INVALID);
    }

    lines.push(
      '  Repair: sync-nonce',
      '    Recorded at: ' + timestamp(own(repair, 'at')),
      '    Previous next nonce: ' + previous,
      '    Next nonce: ' + next,
      ...observationLines('Accepted observation', observation)
        .map((line) => '    ' + line),
    );
  }

  lines.push(
    'Journal state does not establish current signing authorization.'
  );

  return lines.join('\n');
}

function observationLines(
  label: string,
  input: unknown,
): string[] {
  const anchor = own(input, 'anchor');

  return [
    label + ' nonce: ' + decimal(own(input, 'nonce')),
    label + ' block: ' + decimal(own(anchor, 'blockNumber')),
    label + ' block hash: ' + hex(own(anchor, 'blockHash'), 32),
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
  if (
    typeof input !== 'string' ||
    input.length > 78 ||
    !/^(0|[1-9][0-9]*)$/.test(input) ||
    BigInt(input) > MAX_UINT256
  ) {
    throw new TypeError(INVALID);
  }

  return input;
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