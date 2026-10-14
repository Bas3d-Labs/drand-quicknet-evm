import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

import type {
  JournalIdentity,
} from '../state/transaction-journal.js';

export const DEFAULT_STATUS_MAX_AGE_MS = 120_000;

export interface StatusConfigInput {
  readonly chainId: string;
  readonly signer: string;
  readonly source: string;
  readonly maxAgeMs?: string;
}

export type StatusConfig =
  | {
      readonly identity: JournalIdentity;
      readonly source: 'journal';
    }
  | {
      readonly identity: JournalIdentity;
      readonly source: 'daemon-snapshot';
      readonly maxAgeMs: number;
    };

/**
 * Parses public status configuration without accessing credentials,
 * network services, or state files.
 */
export function parseStatusConfig(
  input: StatusConfigInput,
): StatusConfig {
  const chainId = positiveDecimal(
    input.chainId,
    'Invalid status chain ID.',
  );

  if (!isFixedHex(input.signer, 20)) {
    throw new TypeError('Invalid status signer.');
  }

  const identity = Object.freeze({
    chainId,
    signer: input.signer,
  });

  const source = input.source;

  if (source === 'journal') {
    if (input.maxAgeMs !== undefined) {
      throw new TypeError(
        'Snapshot maximum age is not applicable to journal status.'
      );
    }

    return Object.freeze({
      identity,
      source,
    });
  }

  if (source !== 'daemon-snapshot') {
    throw new TypeError('Invalid status source.');
  }

  const maxAgeMs = input.maxAgeMs === undefined
    ? DEFAULT_STATUS_MAX_AGE_MS
    : positiveDecimal(
        input.maxAgeMs,
        'Invalid daemon snapshot maximum age.',
    );

  return Object.freeze({
    identity,
    source,
    maxAgeMs,
  });
}

function positiveDecimal(
  input: unknown,
  message: string,
): number {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    !isDecimalInteger(input)
  ) {
    throw new TypeError(message);
  }

  const value = Number(input);

  if (!isPositiveSafeInteger(value)) {
    throw new TypeError(message);
  }

  return value;
}