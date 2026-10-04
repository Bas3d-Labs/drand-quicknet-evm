import type {
  Address,
  Hash,
  Hex,
} from 'viem';

import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  AnchoredNonceObservation,
  JournalAttempt,
  JournalIdentity,
  ReplacementSearch,
  TransactionJournalSnapshot,
} from './transaction-journal.js';
import { isUuidV4 } from '../shared/uuid.js';

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Validates the in-memory snapshot structure and returns a detached,
 * deeply frozen copy containing only declared fields.
 */
export function validateJournalSnapshotStructure(
  input: unknown,
  expectedIdentity: JournalIdentity,
): TransactionJournalSnapshot {
  const expected = readIdentity(expectedIdentity);
  const identity = readIdentity(field(input, 'identity'));

  requireValid(field(input, 'version') === 1);
  requireValid(identity.chainId === expected.chainId);
  requireValid(
    identity.signer.toLowerCase() === expected.signer.toLowerCase()
  );

  const baseline = readObservation(field(input, 'baseline'));
  const lastObservation = readObservation(
    field(input, 'lastObservation')
  );
  const nextNonce = readUint(field(input, 'nextNonce'));

  requireValid(nextNonce >= baseline.nonce);

  const rawAttempt = field(input, 'attempt');
  let attempt: JournalAttempt | null = null;

  if (rawAttempt !== null) {
    attempt = readAttempt(rawAttempt);
    requireValid(attempt.nonce === nextNonce);
  }

  return Object.freeze({
    version: 1,
    identity,
    baseline,
    lastObservation,
    nextNonce,
    attempt,
  });
}

function readIdentity(input: unknown): JournalIdentity {
  const chainId = field(input, 'chainId');
  const signer = field(input, 'signer');

  requireValid(
    typeof chainId === 'number' &&
    Number.isSafeInteger(chainId) &&
    chainId > 0
  );
  requireValid(isFixedHex(signer, 20));

  return Object.freeze({
    chainId,
    signer: signer as Address,
  });
}

function readAnchor(input: unknown): Readonly<BlockAnchor> {
  const blockNumber = readUint(field(input, 'blockNumber'));
  const blockHash = field(input, 'blockHash');

  requireValid(isFixedHex(blockHash, 32));

  return Object.freeze({
    blockNumber,
    blockHash: blockHash as Hash,
  });
}

function readObservation(
  input: unknown,
): AnchoredNonceObservation {
  return Object.freeze({
    anchor: readAnchor(field(input, 'anchor')),
    nonce: readUint(field(input, 'nonce')),
  });
}

function readAttempt(input: unknown): JournalAttempt {
  const attemptId = field(input, 'attemptId');
  const nonce = readUint(field(input, 'nonce'));
  const transactionHash = field(input, 'transactionHash');
  const signedTransaction = field(input, 'signedTransaction');
  const createdAt = field(input, 'createdAt');
  const phase = field(input, 'phase');

  requireValid(isUuidV4(attemptId));
  requireValid(isFixedHex(transactionHash, 32));

  // Match the diagnostics factory's signed-byte representation.
  // This checks encoding only, not whether the bytes form a transaction.
  requireValid(
    typeof signedTransaction === 'string' &&
    signedTransaction.length >= 66 &&
    signedTransaction.length % 2 === 0 &&
    /^0x[0-9a-f]+$/.test(signedTransaction),
  );

  requireValid(typeof createdAt === 'string');

  const timestamp = Date.parse(createdAt);
  requireValid(Number.isFinite(timestamp));
  requireValid(new Date(timestamp).toISOString() === createdAt);

  requireValid(
    phase === 'signed' ||
    phase === 'broadcast-may-have-occurred',
  );

  const rawSearch = field(input, 'replacementSearch');
  let replacementSearch: ReplacementSearch | null = null;

  if (rawSearch !== null) {
    replacementSearch = readReplacementSearch(rawSearch, nonce);
  }

  return Object.freeze({
    attemptId,
    nonce,
    transactionHash: transactionHash as Hash,
    signedTransaction: signedTransaction as Hex,
    createdAt,
    phase,
    replacementSearch,
  });
}

function readReplacementSearch(
  input: unknown,
  attemptNonce: bigint,
): ReplacementSearch {
  const lowerBound = readObservation(field(input, 'lowerBound'));

  requireValid(lowerBound.nonce <= attemptNonce);

  const rawThrough = field(input, 'searchedThrough');
  let searchedThrough: Readonly<BlockAnchor> | null = null;

  if (rawThrough !== null) {
    searchedThrough = readAnchor(rawThrough);

    // The lower-bound block is already known to precede consumption.
    // A non-null progress marker represents at least one searched block.
    requireValid(
      searchedThrough.blockNumber > lowerBound.anchor.blockNumber
    );
  }

  return Object.freeze({
    lowerBound,
    searchedThrough
  });
}

function readUint(input: unknown): bigint {
  requireValid(
    typeof input === 'bigint' &&
    input >= 0n &&
    input <= MAX_UINT256
  );
  
  return input;
}

/**
 * Read declared own properties without invoking getters.
 * Unexpected extra properties are never copied into the result.
 */
function field(input: unknown, name: string): unknown {
  requireValid(
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input),
  )

  let descriptor: PropertyDescriptor | undefined;

  try {
    descriptor = Object.getOwnPropertyDescriptor(input, name);
  } catch {
    throw new TypeError('Invalid transaction journal snapshot.');
  }

  requireValid(
    descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value'),
  );

  return descriptor.value;
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) {
    throw new TypeError('Invalid transaction journal snapshot.');
  }
}