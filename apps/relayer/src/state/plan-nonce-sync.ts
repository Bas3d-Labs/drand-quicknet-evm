import {
  MAX_RETAINED_NONCE_REPAIRS,
  type AnchoredNonceObservation,
  type JournalIdentity,
  type JournalNonceRepair,
  type TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface PlanNonceSyncOptions {
  readonly snapshot: TransactionJournalSnapshot;
  readonly identity: JournalIdentity;
  readonly observation: AnchoredNonceObservation;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
  readonly at: string;
}

export type NonceSyncPlan =
  | {
      readonly status: 'already-synchronized';
    }
  | {
      readonly status: 'deferred';
      readonly reason: 'nonce-count-mismatch';
    }
  | {
      readonly status: 'refused';
      readonly reason:
        | 'retained-attempts'
        | 'nonce-regression'
        | 'anchor-regression'
        | 'anchor-conflict';
    }
  | {
      readonly status: 'repair-available';
      readonly repair: JournalNonceRepair;
      readonly snapshot: TransactionJournalSnapshot;
    };

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Plans a forward nonce adoption for a present, empty journal.
 */
export function planNonceSync(
  options: PlanNonceSyncOptions,
): NonceSyncPlan {
  const current = validateJournalSnapshotStructure(
    options.snapshot,
    options.identity,
  );

  // Reuse the existing observation validator through snapshot validator.
  const observation = validateJournalSnapshotStructure({
    ...current,
    lastObservation: options.observation,
  }, options.identity).lastObservation;

  requireNonce(options.latestNonce);
  requireNonce(options.pendingNonce);
  requireTimestamp(options.at);

  if (current.attempts.length !== 0) {
    return Object.freeze({
      status: 'refused',
      reason: 'retained-attempts',
    });
  }

  const previous = current.lastObservation;

  if (observation.anchor.blockNumber < previous.anchor.blockNumber) {
    return Object.freeze({
      status: 'refused',
      reason: 'anchor-regression',
    });
  }

  if (
    observation.anchor.blockNumber === previous.anchor.blockNumber &&
    observation.anchor.blockHash.toLowerCase() !==
      previous.anchor.blockHash.toLowerCase()
  ) {
    return Object.freeze({
      status: 'refused',
      reason: 'anchor-conflict',
    });
  }

  if (
    observation.nonce < current.nextNonce ||
    observation.nonce < previous.nonce
  ) {
    return Object.freeze({
      status: 'refused',
      reason: 'nonce-regression',
    });
  }

  if (
    observation.nonce !== options.latestNonce ||
    observation.nonce !== options.pendingNonce
  ) {
    return Object.freeze({
      status: 'deferred',
      reason: 'nonce-count-mismatch',
    });
  }

  if (observation.nonce === current.nextNonce) {
    return Object.freeze({
      status: 'already-synchronized',
    });
  }

  const repair: JournalNonceRepair = {
    kind: 'sync-nonce',
    at: options.at,
    previousNextNonce: current.nextNonce,
    nextNonce: observation.nonce,
    observation,
  };

  const snapshot = validateJournalSnapshotStructure({
    ...current,
    lastObservation: observation,
    nextNonce: observation.nonce,
    durableNextNonce: observation.nonce,
    repairs: [
      ...current.repairs,
      repair,
    ].slice(-MAX_RETAINED_NONCE_REPAIRS),
  }, options.identity);

  return Object.freeze({
    status: 'repair-available',
    repair: snapshot.repairs[snapshot.repairs.length - 1]!,
    snapshot,
  });
}

function requireNonce(value: unknown): asserts value is bigint {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > MAX_UINT256
  ) {
    throw new TypeError('Invalid nonce sync count.');
  }
}

function requireTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError('Invalid nonce sync timestamp.');
  }

  const timestamp = Date.parse(value);

  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new TypeError('Invalid nonce sync timestamp.');
  }
}