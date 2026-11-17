import {
  MAX_WAITING_ROUNDS,
} from '../daemon/future-round-scheduler.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isNonNegativeSafeInteger,
} from '../shared/integer.js';

import {
  MAX_UINT64,
  MAX_UINT256,
} from '../shared/uint.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

import type {
  StoredFactNonceConflict,
} from './stored-fact-nonce-conflict.js';

import {
  MAX_OPERATOR_OUTCOMES,
} from './transaction-journal.js';

export interface OperatorHistoryObservation {
  readonly count: number;
  readonly limit: number;
}

export interface QueueObservation {
  readonly queuedCount: number;
  readonly dueCount: number;
  readonly limit: number;
  readonly rejectedOffers: string;
}

interface DisputedFact {
  readonly attemptId: string;
  readonly kind: 'lowerBound' | 'exhausted';
  readonly source: 'candidate' | 'retained';
  readonly nonce: string;
}

export interface StoredFactDisputeObservation {
  readonly observedAt: string;
  readonly origin: 'recovery' | 'preparation';
  readonly detail: {
    readonly reason: 'stored-fact-nonce-conflict';
    readonly anchor: {
      readonly blockNumber: string;
      readonly blockHash: string;
    };
    readonly first: DisputedFact;
    readonly second: DisputedFact;
  };
}

const INVALID = 'Invalid status observation.';

/** Reads data properties only; inherited fields and getters are not observations. */
export function statusField(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(INVALID);
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);

  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(INVALID);
  }

  return descriptor.value;
}

export function readOperatorHistory(input: unknown): OperatorHistoryObservation | null {
  if (input === null) {
    return null;
  }

  const count = statusField(input, 'count');

  const limit = statusField(input, 'limit');

  if (
    !isNonNegativeSafeInteger(count) ||
    limit !== MAX_OPERATOR_OUTCOMES ||
    count > limit
  ) {
    throw new TypeError(INVALID);
  }

  return Object.freeze({
    count,
    limit,
  });
}

export function readQueueObservation(input: unknown): QueueObservation | null {
  if (input === null) {
    return null;
  }

  const queuedCount = statusField(input, 'queuedCount');

  const dueCount = statusField(input, 'dueCount');

  const limit = statusField(input, 'limit');

  const rejectedOffers = readStatusDecimal(
    statusField(input, 'rejectedOffers'),
    MAX_UINT64,
  );

  if (
    !isNonNegativeSafeInteger(queuedCount) ||
    !isNonNegativeSafeInteger(dueCount) ||
    limit !== MAX_WAITING_ROUNDS ||
    dueCount > queuedCount ||
    queuedCount > limit
  ) {
    throw new TypeError(INVALID);
  }

  return Object.freeze({
    queuedCount,
    dueCount,
    limit,
    rejectedOffers,
  });
}

export function readStatusDecimal(input: unknown, maximum = MAX_UINT256): string {
  if (
    typeof input !== 'string' ||
    input.length > maximum.toString().length ||
    !isDecimalInteger(input) ||
    (input.length > 1 && input[0] === '0') ||
    BigInt(input) > maximum
  ) {
    throw new TypeError(INVALID);
  }

  return input;
}

export function readStoredFactDispute(input: unknown): StoredFactDisputeObservation | null {
  if (input === null) {
    return null;
  }

  const observedAt = statusField(input, 'observedAt');

  const origin = statusField(input, 'origin');

  if (
    typeof observedAt !== 'string' ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt ||
    (origin !== 'recovery' && origin !== 'preparation')
  ) {
    throw new TypeError(INVALID);
  }

  const detail = statusField(input, 'detail');

  const anchor = statusField(detail, 'anchor');

  const blockNumber = readStatusDecimal(statusField(anchor, 'blockNumber'));

  const blockHash = statusField(anchor, 'blockHash');

  const first = readFact(statusField(detail, 'first'));

  const second = readFact(statusField(detail, 'second'));

  if (
    statusField(detail, 'reason') !== 'stored-fact-nonce-conflict' ||
    !isFixedHex(blockHash, 32) ||
    first.nonce === second.nonce ||
    first.attemptId === second.attemptId
  ) {
    throw new TypeError(INVALID);
  }

  return Object.freeze({
    observedAt,
    origin,
    detail: Object.freeze({
      reason: 'stored-fact-nonce-conflict',
      anchor: Object.freeze({
        blockNumber,
        blockHash,
      }),
      first,
      second,
    }),
  });
}

function readFact(input: unknown): DisputedFact {
  const attemptId = statusField(input, 'attemptId');

  const kind = statusField(input, 'kind');

  const source = statusField(input, 'source');

  const nonce = readStatusDecimal(statusField(input, 'nonce'));

  if (
    !isUuidV4(attemptId) ||
    (kind !== 'lowerBound' && kind !== 'exhausted') ||
    (source !== 'candidate' && source !== 'retained')
  ) {
    throw new TypeError(INVALID);
  }

  return Object.freeze({
    attemptId,
    kind,
    source,
    nonce,
  });
}

export function observeStoredFactDispute(
  detail: StoredFactNonceConflict,
  origin: StoredFactDisputeObservation['origin'],
  observedAt: string,
): StoredFactDisputeObservation {
  // The producer is typed, but copy only the allowlisted public diagnostic fields.
  return readStoredFactDispute({
    observedAt,
    origin,
    detail: {
      reason: detail.reason,
      anchor: {
        blockNumber: detail.anchor.blockNumber.toString(),
        blockHash: detail.anchor.blockHash,
      },
      first: {
        ...detail.first,
        nonce: detail.first.nonce.toString(),
      },
      second: {
        ...detail.second,
        nonce: detail.second.nonce.toString(),
      },
    },
  })!;
}
