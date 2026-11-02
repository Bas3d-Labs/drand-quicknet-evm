import type {
  Address,
  Hash,
  Hex,
} from 'viem';

import type {
  SignerInclusionInspection,
} from '../chain/inspect-signer-inclusions.js';

import type {
  JournalPersistenceState,
} from './journal-persistence.js';

import type {
  SignerRecoveryResult,
} from './signer-coordinator.js';

import type {
  SignerBlocker,
} from './signer-gate.js';

import type {
  JournalAttempt,
} from './transaction-journal.js';

export type TransactionAdmissionReason = SignerBlocker;

export interface TransactionManagerOperationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly cycle?: number | undefined;
}

export interface TransactionManagerAnchor {
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
}

export interface ReconcileTransactionsOptions
  extends TransactionManagerOperationOptions {
  readonly head: Readonly<TransactionManagerAnchor>;
  readonly durable: Readonly<TransactionManagerAnchor>;
}

export interface TransactionWork {
  readonly workId: string;

  readonly call: {
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
    readonly gas?: bigint | undefined;
  };
}

export interface SubmitTransactionWorkOptions
  extends TransactionManagerOperationOptions {
  readonly work: TransactionWork;
}

export interface RetainedTransactionIdentity {
  readonly workId: string;
  readonly attemptId: string;
}

export interface TransactionBroadcastOutcome
  extends RetainedTransactionIdentity {
  readonly transactionHash: Hash;
  readonly nonce: bigint;
  readonly status: 'acknowledged' | 'not-acknowledged';
}

export type SubmitTransactionWorkResult =
  | {
      readonly status: 'submitted';
      readonly broadcast: TransactionBroadcastOutcome;
    }
  | {
      readonly status: 'deferred';
      readonly primaryReason: TransactionAdmissionReason;
      readonly reasons: readonly [
        TransactionAdmissionReason,
        ...TransactionAdmissionReason[],
      ];
    }
  | {
      readonly status: 'already-retained';
      readonly retained: RetainedTransactionIdentity;
    };

/**
 * Describes recording of this submission's attempt at the point of failure.
 * An uncertain write may already be visible in storage, so its identity
 * must come from the retained pending snapshot.
 */
export type SubmissionRecording =
  | {
      readonly status: 'none';
    }
  | {
      readonly status: 'uncertain';
      readonly attempt: RetainedTransactionIdentity;
    }
  | {
      readonly status: 'retained';
      readonly attempt: RetainedTransactionIdentity;
    };

export interface TransactionAttemptSummary
  extends RetainedTransactionIdentity {
  readonly nonce: bigint;
  readonly phase: JournalAttempt['phase'];
  readonly transactionHashes: readonly [Hash, ...Hash[]];
}

export interface TransactionManagerStatus {
  readonly chainId: number;
  readonly journalInitialized: boolean;
  readonly busy: boolean;
  readonly open: boolean;
  readonly primaryReason: TransactionAdmissionReason | null;
  readonly blockers: readonly TransactionAdmissionReason[];
  readonly recoveryComplete: boolean;
  readonly inclusionChecksComplete: boolean;
  readonly persistenceState: JournalPersistenceState;
  readonly blockedSince: string | null;
  readonly attempts: readonly TransactionAttemptSummary[];
}

export type TransactionRecoveryStatus =
  | SignerRecoveryResult['status']
  | 'skipped';

export type TransactionInclusionStatus =
  SignerInclusionInspection['status'];

export interface TransactionReconciliationReport {
  readonly state: TransactionManagerStatus;
  readonly recoveryStatus: TransactionRecoveryStatus;
  readonly inclusionStatus: TransactionInclusionStatus | null;
  readonly broadcast: TransactionBroadcastOutcome | null;
  readonly retryDelayMs: number | null;
}

export interface TransactionRecoveryObservation {
  readonly retryDelayMs: number | null;
}