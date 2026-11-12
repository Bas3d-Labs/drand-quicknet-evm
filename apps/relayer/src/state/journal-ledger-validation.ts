import type {
  Hash,
} from 'viem';

import {
  MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
} from './journal-bounds.js';

import {
  blockAnchorsMatch,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  isWorkId,
} from '../execution/work-identity.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

import {
  MAX_OPERATOR_OUTCOMES,
  MAX_OPERATOR_OUTCOME_BYTES,
  type AnchoredNonceObservation,
  type JournalLedger,
  type OperatorAttributedOutcome,
} from './transaction-journal.js';

const OUTCOME_KEYS = [
  'kind',
  'requestId',
  'snapshotDigest',
  'proposalDigest',
  'operator',
  'at',
  'attemptId',
  'workId',
  'nonce',
  'candidateHashes',
  'durable',
  'finality',
  'lowerBound',
  'replacement',
  'priorSearch',
] as const;

export function journalJson(
  value: unknown,
): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') {
      return item.toString();
    }

    return item;
  });
}

export function readLedger(
  input: unknown,
  durableNextNonce: bigint,
  baselineNonce: bigint,
): JournalLedger {
  const value = fields(input, ['outcomes', 'obligations']);

  valid(Array.isArray(value.outcomes));
  valid(value.outcomes.length <= MAX_OPERATOR_OUTCOMES);

  valid(Array.isArray(value.obligations));
  valid(value.obligations.length === 0);

  const outcomes = Array.from(value.outcomes, readOperatorOutcome);

  const requests = new Set<string>();

  const attempts = new Set<string>();

  const nonces = new Set<bigint>();

  let previousNonce: bigint | undefined;

  for (const outcome of outcomes) {
    valid(outcome.nonce >= baselineNonce);
    valid(outcome.nonce < durableNextNonce);
    valid(previousNonce === undefined || outcome.nonce > previousNonce);

    valid(!requests.has(outcome.requestId));
    valid(!attempts.has(outcome.attemptId));
    valid(!nonces.has(outcome.nonce));

    requests.add(outcome.requestId);
    attempts.add(outcome.attemptId);
    nonces.add(outcome.nonce);

    previousNonce = outcome.nonce;
  }

  return Object.freeze({
    outcomes: Object.freeze(outcomes),
    obligations: Object.freeze([] as const),
  });
}

export function readOperatorOutcome(
  input: unknown,
): OperatorAttributedOutcome {
  const value = fields(input, OUTCOME_KEYS);

  valid(value.kind === 'operator-attributed');

  const metadata = readAttributionMetadata({
    requestId: value.requestId,
    operator: value.operator,
    at: value.at,
    finality: value.finality,
  });

  valid(isUuidV4(value.attemptId));
  valid(value.attemptId === value.attemptId.toLowerCase());

  valid(isWorkId(value.workId));

  const nonce = uint(value.nonce);

  const durable = observation(value.durable);

  const lowerBound = observation(value.lowerBound);

  const replacement = fields(value.replacement, ['transactionHash', 'inclusion']);

  const inclusion = anchor(replacement.inclusion);

  const transactionHash = hash(replacement.transactionHash);

  valid(Array.isArray(value.candidateHashes));
  valid(value.candidateHashes.length >= 1);
  valid(value.candidateHashes.length <= MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT);

  const candidateHashes = Array.from(value.candidateHashes, hash);

  valid(new Set(candidateHashes).size === candidateHashes.length);
  valid(!candidateHashes.includes(transactionHash));

  valid(durable.nonce > nonce);
  valid(lowerBound.nonce <= nonce);

  valid(lowerBound.anchor.blockNumber < inclusion.blockNumber);
  valid(inclusion.blockNumber <= durable.anchor.blockNumber);

  const finality = metadata.finality;

  const prior = fields(value.priorSearch, ['searchedThrough', 'exhausted']);

  let searchedThrough: Readonly<BlockAnchor> | null = null;

  let exhausted: AnchoredNonceObservation | null = null;

  if (prior.searchedThrough !== null) {
    searchedThrough = anchor(prior.searchedThrough);

    valid(searchedThrough.blockNumber > lowerBound.anchor.blockNumber);
    valid(searchedThrough.blockNumber <= durable.anchor.blockNumber);
  }

  if (prior.exhausted !== null) {
    exhausted = observation(prior.exhausted);

    valid(exhausted.anchor.blockNumber > lowerBound.anchor.blockNumber);
    valid(exhausted.anchor.blockNumber <= durable.anchor.blockNumber);

    valid(exhausted.nonce > nonce);
    valid(durable.nonce >= exhausted.nonce);

    if (exhausted.anchor.blockNumber === durable.anchor.blockNumber) {
      valid(exhausted.nonce === durable.nonce);
    }
  }

  const anchors = [lowerBound.anchor, inclusion, durable.anchor];

  if (searchedThrough !== null) {
    anchors.push(searchedThrough);
  }

  if (exhausted !== null) {
    anchors.push(exhausted.anchor);
  }

  const seen = new Map<bigint, Readonly<BlockAnchor>>();

  for (const current of anchors) {
    const previous = seen.get(current.blockNumber);

    valid(previous === undefined || blockAnchorsMatch(previous, current));

    seen.set(current.blockNumber, current);
  }

  const result: OperatorAttributedOutcome = Object.freeze({
    kind: 'operator-attributed',
    requestId: metadata.requestId,
    snapshotDigest: hash(value.snapshotDigest),
    proposalDigest: hash(value.proposalDigest),
    operator: metadata.operator,
    at: metadata.at,
    attemptId: value.attemptId,
    workId: value.workId,
    nonce,
    candidateHashes: Object.freeze(candidateHashes),
    durable,
    finality,
    lowerBound,
    replacement: Object.freeze({
      transactionHash,
      inclusion,
    }),
    priorSearch: Object.freeze({
      searchedThrough,
      exhausted,
    }),
  });

  valid(Buffer.byteLength(journalJson(result), 'utf8') <= MAX_OPERATOR_OUTCOME_BYTES);

  return result;
}

