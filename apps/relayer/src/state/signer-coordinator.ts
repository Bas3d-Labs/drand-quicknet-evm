import {
  randomUUID,
} from 'node:crypto';

import type {
  Hash,
  Hex,
  LocalAccount,
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  checkBlockAnchor,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  broadcastSignedTransaction,
} from '../chain/broadcast-signed-transaction.js';

import {
  inspectSignerBootstrap,
  type SignerBootstrapDecision,
} from '../chain/inspect-signer-bootstrap.js';

import {
  inspectSignerInclusions,
  type SignerInclusionInspection,
} from '../chain/inspect-signer-inclusions.js';

import {
  inspectSignerRecovery,
  type SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

import {
  signPreparedTransaction,
  type PreparedRelayerTransaction,
} from '../chain/sign-prepared-transaction.js';

import type {
  ErrorSummaryFactory,
} from '../config/config.js';

import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import {
  isWorkId,
} from '../execution/work-identity.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

import {
  supersedesNoMatch,
  validateAttributionRequest,
  journalSnapshotDigest,
  type OperatorAttributionRequest,
} from './operator-attribution.js';

import {
  durableRecoveryRevision as computeDurableRecoveryRevision,
} from './durable-recovery-revision.js';

import {
  JournalPersistence,
} from './journal-persistence.js';

import {
  planAttemptPreparation,
} from './plan-attempt-preparation.js';

import {
  planSignerInclusions,
} from './plan-signer-inclusions.js';

import {
  planSignerRecovery,
  type RecoveryWriteCompletion,
} from './plan-signer-recovery.js';

import {
  evaluateSignerGate,
  type CoordinatorBlocker,
} from './signer-gate.js';

import {
  SignerGateDiagnostics,
} from './signer-gate-diagnostics.js';

import type {
  SubmissionRecording,
} from './transaction-manager-types.js';

import type {
  AnchoredNonceObservation,
  JournalAttempt,
  JournalIdentity,
  TransactionJournalRead,
  TransactionJournalStore,
} from './transaction-journal.js';

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
      readonly status: 'operator-attribution-committed';
      readonly requestId: string;
    }
  | SignerRecoveryInspection
  | Extract<
      SignerBootstrapDecision,
      { status: 'bootstrap-deferred' }
    >;

type PendingWrite =
  | RecoveryWriteCompletion
  | {
      kind: 'bootstrap';
    }
  | {
      kind: 'prepared';
    }
  | {
      kind: 'broadcast';
    };

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

type SignerEventOperation =
  | 'prepare-attempt'
  | 'broadcast-attempt'
  | 'reconcile-attempt';

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

interface InspectionBracket {
  readonly publicClient: PublicClient;
  readonly head: Readonly<BlockAnchor>;
  readonly durableAnchor: Readonly<BlockAnchor> | undefined;
  durableNonce: bigint | undefined;

  /** Observed hashes for this inspection only; never persisted or cached. */
  durableObservations: ReadonlyMap<bigint, Hash>;
  phase:
    | 'opening'
    | 'durable'
    | 'latest'
    | 'closing'
    | 'persisting'
    | 'completed'
    | 'failed';
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

interface InspectionOwner {
  bracket: InspectionBracket | null;
  activeOperation: Promise<unknown> | null;
  abandonment: Promise<void> | null;
  abandoning: boolean;
  cycle: number | undefined;
}

/**
 * Coordinates durable nonce observations and attempt resolution so restart
 * recovery and signer availability follow the same journal state.
 */
export class SignerCoordinator {
  private recoveryComplete = false;
  private inclusionChecksComplete = false;
  private reconciliationObservationActive = false;
  private busy = false;
  private emitting = false;
  private broadcastPermit: string | undefined;

  private inspectionOwner: InspectionOwner | null = null;

  private pendingWrite: PendingWrite | undefined;
  private attemptLog: ScopedRelayerLog | undefined;
  private lastBootstrapDeferral: {
    readonly durableNonce: bigint;
    readonly latestNonce: bigint;
    readonly pendingNonce: bigint;
  } | undefined;

  private committedDurableRecoveryRevision = '';

  private readonly blockers = new Set<CoordinatorBlocker>();
  private readonly gateDiagnostics = new SignerGateDiagnostics(
    () => this.timestamp(),
  );

  private constructor(
    private readonly persistence: JournalPersistence,
    private readonly identity: JournalIdentity,
    private readonly maxRetainedAttempts: number,
    private readonly log: ScopedRelayerLog,
    private readonly now: () => number,
    private readonly createErrorSummary: ErrorSummaryFactory,
  ) {}

  static async create(
    options: SignerCoordinatorOptions,
  ): Promise<SignerCoordinator> {
    const maxRetainedAttempts = options.maxRetainedAttempts;

    if (!isPositiveSafeInteger(maxRetainedAttempts)) {
      throw new TypeError('Invalid retained attempt capacity.');
    }

    const identity = Object.freeze({ ...options.identity });

    const persistence = await JournalPersistence.create({
      identity,
      store: options.store,
      initial: await options.store.load(),
    });

    const coordinator = new SignerCoordinator(
      persistence,
      identity,
      maxRetainedAttempts,
      options.log.withContext({ signer: identity.signer }),
      options.now ?? Date.now,
      options.createErrorSummary,
    );

    const current = persistence.current;
    if (current.kind === 'present') {
      const attempts = current.snapshot.attempts;
      const first = attempts[0];

      if (first !== undefined) {
        coordinator.attemptLog =
          coordinator.createSignedAttemptLog(attempts);

        coordinator.gateDiagnostics.blockedSince = first.createdAt;
      }
    }
    
    coordinator.latchUnattributedActivity();
    coordinator.reconcileExhaustedSearch();
    coordinator.refresh();
    coordinator.updateDurableRecoveryRevision();

    return coordinator;
  }

