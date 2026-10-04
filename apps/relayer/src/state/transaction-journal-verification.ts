import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
} from 'viem';

import type {
  JournalAttempt,
  JournalIdentity,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Returns a detached, frozen snapshot after validating its structure
 * and verifying any recorded signed transaction.
 */
export async function verifyJournalSnapshot(
  input: unknown,
  expectedIdentity: JournalIdentity,
): Promise<TransactionJournalSnapshot> {
  const snapshot = validateJournalSnapshotStructure(
    input,
    expectedIdentity,
  );

  if (snapshot.attempt !== null) {
    await verifyAttempt(snapshot.identity, snapshot.attempt);
  }

  return snapshot;
}

async function verifyAttempt(
  identity: JournalIdentity,
  attempt: JournalAttempt,
): Promise<void> {
  try {
    const bytes = attempt.signedTransaction;

    requireValid(
      keccak256(bytes).toLowerCase() === attempt.transactionHash.toLowerCase()
    );

    const transaction = parseTransaction(bytes);

    requireValid(
      transaction.type === 'legacy' ||
      transaction.type === 'eip2930' ||
      transaction.type === 'eip1559'
    );

    // Reject unprotected legacy transactions without a chain id.
    requireValid(transaction.chainId === identity.chainId);

    const nonce = transaction.nonce;

    requireValid(
      typeof nonce === 'number' &&
      Number.isSafeInteger(nonce) &&
      nonce >= 0
    );
    requireValid(BigInt(nonce) === attempt.nonce);

    requireValid(
      transaction.r !== undefined &&
      transaction.s !== undefined
    );

    const r = BigInt(transaction.r);
    const s = BigInt(transaction.s);

    requireValid(
      r > 0n &&
      r < SECP256K1_ORDER &&
      s > 0n &&
      s <= SECP256K1_ORDER / 2n
    );

    requireValid(
      transaction.yParity === 0 ||
      transaction.yParity === 1
    );

    const serialized = serializeTransaction(transaction, {
      r: transaction.r,
      s: transaction.s,
      v: transaction.v,
      yParity: transaction.yParity,
    });

    // Reject encodings that do not round-trip canonically.
    requireValid(
      serialized.toLowerCase() === bytes.toLowerCase()
    );

    const signer = await recoverTransactionAddress({
      serializedTransaction: serialized,
    });

    requireValid(
      signer.toLowerCase() === identity.signer.toLowerCase()
    );
  } catch {
    // Parser and recovery errors can contain serialized transaction
    // bytes. Do not retain their messages or attach them as causes.
    throw new TypeError('Invalid journal signed transaction.');
  }
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) {
    throw new TypeError('Invalid journal signed transaction.');
  }
}