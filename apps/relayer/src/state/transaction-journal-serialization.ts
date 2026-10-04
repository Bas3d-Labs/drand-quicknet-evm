import {
  isDecimalInteger,
} from '../shared/decimal.js';

import type {
  JournalIdentity,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

import {
  verifyJournalSnapshot,
} from './transaction-journal-verification.js';

export const MAX_JOURNAL_BYTES = 1_048_576;

const INVALID_ENCODING = 'Invalid transaction journal encoding.';

/**
 * Produces persistence data containing transaction bytes.
 */
export async function encodeJournalSnapshot(
  input: TransactionJournalSnapshot,
  expectedIdentity: JournalIdentity,
): Promise<string> {
  try {
    const snapshot = validateJournalSnapshotStructure(
      input,
      expectedIdentity,
    );

    if (
      snapshot.attempt !== null &&
      snapshot.attempt.signedTransaction.length > MAX_JOURNAL_BYTES
    ) {
      throw new TypeError(INVALID_ENCODING);
    }

    const contents = JSON.stringify(
      snapshot,
      (_key, value: unknown) => {
        if (typeof value === 'bigint') {
          return value.toString();
        }

        return value;
      },
    ) + '\n';

    requireBoundedContents(contents);

    await verifyJournalSnapshot(snapshot, expectedIdentity);

    return contents;
  } catch {
    throw new TypeError(INVALID_ENCODING);
  }
}

/**
 * Decodes and verifies a snapshot, returning detached, frozen state.
 */
export async function decodeJournalSnapshot(
  contents: string,
  expectedIdentity: JournalIdentity,
): Promise<TransactionJournalSnapshot> {
  try {
    requireBoundedContents(contents);

    const root = object(JSON.parse(contents));

    if (root.version !== 1) {
      throw new TypeError(INVALID_ENCODING);
    }

    const decoded = {
      version: root.version,
      identity: root.identity,
      baseline: decodeObservation(root.baseline),
      lastObservation: decodeObservation(root.lastObservation),
      nextNonce: decimal(root.nextNonce),
      attempt: decodeAttempt(root.attempt),
    };

    return await verifyJournalSnapshot(decoded, expectedIdentity);
  } catch {
    throw new TypeError(INVALID_ENCODING);
  }
}

function decodeObservation(input: unknown) {
  const value = object(input);

  return {
    anchor: decodeAnchor(value.anchor),
    nonce: decimal(value.nonce),
  };
}

function decodeAnchor(input: unknown) {
  const value = object(input);

  return {
    blockNumber: decimal(value.blockNumber),
    blockHash: value.blockHash,
  };
}

function decodeAttempt(input: unknown) {
  if (input === null) {
    return null;
  }

  const value = object(input);

  return {
    attemptId: value.attemptId,
    nonce: decimal(value.nonce),
    transactionHash: value.transactionHash,
    signedTransaction: value.signedTransaction,
    createdAt: value.createdAt,
    phase: value.phase,
    replacementSearch: decodeSearch(value.replacementSearch),
  };
}

function decodeSearch(input: unknown) {
  if (input === null) {
    return null;
  }

  const value = object(input);

  let searchedThrough: ReturnType<typeof decodeAnchor> | null = null;
  
  if (value.searchedThrough !== null) {
    searchedThrough = decodeAnchor(value.searchedThrough);
  }

  return {
    lowerBound: decodeObservation(value.lowerBound),
    searchedThrough,
  };
}

function decimal(input: unknown): bigint {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > 78 ||
    !isDecimalInteger(input) ||
    (input.length > 1 && input.startsWith('0'))
  ) {
    throw new TypeError(INVALID_ENCODING);
  }

  return BigInt(input);
}

function object(input: unknown): Record<string, unknown> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new TypeError(INVALID_ENCODING);
  }

  return input as Record<string, unknown>;
}

function requireBoundedContents(contents: string): void {
  if (
    typeof contents !== 'string' ||
    contents.length === 0 ||
    Buffer.byteLength(contents, 'utf8') > MAX_JOURNAL_BYTES
  ) {
    throw new TypeError(INVALID_ENCODING);
  }
}