  /**
   * Acquires ownership synchronously. The first owned operation performs
   * the selected opening read before its body. Once a bracket is opened,
   * finish requires a successful latest commit.
   * An unsuccessful bracket must be abandoned, preserving durable commits.
   */
  beginInspection(
    options?: OpenSignerInspectionOptions,
  ): SignerInspection {
    this.assertAvailable();
    this.assertPersistenceIdle();

    const owner: InspectionOwner = {
      bracket: options === undefined
        ? null
        : this.createInspectionBracket(options),
      activeOperation: null,
      abandonment: null,
      abandoning: false,
      cycle: undefined,
    };

    this.inspectionOwner = owner;
    this.revokeActionAuthorization();

    return Object.freeze({
      recover: (
        options: RecoverSignerOptions,
        cycle?: number,
      ) => {
        const captured: RecoverSignerOptions = {
          publicClient: options.publicClient,
          anchor: Object.freeze({
            blockNumber: options.anchor.blockNumber,
            blockHash: options.anchor.blockHash,
          }),
          maxBlockRange: options.maxBlockRange,
          ...(options.attribution === undefined ? {} : {
            attribution: structuredClone(options.attribution),
          }),
          ...(options.attributionCommitment === undefined ? {} : {
            attributionCommitment: structuredClone(options.attributionCommitment),
          }),
        };

        return this.runInspectionOperation(
          owner,
          () => this.recoverOwned(captured, owner, cycle),
          cycle,
        );
      },

      checkInclusions: (
        options: CheckSignerInclusionsOptions,
        cycle?: number,
      ) => {
        const maxReplacementBlockRange =
          options.maxReplacementBlockRange;

          const captured: CheckSignerInclusionsOptions = {
            publicClient: options.publicClient,
            head: Object.freeze({
              blockNumber: options.head.blockNumber,
              blockHash: options.head.blockHash,
            }),
            ...(maxReplacementBlockRange === undefined
              ? {}
              : { maxReplacementBlockRange }),
          };

          return this.runInspectionOperation(
            owner,
            () => this.checkInclusionsOwned(captured, owner, cycle),
            cycle,
          );
      },

      finish: () => this.finishInspection(owner),

      abandon: () => this.abandonInspection(owner),
    });
  }

  /**
   * Chain identity used by the signer journal and transaction signing.
   */
  get chainId(): number {
    return this.identity.chainId;
  }

  get attempts(): readonly AttemptSummary[] {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return Object.freeze([]);
    }
    
    return Object.freeze(current.snapshot.attempts.map((attempt) => {
      const [first, ...remaining] = attempt.signedTransactions;

      const transactionHashes: readonly [Hash, ...Hash[]] = Object.freeze([
        first.transactionHash,
        ...remaining.map((transaction) => transaction.transactionHash),
      ]);

      return Object.freeze({
        attemptId: attempt.attemptId,
        workId: attempt.workId,
        nonce: attempt.nonce,
        phase: attempt.phase,
        transactionHashes,
      });
    }));
  }

  /**
   * Manager-internal: isolation relies on the manager exclusively owning
   * this coordinator, rather than private visibility.
   * 
   * Check acknowledged state first because a failed broadcast-marker
   * write does not undo an acknowledged preparation. That attempt remains
   * retained even while its marker snapshot awaits persistence retry.
   */
  captureSubmissionRecording(
    workId: string,
  ): SubmissionRecording {
    const current = this.persistence.current;

    if (current.kind === 'present') {
      const retained = current.snapshot.attempts.find(
        (attempt) => attempt.workId === workId,
      );

      if (retained !== undefined) {
        return Object.freeze({
          status: 'retained',
          attempt: Object.freeze({
            workId: retained.workId,
            attemptId: retained.attemptId,
          }),
        });
      }
    }

    if (this.pendingWrite?.kind === 'prepared') {
      const attempt =
        this.persistence.failedWriteAttemptIdentity(workId);

      if (attempt !== undefined) {
        return Object.freeze({
          status: 'uncertain',
          attempt,
        });
      }
    }

    return Object.freeze({
      status: 'none',
    });
  }

  /**
   * Whether a journal snapshot has been loaded or durably persisted.
   */
  get journalInitialized(): boolean {
    return this.persistence.current.kind === 'present';
  }

  /** Returns only acknowledged history, including after persistence retry. */
  operatorOutcome(
    requestId: string,
  ) {
    const current = this.persistence.current;

    if (current.kind === 'missing') {
      return undefined;
    }

    return current.snapshot.ledger.outcomes.find((row) => row.requestId === requestId);
  }

  /**
   * Determine whether the oldest unresolved attempt was a one-use
   * broadcast permit.
   */
  get canBroadcast(): boolean {
    const current = this.persistence.current;

    if (
      this.busy ||
      this.emitting ||
      this.pendingWrite !== undefined ||
      this.inspectionOwner !== null ||
      this.persistence.state !== 'idle' ||
      current.kind !== 'present'
    ) {
      return false;
    }

    const attempt = current.snapshot.attempts.find(
      (candidate) => candidate.phase !== 'included'
    );

    if (attempt === undefined) {
      return false;
    }

    return (
      this.recoveryComplete &&
      this.broadcastPermit === attempt.attemptId &&
      this.blockers.size === 0 &&
      current.snapshot.lastObservation.nonce === attempt.nonce
    );
  }

  get status() {
    const gate = evaluateSignerGate({
      persistence: this.persistence,
      recoveryComplete: this.recoveryComplete,
      inclusionChecksComplete: this.inclusionChecksComplete,
      maxRetainedAttempts: this.maxRetainedAttempts,
      blockers: this.blockers,
    });

    return Object.freeze({
      ...gate,
      open: 
        gate.open &&
        !this.busy &&
        this.inspectionOwner === null,
      recoveryComplete: this.recoveryComplete,
      inclusionChecksComplete: this.inclusionChecksComplete,
      persistenceState: this.persistence.state,
      blockedSince: this.gateDiagnostics.blockedSince,
    });
  }

  /**
   * Deterministic representation of committed state relevant to durable
   * recovery. Equal content produces the same value across writes.
   */
  get durableRecoveryRevision(): string {
    return this.committedDurableRecoveryRevision;
  }

