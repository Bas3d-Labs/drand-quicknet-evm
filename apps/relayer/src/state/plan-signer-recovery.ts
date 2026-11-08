import type {
  Hash,
} from 'viem';

import type {
  SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

import {
  assertResolutionTransaction,
  snapshotResolutionEvidence,
} from '../diagnostics/resolution-validation.js';

import type {
  AttemptResolutionEvidence,
} from '../diagnostics/transaction-evidence.js';

import type {
  AnchoredNonceObservation,
  JournalIdentity,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface CommittedAttemptResolution {
  readonly signer: JournalIdentity['signer'];
  readonly attemptId: string;
  readonly transactionHash: Hash;
  readonly nonce: bigint;
  readonly resolution: AttemptResolutionEvidence;
}

export type RecoveryWriteCompletion =
  | {
      readonly kind: 'observation';
    }
  | {
      readonly kind: 'resolution';
      readonly event: CommittedAttemptResolution;
    }
  | {
      readonly kind: 'search-progress';
      readonly exhausted: boolean;
    };

export interface PlanSignerRecoveryOptions {
  readonly identity: JournalIdentity;
  readonly snapshot: TransactionJournalSnapshot;
  readonly inspection: SignerRecoveryInspection;
  readonly unattributedActivity: boolean;
}

export type SignerRecoveryPlan =
  | {
      readonly kind: 'unchanged';
    }
  | {
      readonly kind: 'persist';
      readonly snapshot: TransactionJournalSnapshot;
      readonly completion: RecoveryWriteCompletion;
    };

/**
 * Plans a journal transition from an existing recovery inspection.
 */
export function planSignerRecovery(
  options: PlanSignerRecoveryOptions,
): SignerRecoveryPlan {
  const {
    identity,
    snapshot,
    inspection,
    unattributedActivity,
  } = options;

  if (
    inspection.status === 'anchor-changed' ||
    inspection.status === 'nonce-behind-journal' ||
    inspection.status === 'inconsistent-observations'
  ) {
    return { kind: 'unchanged' };
  }

  if (
    inspection.status === 'unresolved' &&
    (
      inspection.search?.status === 'boundary-changed' ||
      inspection.search?.status === 'anchor-behind-search'
    )
  ) {
    return { kind: 'unchanged' };
  }

  let lastObservation = inspection.observation;

  if (
    unattributedActivity &&
    snapshot.lastObservation.nonce > lastObservation.nonce
  ) {
    // Resolution may proceed without erasing the higher observation.
    if (inspection.status !== 'resolution-available') {
      return { kind: 'unchanged' };
    }

    lastObservation = snapshot.lastObservation;
  }

  const oldest = snapshot.attempts[0];

  let attempts = snapshot.attempts;
  let durableNextNonce = snapshot.durableNextNonce;

  let completion: RecoveryWriteCompletion = {
    kind: 'observation',
  };

  if (inspection.status === 'resolution-available') {
    if (oldest === undefined) {
      throw new Error('No recorded attempt is available to resolve.');
    }

    const resolution = snapshotResolutionEvidence(
      inspection.evidence,
    );

    assertResolutionTransaction(oldest, resolution);

    let transactionHash = oldest.signedTransactions[0].transactionHash;

    if (resolution.outcome !== 'replaced') {
      transactionHash = resolution.transactionHash;
    }

    completion = {
      kind: 'resolution',
      event: Object.freeze({
        signer: identity.signer,
        attemptId: oldest.attemptId,
        transactionHash,
        nonce: oldest.nonce,
        resolution,
      }),
    };

    durableNextNonce = oldest.nonce + 1n;
    attempts = attempts.slice(1);
  } else if (oldest !== undefined) {
    let replacementSearch = oldest.replacementSearch;

    if (replacementSearch === null) {
      let lowerBound: AnchoredNonceObservation | undefined;

      if (lastObservation.nonce <= oldest.nonce) {
        lowerBound = lastObservation;
      } else if (snapshot.lastObservation.nonce <= oldest.nonce) {
        lowerBound = snapshot.lastObservation;
      }

      if (lowerBound !== undefined) {
        replacementSearch = {
          lowerBound,
          searchedThrough: null,
        };
      }
    }

    if (
      inspection.status === 'unresolved' &&
      inspection.search?.status === 'not-found' &&
      inspection.search.scannedBlocks > 0n
    ) {
      if (replacementSearch === null) {
        throw new Error(
          'Search progress requires a recorded lower bound.'
        );
      }

      replacementSearch = {
        ...replacementSearch,
        searchedThrough: inspection.search.searchedThrough,
      };

      completion = {
        kind: 'search-progress',
        exhausted: inspection.search.remainingBlocks === 0n,
      };
    }

    attempts = [
      {
        ...oldest,
        replacementSearch,
      },
      ...attempts.slice(1),
    ];
  }

  const next = validateJournalSnapshotStructure({
    ...snapshot,
    lastObservation,
    durableNextNonce,
    attempts,
  }, identity);

  return {
    kind: 'persist',
    snapshot: next,
    completion,
  };
}