import type {
  SignerInclusionInspection,
} from '../chain/inspect-signer-inclusions.js';

import type {
  JournalIdentity,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface PlanSignerInclusionsOptions {
  readonly identity: JournalIdentity;
  readonly snapshot: TransactionJournalSnapshot;
  readonly inspection: Extract<
    SignerInclusionInspection,
    { status: 'inspected' }
  >;
  readonly unattributedActivity: boolean;
}

/**
 * Plans a journal update from a completed inclusion inspection.
 */
export function planSignerInclusions(
  options: PlanSignerInclusionsOptions,
): TransactionJournalSnapshot {
  const {
    identity,
    snapshot,
    inspection,
    unattributedActivity,
  } = options;

  let lastObservation = inspection.observation;

  if (
    unattributedActivity &&
    snapshot.lastObservation.nonce > lastObservation.nonce
  ) {
    lastObservation = snapshot.lastObservation;
  }

  return validateJournalSnapshotStructure({
    ...snapshot,
    lastObservation,
    attempts: inspection.attempts,
  }, identity);
}