import type {
  SignedRelayerTransaction,
} from '../chain/sign-prepared-transaction.js';

import type {
  JournalAttempt,
  JournalIdentity,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface PlanAttemptPreparationOptions {
  readonly identity: JournalIdentity;
  readonly snapshot: TransactionJournalSnapshot;
  readonly attemptId: string;
  readonly workId: string;
  readonly createdAt: string;
  readonly signed: SignedRelayerTransaction;
}

/**
 * Appends a verified signed transaction to the retained journal.
 * 
 * Advances allocation without advancing durable progress.
 */
export function planAttemptPreparation(
  options: PlanAttemptPreparationOptions,
): TransactionJournalSnapshot {
  const {
    identity,
    snapshot,
    attemptId,
    workId,
    createdAt,
    signed,
  } = options;

  const attempt: JournalAttempt = {
    attemptId,
    workId,
    nonce: signed.nonce,
    createdAt,
    signedTransactions: [{
      transactionHash: signed.transactionHash,
      signedTransaction: signed.signedTransaction,
    }],
    phase: 'signed',
    inclusion: null,
    replacementSearch: {
      lowerBound: snapshot.lastObservation,
      searchedThrough: null,
      exhausted: null,
    },
  };

  return validateJournalSnapshotStructure({
    ...snapshot,
    nextNonce: snapshot.nextNonce + 1n,
    attempts: [
      ...snapshot.attempts,
      attempt,
    ],
  }, identity);
}