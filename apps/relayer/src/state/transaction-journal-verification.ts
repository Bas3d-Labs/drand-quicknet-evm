import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
} from 'viem';

import type {
  JournalAttempt,
  JournalIdentity,
  JournalSignedTransaction,
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

  for (const attempt of snapshot.attempts) {
    await verifyJournalAttempt(snapshot.identity, attempt);
  }

  return snapshot;
}

/**
 * Verifies that each signed transaction belongs to the recorded signer,
 * chain, and nonce, and that fee replacements preserve the original call.
 */
export async function verifyJournalAttempt(
  identity: JournalIdentity,
  attempt: Pick<
    JournalAttempt,
    'nonce' | 'signedTransactions'
  >,
): Promise<void> {
  try {
    const expectedIdentity = {
      chainId: identity.chainId,
      signer: identity.signer,
    };
    const nonce = attempt.nonce;
    const transactions = attempt.signedTransactions.map(
      (transaction) => ({
        transactionHash: transaction.transactionHash,
        signedTransaction: transaction.signedTransaction,
      }),
    );

    requireValid(transactions.length > 0);

    const hashes = new Set<string>();
    let originalIntent: string | undefined;

    for (const transaction of transactions) {
      const hash = transaction.transactionHash.toLowerCase();

      requireValid(!hashes.has(hash));
      hashes.add(hash);

      const intent = await verifySignedTransaction(
        expectedIdentity,
        nonce,
        transaction,
      );

      if (originalIntent === undefined) {
        originalIntent = intent;
      } else {
        requireValid(intent === originalIntent);
      }
    }
  } catch {
    throw new TypeError('Invalid journal signed transaction.');
  }
}

async function verifySignedTransaction(
  identity: JournalIdentity,
  nonce: bigint,
  signed: JournalSignedTransaction,
): Promise<string> {
  const bytes = signed.signedTransaction;

  requireValid(
    keccak256(bytes).toLowerCase() ===
    signed.transactionHash.toLowerCase()
  );

  const transaction = parseTransaction(bytes);

  requireValid(
    transaction.type === 'legacy' ||
    transaction.type === 'eip2930' ||
    transaction.type === 'eip1559'
  );

  // Reject unprotected legacy transactions without a chain id.
  requireValid(transaction.chainId === identity.chainId);

  const parsedNonce = transaction.nonce;

  requireValid(
      typeof parsedNonce === 'number' &&
      Number.isSafeInteger(parsedNonce) &&
      parsedNonce >= 0
  );
  requireValid(BigInt(parsedNonce) === nonce);

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

  requireValid(
    serialized.toLowerCase() === bytes.toLowerCase()
  );

  const signer = await recoverTransactionAddress({
    serializedTransaction: serialized,
  });

  requireValid(
    signer.toLowerCase() === identity.signer.toLowerCase()
  );

  // Compare the complete supported transaction encoding with only
  // signature and fee differences removed.
  switch (transaction.type) {
    case 'legacy':
    case 'eip2930':
      return serializeTransaction({
        ...transaction,
        gasPrice: 0n,
        r: undefined,
        s: undefined,
        v: undefined,
        yParity: undefined,
      }).toLowerCase();

    case 'eip1559':
      return serializeTransaction({
        ...transaction,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        r: undefined,
        s: undefined,
        v: undefined,
        yParity: undefined,
      }).toLowerCase();

    default:
      throw new TypeError('Invalid journal signed transaction.');
  }
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) {
    throw new TypeError('Invalid journal signed transaction.');
  }
}