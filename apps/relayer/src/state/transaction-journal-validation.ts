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
  JournalInclusionObservation,
  JournalSignedTransaction,
  ReplacementSearch,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  isUuidV4
} from '../shared/uuid.js';

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
  const durableNextNonce = readUint(field(input, 'durableNextNonce'));

  requireValid(durableNextNonce >= baseline.nonce);
  requireValid(nextNonce >= durableNextNonce);

  const attempts = readArray(field(input, 'attempts'), readAttempt);

  requireValid(
    BigInt(attempts.length) === nextNonce - durableNextNonce
  );

  const attemptIds = new Set<string>();
  const transactionHashes = new Set<string>();

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const attemptId = attempt.attemptId.toLowerCase();

    requireValid(
      attempt.nonce === durableNextNonce + BigInt(index)
    );
    requireValid(!attemptIds.has(attemptId));
    
    attemptIds.add(attemptId);

    for (const transaction of attempt.signedTransactions) {
      const hash = transaction.transactionHash.toLowerCase();

      requireValid(!transactionHashes.has(hash));
      transactionHashes.add(hash);
    }
  }

  return Object.freeze({
    version: 1,
    identity,
    baseline,
    lastObservation,
    nextNonce,
    durableNextNonce,
    attempts,
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
  const createdAt = field(input, 'createdAt');
  const phase = field(input, 'phase');

  requireValid(isUuidV4(attemptId));
  requireValid(typeof createdAt === 'string');

  const timestamp = Date.parse(createdAt);
  requireValid(Number.isFinite(timestamp));
  requireValid(new Date(timestamp).toISOString() === createdAt);

  const transactions = readArray(
    field(input, 'signedTransactions'),
    readSignedTransaction,
  );

  requireValid(transactions.length > 0);

  const signedTransactions = transactions as readonly [
    JournalSignedTransaction,
    ...JournalSignedTransaction[],
  ];

  const rawSearch = field(input, 'replacementSearch');
  const replacementSearch = rawSearch === null
    ? null
    : readReplacementSearch(rawSearch, nonce);

  const common = {
    attemptId,
    nonce,
    createdAt,
    signedTransactions,
    replacementSearch,
  };

  const rawInclusion = field(input, 'inclusion');

  switch (phase) {
    case 'signed':
    case 'broadcast-may-have-occurred': {
      requireValid(rawInclusion === null);

      return Object.freeze({
        ...common,
        phase,
        inclusion: null
      });
    }

    case 'included':
      return Object.freeze({
        ...common,
        phase,
        inclusion: readInclusion(
          rawInclusion,
          nonce,
          signedTransactions,
        ),
      });
    
    default:
      throw new TypeError('Invalid transaction journal snapshot.');
  }
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

function readSignedTransaction(
  input: unknown,
): JournalSignedTransaction {
  const transactionHash = field(input, 'transactionHash');
  const signedTransaction = field(input, 'signedTransaction');

  requireValid(isFixedHex(transactionHash, 32));

  requireValid(
    typeof signedTransaction === 'string' &&
    signedTransaction.length >= 66 &&
    signedTransaction.length % 2 === 0 &&
    /^0x[0-9a-f]+$/.test(signedTransaction),
  );

  return Object.freeze({
    transactionHash: transactionHash as Hash,
    signedTransaction: signedTransaction as Hex,
  });
}

function readInclusion(
  input: unknown,
  attemptNonce: bigint,
  signedTransactions: readonly JournalSignedTransaction[],
): JournalInclusionObservation {
  const inclusion = readAnchor(field(input, 'inclusion'));
  const observedAt = readAnchor(field(input, 'observedAt'));
  const outcome = field(input, 'outcome');

  requireValid(inclusion.blockNumber <= observedAt.blockNumber);

  if (inclusion.blockNumber === observedAt.blockNumber) {
    requireValid(
      inclusion.blockHash.toLowerCase() ===
      observedAt.blockHash.toLowerCase()
    );
  }

  const containsHash = (hash: Hash): boolean =>
    signedTransactions.some((transaction) => 
      transaction.transactionHash.toLowerCase() === hash.toLowerCase()
    );

  switch (outcome) {
    case 'success':
    case 'reverted': {
      const transactionHash = field(input, 'transactionHash');

      requireValid(isFixedHex(transactionHash, 32));
      requireValid(containsHash(transactionHash as Hash));

      return Object.freeze({
        inclusion,
        observedAt,
        outcome,
        transactionHash: transactionHash as Hash,
      });
    }

    case 'replaced': {
      const replacementTransactionHash = field(
        input,
        'replacementTransactionHash',
      );
      const nonceAtAnchor = readUint(field(input, 'nonceAtAnchor'));

      requireValid(isFixedHex(replacementTransactionHash, 32));
      requireValid(
        !containsHash(replacementTransactionHash as Hash)
      );
      requireValid(nonceAtAnchor > attemptNonce);

      return Object.freeze({
        inclusion,
        observedAt,
        outcome,
        replacementTransactionHash: replacementTransactionHash as Hash,
        nonceAtAnchor,
      });
    }

    default:
      throw new TypeError('Invalid transaction journal snapshot.');
  }
}

function readUint(input: unknown): bigint {
  requireValid(
    typeof input === 'bigint' &&
    input >= 0n &&
    input <= MAX_UINT256
  );
  
  return input;
}

function readArray<T>(
  input: unknown,
  readItem: (value: unknown) => T,
): readonly T[] {
  requireValid(Array.isArray(input));

  const length = ownValue(input, 'length');

  requireValid(
    typeof length === 'number' &&
    Number.isSafeInteger(length) &&
    length >= 0
  );

  const result: T[] = [];

  for (let index = 0; index < length; index += 1) {
    result.push(readItem(ownValue(input, String(index))));
  }

  return Object.freeze(result);
}

/**
 * Reads a declared object field without invoking its getter.
 * Extra fields are never copied into the snapshot.
 */
function field(
  input: unknown,
  name: string,
): unknown {
  requireValid(
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input),
  )

  return ownValue(input, name);
}

function ownValue(
  input: object,
  name: string,
): unknown {
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