import type {
  Hash,
  LocalAccount,
  PublicClient,
} from 'viem';

import type {
  BlockAnchor,
} from '../../chain/block-anchor.js';

import type {
  SignerBootstrapDecision,
} from '../../chain/inspect-signer-bootstrap.js';

import type {
  SignerInclusionInspection,
} from '../../chain/inspect-signer-inclusions.js';

import type {
  SignerRecoveryInspection,
} from '../../chain/inspect-signer-recovery.js';

import type {
  PreparedRelayerTransaction,
} from '../../chain/sign-prepared-transaction.js';

import type {
  ErrorSummaryFactory,
} from '../../config/config.js';

import type {
  ScopedRelayerLog,
} from '../../diagnostics/relayer-log.js';

import type {
  InspectionBracket,
} from '../inspection-bracket.js';

import type {
  OperatorAcceptanceRequest,
} from '../operator-acceptance.js';

import type {
  OperatorAttributionRequest,
} from '../operator-attribution.js';

import type {
  AnchoredNonceObservation,
  JournalAttempt,
  JournalIdentity,
  TransactionJournalStore,
} from '../transaction-journal.js';

export interface SignerCoordinatorOptions {
  readonly identity: JournalIdentity;
  readonly store: TransactionJournalStore;
  readonly maxRetainedAttempts: number;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly now?: () => number;
}

export interface RecoverSignerOptions {
  readonly attribution?: OperatorAttributionRequest;
  readonly acceptance?: OperatorAcceptanceRequest;
  readonly acceptanceCommitment?: {
    readonly snapshotDigest: Hash;
    readonly proposalDigest: Hash;
    readonly durable: AnchoredNonceObservation;
  };
  readonly attributionCommitment?: {
    readonly snapshotDigest: Hash;
    readonly proposalDigest: Hash;
    readonly inclusion: Readonly<BlockAnchor>;
    readonly durable: AnchoredNonceObservation;
  };
  readonly publicClient: PublicClient;
  readonly anchor: Readonly<BlockAnchor>;
  readonly maxBlockRange: bigint;
}

export type SignerRecoveryResult =
  | {
      readonly status: 'operator-ticket-refused';
      readonly reason: 'snapshot-changed' | 'proposal-changed';
    }
  | {
      readonly status: 'operator-attribution-committed' | 'operator-acceptance-committed';
      readonly requestId: string;
    }
  | SignerRecoveryInspection
  | Extract<
      SignerBootstrapDecision,
      { status: 'bootstrap-deferred' }
    >;

export interface PrepareAttemptOptions {
  readonly account: LocalAccount;
  readonly transaction: PreparedRelayerTransaction;
  readonly workId: string;
}

interface PreparedAttempt {
  readonly attemptId: string;
  readonly transactionHash: Hash;
  readonly nonce: bigint;
}

export type PrepareAttemptResult =
  | (PreparedAttempt & {
      readonly status: 'prepared';
    })
  | {
      /**
       * Existing retained work. No new nonce was allocated or transaction
       * signed. This result grants no broadcast authorization.
       */
      readonly status: 'already-retained';
      readonly attemptId: string;
      readonly workId: string;
    };

export interface BroadcastAttemptOptions {
  readonly publicClient: PublicClient;
  readonly attemptId: string;
}

/**
 * Reports whether the RPC returned the locally computed transaction hash.
 *
 * The broadcast permit is consumed before the request is sent.
 * Neither outcome establishes inclusion or execution, advances nonce
 * allocation, resolves an attempt, or rolls allocation back.
 *
 * Another broadcast requires fresh reconciliation.
 */
export type BroadcastAttemptResult = PreparedAttempt & (
  | {
      readonly status: 'acknowledged';
    }
  | {
      readonly status: 'not-acknowledged';
    }
);

export interface AttemptSummary {
  readonly attemptId: string;
  readonly workId: string;
  readonly nonce: bigint;
  readonly phase: JournalAttempt['phase'];

  /** Original transaction hash followed by any fee replacement hashes. */
  readonly transactionHashes: readonly [Hash, ...Hash[]];
}

export interface CheckSignerInclusionsOptions {
  readonly publicClient: PublicClient;
  readonly head: Readonly<BlockAnchor>;

  /** Maximum full blocks searched per unresolved attempt, when enabled. */
  readonly maxReplacementBlockRange?: bigint;
}

/**
 * Selects the latest block to check before and after the owned inspection.
 * Fresh recovery also supplies the durable recovery anchor: the block at which
 * durable receipts and the signer nonce are checked.
 *
 * Without this selection, standalone recovery checks only its durable anchor.
 * The first inclusion operation starts its own latest-block checks. This also
 * applies when the cycle reuses a previously completed durable recovery pass.
 */
export interface OpenSignerInspectionOptions {
  readonly publicClient: PublicClient;
  readonly head: Readonly<BlockAnchor>;
  readonly durableAnchor?: Readonly<BlockAnchor>;
}

export interface SignerInspection {
  recover(
    options: RecoverSignerOptions,
    cycle?: number,
  ): Promise<SignerRecoveryResult>;

  checkInclusions(
    options: CheckSignerInclusionsOptions,
    cycle?: number,
  ): Promise<SignerInclusionInspection>;

  /**
   * Releases a successfully completed inspection.
   *
   * Rejects while an operation is running, persistence is pending, or an
   * opened bracket has not completed its latest commit.
   * Pending persistence must be retried after abandoning ownership,
   * before another inspection begins.
   */
  finish(): void;

  /**
   * Prevents further operations, waits for any started operation to
   * settle, clears action authorization, and releases ownership.
   *
   * Preserves acknowledged commits and pending persistence.
   */
  abandon(): Promise<void>;
}

export interface InspectionOwner {
  bracket: InspectionBracket | null;
  activeOperation: Promise<unknown> | null;
  abandonment: Promise<void> | null;
  abandoning: boolean;
  cycle: number | undefined;
}