  /**
   * Signs and durably appends the next allocated transaction. Retained
   * attempts remain available for recovery and diagnostics.
   */
  async prepareAttempt(
    options: PrepareAttemptOptions,
    cycle?: number,
  ): Promise<PrepareAttemptResult> {
    this.assertAvailable();
    this.assertPersistenceIdle();

    const current = this.persistence.current;

    if (
      !this.status.open ||
      current.kind !== 'present'
    ) {
      throw new Error(
        'The signer gate must be open before preparing an attempt.'
      );
    }

    const workId = options.workId;
    if (!isWorkId(workId)) {
      throw new TypeError('Invalid work identity.');
    }

    const retained = current.snapshot.attempts.find(
      (attempt) => attempt.workId === workId,
    );

    if (retained !== undefined) {
      // No state changed. This result neither grants nor consumes
      // broadcast authorization.
      return Object.freeze({
        status: 'already-retained',
        attemptId: retained.attemptId,
        workId,
      });
    }

    const previousAttemptLog = this.attemptLog;
    const previousBlockedSince = this.gateDiagnostics.blockedSince;
    const previousInclusionChecksComplete = this.inclusionChecksComplete;

    this.broadcastPermit = undefined;
    this.busy = true;

    try {
      const attemptId = randomUUID();
      const createdAt = this.timestamp();

      const signed = await signPreparedTransaction({
        identity: this.identity,
        nonce: current.snapshot.nextNonce,
        account: options.account,
        transaction: options.transaction,
      });

      this.attemptLog = this.createSignedAttemptLog(
        current.snapshot.attempts,
        signed.signedTransaction,
      );

      const next = planAttemptPreparation({
        identity: this.identity,
        snapshot: current.snapshot,
        attemptId,
        workId,
        createdAt,
        signed,
      });

      this.gateDiagnostics.blockedSince ??= createdAt;
      this.inclusionChecksComplete = false;
      this.stageWrite({ kind: 'prepared' });

      await this.persistence.save(next);

      this.applyCommittedWrite(cycle);
      this.broadcastPermit = attemptId;

      return Object.freeze({
        status: 'prepared',
        attemptId,
        transactionHash: signed.transactionHash,
        nonce: signed.nonce,
      });
    } catch (error) {
      const unacknowledged =
        this.persistence.state === 'idle' &&
        this.persistence.current === current;

      if (unacknowledged) {
        this.discardUnacknowledgedWrite(current);
        
        // Restore the previous queue's policy and authorization only
        // when this operation did not acknowledge a new journal state.
        this.attemptLog = previousAttemptLog;
        this.gateDiagnostics.blockedSince = previousBlockedSince;
        this.inclusionChecksComplete = previousInclusionChecksComplete;
      } else {
        // Retain protection for newly signed bytes after acknowledgement
        // or an uncertain write, and require fresh recovery.
        this.invalidateRecoveryAuthorization();
        this.discardUnacknowledgedWrite(current);
      }

      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle, 'prepare-attempt');
    }
  }

  /**
   * Broadcasts the latest recorded signed transaction for the oldest
   * unresolved attempt after durably marking that broadcast may occur.
   */
  async broadcastAttempt(
    options: BroadcastAttemptOptions,
    cycle?: number,
  ): Promise<BroadcastAttemptResult> {
    this.assertAvailable();
    this.assertPersistenceIdle();

    const current = this.persistence.current;

    if (current.kind !== 'present') {
      throw new Error('Broadcast does not match a recorded attempt.');
    }

    const attemptIndex = current.snapshot.attempts.findIndex(
      (candidate) => candidate.phase !== 'included',
    );

    const attempt = current.snapshot.attempts[attemptIndex];

    if (
      attempt === undefined ||
      options.attemptId !== attempt.attemptId
    ) {
      throw new Error('Broadcast does not match a recorded attempt.');
    }

    if (!this.canBroadcast) {
      throw new Error('Fresh reconciliation is required before broadcasting.');
    }

    const transaction =
      attempt.signedTransactions[attempt.signedTransactions.length - 1]!;

    const publicClient = options.publicClient;

    this.invalidateRecoveryAuthorization();
    this.busy = true;

    try {
      if (attempt.phase === 'signed') {
        this.stageWrite({ kind: 'broadcast' });

        await this.persistence.save({
          ...current.snapshot,
          attempts: current.snapshot.attempts.map((candidate, index) => 
            index === attemptIndex
              ? {
                  ...candidate,
                  phase: 'broadcast-may-have-occurred',
                  inclusion: null,
                }
              : candidate,
          ),
        });

        this.completeCommittedWrite(cycle);
      }

      const identity = {
        signer: this.identity.signer,
        attemptId: attempt.attemptId,
        transactionHash: transaction.transactionHash,
        nonce: attempt.nonce,
      };

      const result = await broadcastSignedTransaction({
        publicClient,
        signedTransaction: transaction.signedTransaction,
        transactionHash: transaction.transactionHash,
      });

      if (result.status === 'not-acknowledged') {
        this.emit(
          (log) => log.attemptBroadcastNotAcknowledged({
            ...identity,
            ...result.failure,
          }),
          cycle,
          'broadcast-attempt',
        );

        return Object.freeze({
          status: 'not-acknowledged',
          attemptId: attempt.attemptId,
          transactionHash: transaction.transactionHash,
          nonce: attempt.nonce,
        });
      }

      this.emit(
        (log) => log.attemptBroadcastAccepted(identity),
        cycle,
        'broadcast-attempt',
      );

      return Object.freeze({
        status: 'acknowledged',
        attemptId: attempt.attemptId,
        transactionHash: transaction.transactionHash,
        nonce: attempt.nonce,
      });
    } catch (error) {
      this.discardUnacknowledgedWrite(current);
      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle, 'broadcast-attempt');
    }
  }

  /**
   * Reconciles the signer against a durable block and saves the resulting
   * observation, resolution, or search progress together. Keeps other
   * coordinator operations out until inspection and persistence finish.
   * A failed write must be retried before a fresh recovery pass can proceed.
   */
  async recover(
    options: RecoverSignerOptions,
    cycle?: number,
  ): Promise<SignerRecoveryResult> {
    return this.runStandaloneInspection(
      (inspection) => inspection.recover(options, cycle),
    );
  }

  private async recoverOwned(
    options: RecoverSignerOptions,
    owner: InspectionOwner,
    cycle?: number,
  ): Promise<SignerRecoveryResult> {
    this.assertAvailable(owner);

    const { maxBlockRange } = options;

    if (
      typeof maxBlockRange !== 'bigint' ||
      maxBlockRange <= 0n ||
      maxBlockRange >= (1n << 256n)
    ) {
      throw new TypeError('Invalid signer recovery input.');
    }

    this.assertPersistenceIdle();

    const current = this.persistence.current;

    if (options.attribution !== undefined) {
      validateAttributionRequest(options.attribution);
    }

    const commitment = options.attributionCommitment;

    if (commitment !== undefined && (
      options.attribution === undefined ||
      current.kind !== 'present' ||
      journalSnapshotDigest(current.snapshot) !== commitment.snapshotDigest
    )) {
      return {
        status: 'operator-ticket-refused',
        reason: 'snapshot-changed',
      };
    }

    this.invalidateRecoveryAuthorization();
    this.busy = true;

    try {
      if (owner.bracket !== null) {
        const bracket = owner.bracket;

        if (
          bracket.publicClient !== options.publicClient ||
          bracket.durableAnchor === undefined ||
          !blockAnchorsMatch(bracket.durableAnchor, options.anchor)
        ) {
          throw new Error('Recovery does not match the inspection anchors.');
        }

        const changed = await this.openInspectionBracket(owner);

        if (changed !== null) {
          return {
            status: 'anchor-changed',
            observedAnchor: changed,
          };
        }
      }

      if (current.kind === 'missing') {
        if (options.attribution !== undefined) {
          throw new Error('Operator attribution requires a retained attempt.');
        }

        return await this.bootstrapOwned(options, owner, cycle);
      }
      
      const result = await inspectSignerRecovery({
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        anchor: options.anchor,
        maxBlockRange: options.maxBlockRange,
        ...(options.attribution === undefined ? {} : {
          hint: options.attribution.hint,
        }),
      });

      if (
        'observation' in result &&
        !this.observeInspectionDurableNonce(owner, result.observation)
      ) {
        return {
          status: 'inconsistent-observations',
          observation: result.observation,
        };
      }

      const plan = planSignerRecovery({
        identity: this.identity,
        snapshot: current.snapshot,
        inspection: result,
        ...(options.attribution === undefined ? {} : {
          attribution: options.attribution,
        }),
        unattributedActivity:
          this.blockers.has('unattributed-signer-activity'),
      });

      // Admit only after nonce validation and planning. A preservation-only
      // skip still carries valid evidence, even though recovery stays incomplete.
      if (
        (
          plan.kind === 'persist' ||
          plan.reason === 'preserved-higher-observation'
        ) &&
        'observations' in result &&
        !this.admitDurableBlockObservations(owner, result.observations)
      ) {
        this.failInspectionBracket(owner);
        return {
          status: 'inconsistent-observations',
          observation: result.observation,
        };
      }

      if (plan.kind === 'unchanged') {
        this.failInspectionBracket(owner);

        if (result.status === 'operator-attribution-available') {
          let reason: 'ledger-capacity-reached' | 'stale-evidence' = 'stale-evidence';

          if (plan.reason === 'ledger-capacity-reached') {
            reason = plan.reason;
          }

          return {
            status: 'operator-hint-refused',
            observation: result.observation,
            reason,
          };
        }

        return result;
      }

      // Ticketed apply may commit only the exact attribution previewed earlier.
      // In particular, a newly available ordinary resolution is not that proposal.
      if (commitment !== undefined && (
        plan.completion.kind !== 'operator-attribution' ||
        plan.completion.outcome.proposalDigest !== commitment.proposalDigest ||
        !blockAnchorsMatch(plan.completion.outcome.replacement.inclusion, commitment.inclusion) ||
        !blockAnchorsMatch(plan.completion.outcome.durable.anchor, commitment.durable.anchor) ||
        plan.completion.outcome.durable.nonce !== commitment.durable.nonce
      )) {
        this.failInspectionBracket(owner);

        return {
          status: 'operator-ticket-refused',
          reason: 'proposal-changed',
        };
      }

      this.stageWrite(plan.completion);

      await this.persistence.save(plan.snapshot);

      const terminalCorrection =
        plan.completion.kind === 'operator-attribution' ||
        plan.completion.kind === 'search-unconsumed-bound-rebase' ||
        plan.completion.kind === 'search-reset' ||
        plan.completion.kind === 'search-lower-bound-replacement';
      this.recoveryComplete = !terminalCorrection;
      this.applyCommittedWrite(cycle);
      if (terminalCorrection) {
        this.failInspectionBracket(owner);
      }

      if (plan.completion.kind === 'operator-attribution') {
        return {
          status: 'operator-attribution-committed',
          requestId: plan.completion.outcome.requestId,
        };
      }

      const inspectedAttempt = current.snapshot.attempts[0];

      if (
        result.status === 'unresolved' &&
        inspectedAttempt !== undefined &&
        inspectedAttempt.phase !== 'included' &&
        result.observation.nonce === inspectedAttempt.nonce &&
        result.search === null &&
        this.blockers.size === 0 &&
        (
          result.receipt.status === 'receipt-not-found' ||
          result.receipt.status === 'fork-served-receipt'
        )
      ) {
        this.broadcastPermit = inspectedAttempt.attemptId;
      }

      return result;
    } catch (error) {
      this.recoveryComplete = false;
      this.failInspectionBracket(owner);
      this.discardUnacknowledgedWrite(current);
      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle);
    }
  }

  /**
   * Persists a complete inclusion inspection without advancing either nonce
   * counter or removing retained attempts.
   * 
   * Inclusion authorization becomes available only after persistence
   * succeeds. Retrying a failed write requires another inspetion before
   * preparation can resume.
   */
  async checkInclusions(
    options: CheckSignerInclusionsOptions,
    cycle?: number,
  ): Promise<SignerInclusionInspection> {
    const inspection = this.beginInspection();

    try {
      const result = await inspection.checkInclusions(options, cycle);

      if (result.status === 'inspected') {
        inspection.finish();
      } else {
        await inspection.abandon();
      }

      return result;
    } catch (error) {
      await inspection.abandon();
      throw error;
    }
  }

  private async checkInclusionsOwned(
    options: CheckSignerInclusionsOptions,
    owner: InspectionOwner,
    cycle?: number,
  ): Promise<SignerInclusionInspection> {
    this.assertAvailable(owner);
    this.assertPersistenceIdle();

    const current = this.persistence.current;

    if (current.kind !== 'present') {
      throw new Error(
        'Cannot check inclusions without an initialized journal.'
      )
    }

    this.revokeActionAuthorization();
    this.busy = true;

    try {
      if (owner.bracket === null) {
        owner.bracket = this.createInspectionBracket(options);
      }

      const bracket = owner.bracket;

      if (
        bracket.publicClient !== options.publicClient ||
        !blockAnchorsMatch(bracket.head, options.head)
      ) {
        throw new Error('Inclusion inspection does not match the selected head.');
      }

      const changed = await this.openInspectionBracket(owner);

      if (changed !== null) {
        return {
          status: 'anchor-changed',
          observedAnchor: changed,
        };
      }

      if (bracket.durableAnchor !== undefined && !this.recoveryComplete) {
        throw new Error(
          'Fresh durable recovery must complete before latest inspection.',
        );
      }

      bracket.phase = 'latest';

      const maxReplacementBlockRange = options.maxReplacementBlockRange;

      const inspectionOptions = {
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        head: options.head,
        ...(maxReplacementBlockRange === undefined
          ? {}
          : { maxReplacementBlockRange }),
      };

      const result = await inspectSignerInclusions(inspectionOptions);

      if (result.status !== 'inspected') {
        this.failInspectionBracket(owner);

        if (
          result.status === 'nonce-behind-journal' ||
          result.status === 'inconsistent-observations'
        ) {
          this.recoveryComplete = false;
        }

        return result;
      }

      // Keep the result uncommitted until the owner confirms that the selected
      // latest block still matches the hash checked before the inspection.
      bracket.phase = 'closing';

      const closing = await checkBlockAnchor(
        options.publicClient,
        bracket.head,
        { operation: 'signer-inclusions' },
      );

      this.assertInspectionContinuing(owner);

      if (closing !== null) {
        this.failInspectionBracket(owner);
        return closing;
      }

      if (
        bracket.durableNonce !== undefined &&
        result.observation.nonce < bracket.durableNonce
      ) {
        this.recoveryComplete = false;
        this.failInspectionBracket(owner);
        return {
          status: 'inconsistent-observations',
          observation: result.observation,
        };
      }

      // Check repeated heights within the latest pass as well as overlaps with
      // durable evidence. This runs after the closing check, before planning.
      const latestEvidence = this.mergeBlockObservations(
        bracket.durableObservations,
        result.observations,
      );

      if (latestEvidence === null) {
        this.recoveryComplete = false;
        this.failInspectionBracket(owner);
        return {
          status: 'inconsistent-observations',
          observation: result.observation,
        };
      }

      bracket.phase = 'persisting';

      const next = planSignerInclusions({
        identity: this.identity,
        snapshot: current.snapshot,
        inspection: result,
        unattributedActivity:
          this.blockers.has('unattributed-signer-activity'),
      });

      this.stageWrite({ kind: 'observation' });

      await this.persistence.save(next);

      this.inclusionChecksComplete = result.inclusionChecksComplete;
      this.applyCommittedWrite(cycle);

      const attempt = next.attempts.find(
        (candidate) => candidate.phase !== 'included',
      );

      if (
        this.recoveryComplete &&
        this.blockers.size === 0 &&
        attempt !== undefined &&
        result.broadcastAttemptId === attempt.attemptId &&
        next.lastObservation.nonce === attempt.nonce
      ) {
        this.broadcastPermit = attempt.attemptId;
      }

      // The durable permit was revoked on entry. Only the acknowledged latest
      // result above may grant a replacement permit before successful finish.
      bracket.phase = 'completed';

      return result;
    } catch (error) {
      this.inclusionChecksComplete = false;
      this.failInspectionBracket(owner);
      this.discardUnacknowledgedWrite(current);
      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle);
    }
  }

  /**
   * Creates diagnostic protedction for every retained signed transaction
   * and, during preparation, the newly signed transaction.
   */
  private createSignedAttemptLog(
    attempts: readonly JournalAttempt[],
    additionalSignedTransaction?: Hex,
  ): ScopedRelayerLog {
    const signedTransactions = attempts.flatMap((attempt) => 
      attempt.signedTransactions.map(
        (transaction) => transaction.signedTransaction,
      ),
    );

    if (additionalSignedTransaction !== undefined) {
      signedTransactions.push(additionalSignedTransaction);
    }

    try {
      return this.log.withErrorSummary(
        this.createErrorSummary(signedTransactions),
      );
    } catch {
      throw new Error('Could not configure signed attempt diagnostics.');
    }
  }

  /**
   * Publishes gate transitions after a complete reconciliation operation.
   */
  async observeReconciliation<T>(
    action: () => Promise<T>,
    cycle?: number,
  ): Promise<T> {
    if (this.reconciliationObservationActive) {
      throw new Error('Signer reconciliation observation is already active.');
    }

    this.assertAvailable();
    this.reconciliationObservationActive = true;

    try {
      return await action();
    } finally {
      this.reconciliationObservationActive = false;
      this.refresh(cycle);
    }
  }

  /**
   * Establishes the first durable nonce baseline.
   */
  private async bootstrapOwned(
    options: RecoverSignerOptions,
    owner: InspectionOwner,
    cycle?: number,
  ): Promise<SignerRecoveryResult> {
    if (this.blockers.size !== 0) {
      throw new Error('Cannot bootstrap while coordinator blockers remain.');
    }

    const result = await inspectSignerBootstrap({
      publicClient: options.publicClient,
      signer: this.identity.signer,
      anchor: options.anchor,
    });

    if (
      'observation' in result &&
      !this.observeInspectionDurableNonce(owner, result.observation)
    ) {
      return {
        status: 'inconsistent-observations',
        observation: result.observation,
      };
    }

    if (result.status === 'bootstrap-deferred') {
      this.failInspectionBracket(owner);
      const {
        observation,
        latestNonce,
        pendingNonce,
      } = result;

      const previous = this.lastBootstrapDeferral;

      if (
        previous === undefined ||
        previous.durableNonce !== observation.nonce ||
        previous.latestNonce !== latestNonce ||
        previous.pendingNonce !== pendingNonce
      ) {
        this.lastBootstrapDeferral = {
          durableNonce: observation.nonce,
          latestNonce,
          pendingNonce,
        };

        this.emit(
          (log) => log.signerBootstrapDeferred({
            signer: this.identity.signer,
            durableBlock: observation.anchor.blockNumber,
            durableBlockHash: observation.anchor.blockHash,
            durableNonce: observation.nonce,
            latestNonce,
            pendingNonce,
          }),
          cycle,
        );
      }

      return result;
    }

    if (result.status === 'anchor-changed') {
      this.failInspectionBracket(owner);
      return result;
    }

    this.lastBootstrapDeferral = undefined;

    const { observation } = result;

    this.stageWrite({ kind: 'bootstrap' });

    await this.persistence.save({
      version: 1,
      identity: this.identity,
      baseline: observation,
      lastObservation: observation,
      nextNonce: observation.nonce,
      durableNextNonce: observation.nonce,
      repairs: [],
      ledger: {
        outcomes: [],
        obligations: [],
      },
      attempts: [],
    });

    this.recoveryComplete = true;
    this.applyCommittedWrite(cycle);

    return {
      status: 'no-attempt',
      observations: Object.freeze([]),
      observation,
    };
  }

  private createInspectionBracket(
    options: OpenSignerInspectionOptions,
  ): InspectionBracket {
    const head = Object.freeze({ ...options.head });
    const durable = options.durableAnchor;

    if (
      typeof head.blockNumber !== 'bigint' ||
      head.blockNumber < 0n ||
      head.blockNumber >= (1n << 256n) ||
      !isFixedHex(head.blockHash, 32) ||
      (
        durable !== undefined &&
        (
          typeof durable.blockNumber !== 'bigint' ||
          durable.blockNumber < 0n ||
          !isFixedHex(durable.blockHash, 32) ||
          head.blockNumber < durable.blockNumber ||
          (
            head.blockNumber === durable.blockNumber &&
            !blockAnchorsMatch(head, durable)
          )
        )
      )
    ) {
      throw new TypeError('Invalid signer inspection anchors.');
    }

    return {
      publicClient: options.publicClient,
      head,
      durableAnchor: durable === undefined
        ? undefined
        : Object.freeze({ ...durable }),
      durableNonce: undefined,
      durableObservations: new Map(),
      phase: 'opening',
    };
  }

  private assertInspectionContinuing(owner: InspectionOwner): void {
    this.assertInspectionOwner(owner);

    if (owner.abandoning) {
      throw new Error('Signer inspection is being abandoned.');
    }
  }

  private async openInspectionBracket(
    owner: InspectionOwner,
  ): Promise<Readonly<BlockAnchor> | null> {
    const bracket = owner.bracket!;

    if (bracket.phase === 'durable') {
      return null;
    }

    if (bracket.phase !== 'opening') {
      throw new Error('Signer inspection bracket cannot accept another operation.');
    }

    const changed = await checkBlockAnchor(
      bracket.publicClient,
      bracket.head,
      { operation: 'signer-inclusions' },
    );

    this.assertInspectionContinuing(owner);

    if (changed !== null) {
      this.failInspectionBracket(owner);
      return changed.observedAnchor;
    }

    bracket.phase = 'durable';
    return null;
  }

  /**
   * Compare signer nonces observed at the same durable recovery anchor before
   * planning a journal change, including observations the planner would skip.
   */
  private observeInspectionDurableNonce(
    owner: InspectionOwner,
    observation: AnchoredNonceObservation,
  ): boolean {
    const bracket = owner.bracket;

    if (bracket === null) {
      return true;
    }

    if (
      bracket.durableAnchor === undefined ||
      !blockAnchorsMatch(bracket.durableAnchor, observation.anchor)
    ) {
      throw new Error('Durable observation does not match the inspection anchor.');
    }

    if (bracket.durableNonce === undefined) {
      bracket.durableNonce = observation.nonce;
      return true;
    }

    if (bracket.durableNonce !== observation.nonce) {
      this.recoveryComplete = false;
      this.failInspectionBracket(owner);
      return false;
    }

    return true;
  }

  /** Matching repeats are allowed. Different hashes at one height fail closed. */
  private mergeBlockObservations(
    previous: ReadonlyMap<bigint, Hash>,
    observations: readonly Readonly<BlockAnchor>[],
  ): ReadonlyMap<bigint, Hash> | null {
    const merged = new Map(previous);

    for (const observation of observations) {
      const known = merged.get(observation.blockNumber);

      if (
        known !== undefined &&
        known.toLowerCase() !== observation.blockHash.toLowerCase()
      ) {
        return null;
      }

      merged.set(observation.blockNumber, observation.blockHash);
    }

    return merged;
  }

  private admitDurableBlockObservations(
    owner: InspectionOwner,
    observations: readonly Readonly<BlockAnchor>[],
  ): boolean {
    const bracket = owner.bracket;

    // Standalone durable recovery has no enclosing latest-block interval.
    // Its observations must not seed a bracket opened later on this handle.
    if (bracket === null) {
      return true;
    }

    const merged = this.mergeBlockObservations(
      bracket.durableObservations,
      observations,
    );

    if (merged === null) {
      return false;
    }

    // No rollback is needed if persistence fails: the failed bracket cannot
    // continue, and abandonment discards this inspection's evidence entirely.
    bracket.durableObservations = merged;
    return true;
  }

  private failInspectionBracket(owner: InspectionOwner): void {
    if (owner.bracket !== null) {
      owner.bracket.phase = 'failed';
      this.revokeActionAuthorization();
    }
  }

  private revokeActionAuthorization(): void {
    this.broadcastPermit = undefined;
    this.inclusionChecksComplete = false;
  }

  private invalidateRecoveryAuthorization(): void {
    this.recoveryComplete = false;
    this.revokeActionAuthorization();
  }

  private assertInspectionOwner(
    owner: InspectionOwner,
  ): void {
    if (this.inspectionOwner !== owner) {
      throw new Error('Signer inspection is no longer active.');
    }
  }

  private async runInspectionOperation<T>(
    owner: InspectionOwner,
    operation: () => Promise<T>,
    cycle?: number,
  ): Promise<T> {
    this.assertAvailable(owner);

    if (owner.activeOperation !== null) {
      throw new Error('Signer inspection operation is already in progress.');
    }

    owner.cycle = cycle;

    // Register before execution so abandonment also covers queued work.
    const pending = Promise.resolve().then(() => {
      this.assertAvailable(owner);
      return operation();
    });

    owner.activeOperation = pending;

    try {
      return await pending;
    } finally {
      owner.activeOperation = null;
    }
  }

  private finishInspection(
    owner: InspectionOwner,
  ): void {
    this.assertInspectionOwner(owner);

    if (owner.abandoning) {
      throw new Error('Signer inspection is being abandoned.');
    }

    if (owner.activeOperation !== null) {
      throw new Error('Signer inspection operation is still running.');
    }

    if (this.busy || this.emitting) {
      throw new Error('Signer coordinator operation is already in progress.');
    }

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('Signer inspection has pending persistence.');
    }

    if (owner.bracket !== null && owner.bracket.phase !== 'completed') {
      throw new Error(
        'Signer inspection bracket has not completed successfully.',
      );
    }

    if (owner.bracket !== null) {
      owner.bracket.durableObservations = new Map();
    }

    this.inspectionOwner = null;
    this.refresh(owner.cycle);
  }

  private async abandonInspection(
    owner: InspectionOwner,
  ): Promise<void> {
    this.assertInspectionOwner(owner);

    if (owner.abandonment !== null) {
      return owner.abandonment;
    }

    owner.abandoning = true;
    this.revokeActionAuthorization();

    const pending = owner.activeOperation;

    owner.abandonment = this.completeAbandonment(owner, pending);
    return owner.abandonment;
  }

  private async completeAbandonment(
    owner: InspectionOwner,
    pending: Promise<unknown> | null,
  ): Promise<void> {
    if (pending !== null) {
      try {
        await pending;
      } catch {
        // The operation's caller recieves its failure. Abandonment must
        // release ownership after either settlement outcome.
      }
    }

    // Ownership cannot be replaced while abandonment awaits settlement.
    // Failure here is an internal lifecycle invariant violation.
    this.assertInspectionOwner(owner);

    this.revokeActionAuthorization();

    if (owner.bracket !== null) {
      owner.bracket.durableObservations = new Map();
    }

    this.inspectionOwner = null;
    this.refresh(owner.cycle);
  }

  private stageWrite(
    completion: PendingWrite,
  ): void {
    if (this.pendingWrite !== undefined) {
      throw new Error('A journal write is already signed.');
    }

    this.pendingWrite = completion;
  }

  /**
   * Discards completion metadata only when persistence is idle and
   * no new journal state was acknowledged during this operation.
   */
  private discardUnacknowledgedWrite(
    previousCommitted: TransactionJournalRead,
  ): void {
    if (
      this.pendingWrite === undefined ||
      this.persistence.state !== 'idle'
    ) {
      return;
    }

    if (this.persistence.current !== previousCommitted) {
      throw new Error(
        'Journal persistence was acknowledged, but coordinator completion failed. ' +
        'The committed journal is retained. ' +
        'Restart the relayer to reload it and run recovery; ' +
        'persistence retry is unavailable.'
      );
    }

    this.pendingWrite = undefined;
  }

  private applyCommittedWrite(
    cycle?: number,
  ): SignerEventOperation {
    const operation = this.completeCommittedWrite(cycle);

    this.refresh(cycle, operation);

    return operation;
  }

  private completeCommittedWrite(
    cycle?: number
  ): SignerEventOperation {
    const pending = this.pendingWrite!;

    if (pending.kind === 'resolution') {
      // Keep ownership and the signed-byte diagnostic policy through
      // resolution reporting.
      this.emit(
        (log) => log.attemptResolved(pending.event),
        cycle,
      );
    }

    if (pending.kind === 'operator-attribution') {
      this.invalidateRecoveryAuthorization();

      const outcome = pending.outcome;

      this.emit((log) => log.attemptOperatorAttributed({
        signer: this.identity.signer,
        requestId: outcome.requestId,
        attemptId: outcome.attemptId,
        transactionHash: outcome.replacement.transactionHash,
        nonce: outcome.nonce,
        durableBlock: outcome.durable.anchor.blockNumber,
        durableBlockHash: outcome.durable.anchor.blockHash,
        supersededNoMatch: supersedesNoMatch(outcome),
      }), cycle);
    }

    if (pending.kind === 'search-reset') {
      this.invalidateRecoveryAuthorization();
      this.emit((log) => log.searchReset(pending.event), cycle);
    }

    if (pending.kind === 'search-unconsumed-bound-rebase') {
      this.invalidateRecoveryAuthorization();

      const {
        evidence,
        observation,
        signer,
        attemptId,
        nonce,
      } = pending.event;

      this.emit((log) => log.searchUnconsumedBoundRebased({
        signer,
        attemptId,
        nonce,
        oldLowerBlock: evidence.lowerBound.anchor.blockNumber,
        oldLowerBlockHash: evidence.lowerBound.anchor.blockHash,
        oldLowerNonce: evidence.lowerBound.nonce,
        observedLowerBlockHash: evidence.observedLower.blockHash,
        durableBlock: observation.anchor.blockNumber,
        durableBlockHash: observation.anchor.blockHash,
        durableNonce: observation.nonce,
        invalidatedFact: {
          expectedBlock: evidence.fact.anchor.blockNumber,
          expectedBlockHash: evidence.fact.anchor.blockHash,
          observedBlock: evidence.observedFact.blockNumber,
          observedBlockHash: evidence.observedFact.blockHash,
        },
      }), cycle);
    }

    if (pending.kind === 'search-lower-bound-replacement') {
      this.invalidateRecoveryAuthorization();
      const event = pending.event;
      let invalidatedFact = null;
      if (event.invalidatedFact !== null) {
        invalidatedFact = {
          expectedBlock: event.invalidatedFact.fact.anchor.blockNumber,
          expectedBlockHash: event.invalidatedFact.fact.anchor.blockHash,
          observedBlock: event.invalidatedFact.observedAnchor.blockNumber,
          observedBlockHash: event.invalidatedFact.observedAnchor.blockHash,
        };
      }
      this.emit((log) => log.searchLowerBoundReplaced({
        signer: event.signer,
        attemptId: event.attemptId,
        nonce: event.nonce,
        oldLowerBlock: event.oldLowerBound.anchor.blockNumber,
        oldLowerBlockHash: event.oldLowerBound.anchor.blockHash,
        oldLowerNonce: event.oldLowerBound.nonce,
        observedLowerBlock: event.observedLower.blockNumber,
        observedLowerBlockHash: event.observedLower.blockHash,
        replacementBlock: event.replacement.anchor.blockNumber,
        replacementBlockHash: event.replacement.anchor.blockHash,
        replacementNonce: event.replacement.nonce,
        durableBlock: event.durableObservation.anchor.blockNumber,
        durableBlockHash: event.durableObservation.anchor.blockHash,
        durableNonce: event.durableObservation.nonce,
        probeCount: BigInt(event.probeCount),
        invalidatedFact,
      }), cycle);
    }

    this.pendingWrite = undefined;

    this.latchUnattributedActivity();
    this.reconcileExhaustedSearch();
    this.updateDurableRecoveryRevision();

    let operation: SignerEventOperation = 'reconcile-attempt';

    if (pending.kind === 'prepared') {
      operation = 'prepare-attempt';
    } else if (pending.kind === 'broadcast') {
      operation = 'broadcast-attempt';
    }

    return operation;
  }

  private latchUnattributedActivity(): void {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return;
    }

    if (
      current.snapshot.lastObservation.nonce >
      current.snapshot.nextNonce
    ) {
      this.blockers.add('unattributed-signer-activity');
    }
  }

  private reconcileExhaustedSearch(): void {
    const current = this.persistence.current;
    const exhausted = current.kind === 'present' &&
      current.snapshot.attempts.some((attempt) =>
        attempt.replacementSearch !== null &&
        attempt.replacementSearch.exhausted !== null,
      );

    if (exhausted) {
      this.blockers.add('conflict-search-exhausted');
    } else {
      this.blockers.delete('conflict-search-exhausted');
    }
  }

  /**
   * Retries the retained journal snapshot after a persistence failure,
   * then applies the corresponding observation or resolution transition.
   */
  async retryPersistence(
    cycle?: number,
  ): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite === undefined ||
      this.persistence.state !== 'failed'
    ) {
      throw new Error('No failed journal write is available to retry.');
    }

    const previousCommitted = this.persistence.current;
    let operation: SignerEventOperation = 'reconcile-attempt';

    this.busy = true;

    try {
      await this.persistence.retry();

      operation = this.applyCommittedWrite(cycle);
    } catch (error) {
      this.discardUnacknowledgedWrite(previousCommitted);
      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle, operation);
    }
  }

  /**
   * Publishes gate transitions and then releases signed-byte diagnostic
   * protection when the signer is open and no attempts remain.
   */
  private refresh(
    cycle?: number,
    operation: SignerEventOperation = 'reconcile-attempt',
  ): void {
    if (this.reconciliationObservationActive) {
      return;
    }

    const status = this.status;

    this.gateDiagnostics.observe(status, (event) => {
      this.emit((log) => {
        if (event.kind === 'blocked') {
          log.signerBlocked({
            signer: this.identity.signer,
            reason: event.reason,
            blockers: event.blockers,
            blockedSince: event.blockedSince,
          });

          return;
        }

        log.signerGateReleased({
          signer: this.identity.signer,
          cleared: event.cleared,
          blockedSince: event.blockedSince,
        });
      }, cycle, operation);
    });

    const current = this.persistence.current;

    // Keep signed-byte protection trhough gate publication, including
    // logging-failure reporting, before releasing the attempt logger.
    if (
      status.open &&
      this.pendingWrite === undefined &&
      current.kind === 'present' &&
      current.snapshot.attempts.length === 0
    ) {
      this.attemptLog = undefined;
    }
  }

  /**
   * Runs one operation in a dedicated inspection.
   */
  private async runStandaloneInspection<T>(
    action: (inspection: SignerInspection) => Promise<T>,
  ): Promise<T> {
    const inspection = this.beginInspection();

    try {
      const result = await action(inspection);
      inspection.finish();
      return result;
    } catch (error) {
      await inspection.abandon();
      throw error;
    }
  }

  private updateDurableRecoveryRevision(): void {
    this.committedDurableRecoveryRevision = computeDurableRecoveryRevision(
      this.persistence.current,
      this.blockers,
    );
  }

  private assertAvailable(
    owner?: InspectionOwner,
  ): void {
    if (owner === undefined) {
      if (this.inspectionOwner !== null) {
        throw new Error('Signer inspection is already in progress.');
      }
    } else {
      this.assertInspectionOwner(owner);

      if (owner.abandoning) {
        throw new Error('Signer inspection is being abandoned.');
      }
    }

    if (this.busy || this.emitting) {
      throw new Error('Signer coordinator operation is already in progress.');
    }
  }

  private assertPersistenceIdle(): void {
    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }
  }

  private emit(
    action: (log: ScopedRelayerLog) => void,
    cycle?: number,
    operation: SignerEventOperation = 'reconcile-attempt',
  ): void {
    const log = this.attemptLog ?? this.log;
    this.emitting = true;

    let failureLog = log;

    try {
      let scoped = log.withContext({
        operation: { name: operation },
      });

      if (cycle !== undefined) {
        scoped = scoped.withContext({ cycle });
      }

      failureLog = scoped;
      action(scoped);
    } catch (error) {
      try {
        failureLog.loggingFailed({ error });
      } catch {
        // Diagnostics must not interrupt recovery.
      }
    } finally {
      this.emitting = false;
    }
  }

  private timestamp(): string {
    try {
      const value = this.now();

      if (
        Number.isFinite(value) &&
        value >= 0 &&
        value < 253402300800000
      ) {
        return new Date(value).toISOString();
      } 
    } catch {
        // A diagnostic clock must not interrupt recovery.
    }

    return new Date().toISOString();
  }
}
