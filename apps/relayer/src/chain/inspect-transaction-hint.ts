import {
  TransactionNotFoundError,
  type Hash,
  type PublicClient,
} from 'viem';

import {
  journalSnapshotDigest,
} from '../state/operator-attribution.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isNonNegativeSafeInteger,
} from '../shared/integer.js';

import {
  MAX_OPERATOR_OUTCOMES,
  type AnchoredNonceObservation,
  type TransactionJournalSnapshot,
} from '../state/transaction-journal.js';

import {
  blockAnchorsMatch,
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

export interface TransactionHint {
  readonly attemptId: string;
  readonly transactionHash: Hash;
  readonly blockNumber?: bigint;
}

export type TransactionHintInspection =
  | {
      readonly status: 'operator-attribution-available';
      readonly snapshotDigest: Hash;
      readonly observation: AnchoredNonceObservation;
      readonly observations: readonly Readonly<BlockAnchor>[];
      readonly attemptId: string;
      readonly transactionHash: Hash;
      readonly inclusion: Readonly<BlockAnchor>;
    }
  | {
      readonly status: 'operator-hint-refused';
      readonly observation: AnchoredNonceObservation;
      readonly reason:
        | 'missing-lower-bound'
        | 'wrong-attempt'
        | 'inclusion-outside-bound'
        | 'anchor-changed'
        | 'inconsistent-observations'
        | 'correction-required'
        | 'invalid-parent'
        | 'invalid-match'
        | 'retained-candidate-unresolved'
        | 'nonce-unconsumed'
        | 'ledger-capacity-reached'
        | 'locator-pending'
        | 'locator-not-found'
        | 'cursor-above-durable'
        | 'stale-evidence';
    };

/** Called only after ordinary receipt, nonce and all-attempt precedence checks. */
export async function inspectTransactionHint(options: {
  readonly publicClient: PublicClient;
  readonly snapshot: TransactionJournalSnapshot;
  readonly observation: AnchoredNonceObservation;
  readonly observations: readonly Readonly<BlockAnchor>[];
  readonly hint: TransactionHint;
}): Promise<TransactionHintInspection> {
  const {
    publicClient,
    snapshot,
    observation,
    hint,
  } = options;

  const refuse = (
    reason: Extract<TransactionHintInspection, { status: 'operator-hint-refused' }>['reason'],
  ): TransactionHintInspection => ({
    status: 'operator-hint-refused',
    observation,
    reason,
  });

  const oldest = snapshot.attempts[0];

  if (oldest === undefined || hint.attemptId !== oldest.attemptId) {
    return refuse('wrong-attempt');
  }

  if (!isFixedHex(hint.transactionHash, 32)) {
    return refuse('invalid-match');
  }

  if (oldest.signedTransactions.some(
    (candidate) => candidate.transactionHash.toLowerCase() === hint.transactionHash.toLowerCase(),
  )) {
    return refuse('retained-candidate-unresolved');
  }

  const search = oldest.replacementSearch;

  if (search === null) {
    return refuse('missing-lower-bound');
  }

  if (observation.nonce <= oldest.nonce) {
    return refuse('nonce-unconsumed');
  }

  if (snapshot.ledger.outcomes.length >= MAX_OPERATOR_OUTCOMES) {
    return refuse('ledger-capacity-reached');
  }

  let height = hint.blockNumber;

  if (height === undefined) {
    try {
      const located = await publicClient.getTransaction({
        hash: hint.transactionHash,
      });

      if (located.blockNumber === null) {
        return refuse('locator-pending');
      }

      height = located.blockNumber;
    } catch (error) {
      if (error instanceof TransactionNotFoundError) {
        return refuse('locator-not-found');
      }

      throw error;
    }
  }

  const durable = observation.anchor;

  const lower = search.lowerBound.anchor;

  if (
    typeof height !== 'bigint' ||
    height <= lower.blockNumber ||
    height > durable.blockNumber
  ) {
    return refuse('inclusion-outside-bound');
  }

  const fact = search.exhausted;

  const cursor = search.searchedThrough;

  const needsCursor = cursor !== null && height <= cursor.blockNumber;

  if (needsCursor && cursor.blockNumber > durable.blockNumber) {
    return refuse('cursor-above-durable');
  }

  const reads: Readonly<BlockAnchor>[] = [];

  const headers = new Map<bigint, Readonly<BlockAnchor>>();

  let coherent = true;

  const record = (header: Readonly<BlockAnchor>): void => {
    const previous = headers.get(header.blockNumber);

    if (previous !== undefined && !blockAnchorsMatch(previous, header)) {
      coherent = false;
    }

    headers.set(header.blockNumber, header);
    reads.push(header);
  };

  const read = async (
    number: bigint,
    expectedHash?: Hash,
  ): Promise<Readonly<BlockAnchor>> => {
    const result = Object.freeze(await getBlockAnchor(
      publicClient,
      number,
      expectedHash,
      {
        operation: 'signer-recovery',
      },
    ));

    record(result);

    return result;
  };

  const opening = await read(durable.blockNumber, durable.blockHash);

  if (!blockAnchorsMatch(opening, durable)) {
    return refuse('anchor-changed');
  }

  const observedLower = await read(lower.blockNumber, lower.blockHash);

  let observedFact = opening;

  if (fact !== null && fact.anchor.blockNumber !== durable.blockNumber) {
    observedFact = await read(fact.anchor.blockNumber, fact.anchor.blockHash);
  }

  let observedCursor: Readonly<BlockAnchor> | undefined;

  if (needsCursor) {
    observedCursor = headers.get(cursor.blockNumber);

    if (observedCursor === undefined) {
      observedCursor = await read(cursor.blockNumber, cursor.blockHash);
    }
  }

  let predecessor = headers.get(height - 1n);

  if (predecessor === undefined) {
    predecessor = await read(height - 1n);
  }

  const block = await publicClient.getBlock({
    blockNumber: height,
    includeTransactions: true,
  });

  let inclusion: Readonly<BlockAnchor> | undefined;

  if (block.number === height && isFixedHex(block.hash, 32)) {
    inclusion = Object.freeze({
      blockNumber: height,
      blockHash: block.hash,
    });
    record(inclusion);
  }

  const closing = await read(durable.blockNumber, durable.blockHash);

  if (!blockAnchorsMatch(closing, durable)) {
    return refuse('anchor-changed');
  }

  if (inclusion === undefined) {
    return refuse('inconsistent-observations');
  }

  // Receipt brackets and this bracket must agree at every shared height.
  for (const prior of options.observations) {
    const current = headers.get(prior.blockNumber);

    if (current !== undefined && !blockAnchorsMatch(current, prior)) {
      coherent = false;
    }
  }

  if (!coherent) {
    return refuse('inconsistent-observations');
  }

  if (
    !blockAnchorsMatch(lower, observedLower) ||
    (fact !== null && !blockAnchorsMatch(fact.anchor, observedFact)) ||
    (needsCursor && !blockAnchorsMatch(cursor, observedCursor!))
  ) {
    return refuse('correction-required');
  }

  if (fact !== null && observation.nonce < fact.nonce) {
    return refuse('inconsistent-observations');
  }

  if (
    !isFixedHex(block.parentHash, 32) ||
    block.parentHash.toLowerCase() !== predecessor.blockHash.toLowerCase()
  ) {
    return refuse('invalid-parent');
  }

  if (!Array.isArray(block.transactions)) {
    return refuse('invalid-match');
  }

  let match: Hash | undefined;

  for (const transaction of block.transactions) {
    if (
      typeof transaction !== 'object' ||
      transaction === null ||
      !isFixedHex(transaction.hash, 32) ||
      !isFixedHex(transaction.from, 20) ||
      !isNonNegativeSafeInteger(transaction.nonce)
    ) {
      return refuse('invalid-match');
    }

    if (
      transaction.from.toLowerCase() === snapshot.identity.signer.toLowerCase() &&
      BigInt(transaction.nonce) === oldest.nonce
    ) {
      if (match !== undefined) {
        return refuse('invalid-match');
      }

      match = transaction.hash;
    }
  }

  if (match === undefined || match.toLowerCase() !== hint.transactionHash.toLowerCase()) {
    return refuse('invalid-match');
  }

  return Object.freeze({
    status: 'operator-attribution-available',
    snapshotDigest: journalSnapshotDigest(snapshot),
    observation,
    observations: Object.freeze([...options.observations, ...reads]),
    attemptId: oldest.attemptId,
    transactionHash: match.toLowerCase() as Hash,
    inclusion,
  });
}