/** Decode numeric fields without dropping unknown keys before validation. */
export function decodeLedger(
  input: unknown,
): unknown {
  const value = fields(input, ['outcomes', 'obligations']);

  valid(Array.isArray(value.outcomes));
  valid(value.outcomes.length <= MAX_OPERATOR_OUTCOMES);

  return {
    ...value,
    outcomes: Array.from(value.outcomes, decodeOutcome),
  };
}

function decodeOutcome(
  item: unknown,
) {
  const row = fields(item, OUTCOME_KEYS);

  const replacement = fields(row.replacement, ['transactionHash', 'inclusion']);

  const prior = fields(row.priorSearch, ['searchedThrough', 'exhausted']);

  const policy = fields(row.finality);

  let finality = policy;

  let searchedThrough: unknown = null;

  let exhausted: unknown = null;

  if (policy.type === 'confirmations') {
    finality = {
      ...policy,
      confirmations: decimal(policy.confirmations),
    };
  }

  if (prior.searchedThrough !== null) {
    searchedThrough = decodeAnchor(prior.searchedThrough);
  }

  if (prior.exhausted !== null) {
    exhausted = decodeObservation(prior.exhausted);
  }

  return {
    ...row,
    nonce: decimal(row.nonce),
    durable: decodeObservation(row.durable),
    finality,
    lowerBound: decodeObservation(row.lowerBound),
    replacement: {
      ...replacement,
      inclusion: decodeAnchor(replacement.inclusion),
    },
    priorSearch: {
      searchedThrough,
      exhausted,
    },
  };
}

export function readAttributionMetadata(
  input: unknown,
): Pick<OperatorAttributedOutcome, 'requestId' | 'operator' | 'at' | 'finality'> {
  const value = fields(input, ['requestId', 'operator', 'at', 'finality']);

  valid(isUuidV4(value.requestId));
  valid(value.requestId === value.requestId.toLowerCase());

  valid(isWorkId(value.operator));
  valid(Buffer.byteLength(value.operator, 'utf8') <= 128);

  valid(typeof value.at === 'string' && value.at.length === 24);
  valid(Number.isFinite(Date.parse(value.at)));
  valid(new Date(value.at).toISOString() === value.at);

  const policy = fields(value.finality);

  let finality: OperatorAttributedOutcome['finality'];

  if (policy.type === 'confirmations') {
    fields(policy, ['type', 'confirmations']);

    finality = Object.freeze({
      type: 'confirmations',
      confirmations: uint(policy.confirmations),
    });
  } else {
    fields(policy, ['type']);
    valid(policy.type === 'safe' || policy.type === 'finalized');

    finality = Object.freeze({
      type: policy.type,
    });
  }

  return Object.freeze({
    requestId: value.requestId,
    operator: value.operator,
    at: value.at,
    finality,
  });
}

function fields(
  input: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  valid(typeof input === 'object' && input !== null && !Array.isArray(input));

  const result: Record<string, unknown> = {};

  try {
    const ownKeys = Reflect.ownKeys(input);

    if (keys !== undefined) {
      valid(ownKeys.length === keys.length);
      valid(keys.every((key) => ownKeys.includes(key)));
    }

    for (const key of ownKeys) {
      valid(typeof key === 'string');

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      valid(descriptor !== undefined && Object.hasOwn(descriptor, 'value'));
      Object.defineProperty(result, key, {
        value: descriptor.value,
        enumerable: true,
      });
    }
  } catch {
    throw new TypeError('Invalid transaction journal ledger.');
  }

  return result;
}

function hash(
  input: unknown,
): Hash {
  valid(isFixedHex(input, 32));
  valid(input === input.toLowerCase());

  return input as Hash;
}

function uint(
  input: unknown,
): bigint {
  valid(typeof input === 'bigint' && input >= 0n && input <= MAX_UINT256);

  return input;
}

function decimal(
  input: unknown,
): bigint {
  valid(typeof input === 'string' && input.length > 0 && input.length <= 78);
  valid(isDecimalInteger(input));
  valid(input === '0' || !input.startsWith('0'));

  return uint(BigInt(input));
}

function anchor(
  input: unknown,
): Readonly<BlockAnchor> {
  const value = fields(input, ['blockNumber', 'blockHash']);

  return Object.freeze({
    blockNumber: uint(value.blockNumber),
    blockHash: hash(value.blockHash),
  });
}

function observation(
  input: unknown,
): AnchoredNonceObservation {
  const value = fields(input, ['anchor', 'nonce']);

  return Object.freeze({
    anchor: anchor(value.anchor),
    nonce: uint(value.nonce),
  });
}

function decodeAnchor(
  input: unknown,
) {
  const value = fields(input, ['blockNumber', 'blockHash']);

  return {
    ...value,
    blockNumber: decimal(value.blockNumber),
  };
}

function decodeObservation(
  input: unknown,
) {
  const value = fields(input, ['anchor', 'nonce']);

  return {
    ...value,
    anchor: decodeAnchor(value.anchor),
    nonce: decimal(value.nonce),
  };
}

function valid(
  condition: unknown,
): asserts condition {
  if (!condition) {
    throw new TypeError('Invalid transaction journal ledger.');
  }
}
