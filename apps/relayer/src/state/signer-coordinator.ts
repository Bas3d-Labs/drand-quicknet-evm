import {
  randomUUID,
} from 'node:crypto';

import type {
  Hash,
  LocalAccount,
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  checkBlockAnchor,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  inspectSignerBootstrap,
  type SignerBootstrapDecision,
} from '../chain/inspect-signer-bootstrap.js';

import {
  inspectSignerInclusions,
  inspectSignerInclusionsWithinPass,
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
  durableRecoveryRevision as computeDurableRecoveryRevision,
} from './durable-recovery-revision.js';

import {
  JournalPersistence,
} from './journal-persistence.js';

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
  JournalAttempt,
  JournalIdentity,
  TransactionJournalStore,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface SignerCoordinatorOptions {
  readonly identity: JournalIdentity;
  readonly store: TransactionJournalStore;
  readonly maxRetainedAttempts: number;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly now?: () => number;
}

export interface RecoverSignerOptions {
  readonly publicClient: PublicClient;
  readonly anchor: Readonly<BlockAnchor>;
  readonly maxBlockRange: bigint;
}

export type SignerRecoveryResult =
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

export interface OpenSignerInspectionHeadOptions {
  readonly publicClient: PublicClient;
  readonly head: Readonly<BlockAnchor>;
}

export type SignerInspectionHeadResult =
  | {
      readonly status: 'anchor-changed';
      readonly observedAnchor: Readonly<BlockAnchor>;
    }
  | null;

type InspectionHeadBracket =
  | {
      readonly state: 'none';
    }
  | {
      readonly state: 'open';
      readonly publicClient: PublicClient;
      readonly head: Readonly<BlockAnchor>;
    }
  | {
      readonly state: 'closed';
    }
  | {
      readonly state: 'failed';
    };

export interface SignerInspection {
  /**
   * Opens an enclosing head bracket before any recovery or inclusion work.
   * 
   * A successful opening binds this inspection to the captured client and
   * head.
   */
  openHead(
    options: OpenSignerInspectionHeadOptions,
  ): Promise<SignerInspectionHeadResult>; 

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
   * enclosing head bracket is open or failed.
   * 
   * An open or failed bracket must be abandoned.
   * Pending persistence must be retried before another inspection begins.
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
  activeOperation: Promise<unknown> | null;
  abandonment: Promise<void> | null;
  abandoning: boolean;
  cycle: number | undefined;
  hasRunOperation: boolean;
  headBracket: InspectionHeadBracket;
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
        const signedTransactions = attempts.flatMap((attempt) => 
          attempt.signedTransactions.map(
            (transaction) => transaction.signedTransaction
          ),
        );

        try {
          coordinator.attemptLog = coordinator.log.withErrorSummary(
            options.createErrorSummary(signedTransactions),
          );
        } catch {
          throw new Error('Could not configure signed attempt diagnostics.');
        }

        coordinator.gateDiagnostics.blockedSince = first.createdAt;
      }
    }
    
    coordinator.latchUnattributedActivity();
    coordinator.latchExhaustedSearch();
    coordinator.refresh();
    coordinator.updateDurableRecoveryRevision();

    return coordinator;
  }

  beginInspection(): SignerInspection {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const owner: InspectionOwner = {
      activeOperation: null,
      abandonment: null,
      abandoning: false,
      cycle: undefined,
      hasRunOperation: false,
      headBracket: { state: 'none' },
    };

    this.inspectionOwner = owner;
    this.revokeActionAuthorization();

    return Object.freeze({
      openHead: (
        options: OpenSignerInspectionHeadOptions,
       ) => {
        const captured: OpenSignerInspectionHeadOptions = {
          publicClient: options.publicClient,
          head: Object.freeze({
            blockNumber: options.head.blockNumber,
            blockHash: options.head.blockHash,
          }),
        };

        return this.runInspectionOperation(
          owner,
          () => this.openInspectionHeadOwned(captured, owner),
        );
      },

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
    })
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

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

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

      const signedTransactions = [
        ...current.snapshot.attempts.flatMap((attempt) => 
          attempt.signedTransactions.map(
            (transaction) => transaction.signedTransaction,
          ),
        ),
        signed.signedTransaction,
      ];

      // Install protection for both retained and newly signed bytes before
      // persistence can fail. Queue-wide diagnostics have no one attemptId.
      try {
        this.attemptLog = this.log.withErrorSummary(
          this.createErrorSummary(signedTransactions)
        );
      } catch {
        throw new Error('Could not configure signed attempt diagnostics.');
      }

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
          lowerBound: current.snapshot.lastObservation,
          searchedThrough: null,
        },
      };

      const next = validateJournalSnapshotStructure({
        ...current.snapshot,
        nextNonce: current.snapshot.nextNonce + 1n,
        attempts: [
          ...current.snapshot.attempts,
          attempt,
        ],
      }, this.identity);

      this.gateDiagnostics.blockedSince ??= createdAt;
      this.inclusionChecksComplete = false;
      this.pendingWrite = { kind: 'prepared' };

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
      if (this.persistence.state === 'idle') {
        // No retained write: restore the previously committed queue's
        // diagnostic policy and inclusion authorization.
        this.pendingWrite = undefined;
        this.attemptLog = previousAttemptLog;
        this.gateDiagnostics.blockedSince = previousBlockedSince;
        this.inclusionChecksComplete = previousInclusionChecksComplete;
      } else {
        // Preserve the expanded diagnostic policy through every retry.
        this.recoveryComplete = false;
        this.inclusionChecksComplete = false;
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

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

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

    this.broadcastPermit = undefined;
    this.recoveryComplete = false;
    this.inclusionChecksComplete = false;
    this.busy = true;

    try {
      if (attempt.phase === 'signed') {
        this.pendingWrite = { kind: 'broadcast' };

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

        // Complete the marker write without publishing an intermediate
        // gate transition.
        this.pendingWrite = undefined;
      }

      const identity = {
        signer: this.identity.signer,
        attemptId: attempt.attemptId,
        transactionHash: transaction.transactionHash,
        nonce: attempt.nonce,
      };

      const notAcknowledged = Object.freeze({
        status: 'not-acknowledged',
        attemptId: attempt.attemptId,
        transactionHash: transaction.transactionHash,
        nonce: attempt.nonce,
      } as const);

      let returnedHash: unknown;

      try {
        returnedHash = await publicClient.request({
          method: 'eth_sendRawTransaction',
          params: [transaction.signedTransaction],
        }, {
          retryCount: 0,
        });
      } catch (error) {
        this.emit(
          (log) => log.attemptBroadcastNotAcknowledged({
            ...identity,
            observation: 'request-error',
            error,
          }),
          cycle,
          'broadcast-attempt',
        );

        return notAcknowledged;
      }

      if (!isFixedHex(returnedHash, 32)) {
        this.emit(
          (log) => log.attemptBroadcastNotAcknowledged({
            ...identity,
            observation: 'invalid-response',
          }),
          cycle,
          'broadcast-attempt',
        );

        return notAcknowledged;
      }

      if (
        returnedHash.toLowerCase() !==
        transaction.transactionHash.toLowerCase()
      ) {
        this.emit(
          (log) => log.attemptBroadcastNotAcknowledged({
            ...identity,
            observation: 'hash-mismatch',
            returnedTransactionHash: returnedHash,
          }),
          cycle,
          'broadcast-attempt',
        );

        return notAcknowledged;
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
      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

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
    const inspection = this.beginInspection();

    try {
      const result = await inspection.recover(options, cycle);
      inspection.finish();
      return result;
    } catch (error) {
      await inspection.abandon();
      throw error;
    }
  }

  private async recoverOwned(
    options: RecoverSignerOptions,
    owner: InspectionOwner,
    cycle?: number,
  ): Promise<SignerRecoveryResult> {
    this.assertInspectionWorkAllowed(owner);
    owner.hasRunOperation = true;

    const { maxBlockRange } = options;

    if (
      typeof maxBlockRange !== 'bigint' ||
      maxBlockRange <= 0n ||
      maxBlockRange >= (1n << 256n)
    ) {
      throw new TypeError('Invalid signer recovery input.');
    }

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    this.broadcastPermit = undefined;
    this.busy = true;
    this.recoveryComplete = false;
    this.inclusionChecksComplete = false;

    try {
      if (current.kind === 'missing') {
        const result = await this.readBootstrapObservation(options);

        if (result.status === 'bootstrap-deferred') {
          const { observation, latestNonce, pendingNonce } = result;
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
          return result;
        }

        this.lastBootstrapDeferral = undefined;

        const { observation } = result;

        this.pendingWrite = {
          kind: 'bootstrap',
        };

        await this.persistence.save({
          version: 1,
          identity: this.identity,
          baseline: observation,
          lastObservation: observation,
          nextNonce: observation.nonce,
          durableNextNonce: observation.nonce,
          repairs: [],
          attempts: [],
        });

        this.recoveryComplete = true;
        this.applyCommittedWrite(cycle);

        return {
          status: 'no-attempt',
          observation,
        };
      }
      
      const result = await inspectSignerRecovery({
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        anchor: options.anchor,
        maxBlockRange: options.maxBlockRange,
      });

      const plan = planSignerRecovery({
        identity: this.identity,
        snapshot: current.snapshot,
        inspection: result,
        unattributedActivity:
          this.blockers.has('unattributed-signer-activity'),
      });

      if (plan.kind === 'unchanged') {
        return result;
      }

      this.pendingWrite = plan.completion;

      await this.persistence.save(plan.snapshot);

      this.recoveryComplete = true;
      this.applyCommittedWrite(cycle);

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

      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

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
      inspection.finish();
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
    this.assertInspectionWorkAllowed(owner);
    owner.hasRunOperation = true;

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (current.kind !== 'present') {
      throw new Error(
        'Cannot check inclusions without an initialized journal.'
      )
    }

    this.broadcastPermit = undefined;
    this.inclusionChecksComplete = false;
    this.busy = true;

    try {
      const maxReplacementBlockRange = options.maxReplacementBlockRange;

      const bracket = owner.headBracket;

      const inspectionOptions = {
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        head: options.head,
        ...(maxReplacementBlockRange === undefined
          ? {}
          : { maxReplacementBlockRange }),
      };

      let result: SignerInclusionInspection;

      if (bracket.state === 'open') {
        if (
          options.publicClient !== bracket.publicClient ||
          !blockAnchorsMatch(options.head, bracket.head)
        ) {
          throw new Error(
            'Inclusion checking must use the inspection head and client.'
          );
        }

        result = await inspectSignerInclusionsWithinPass(inspectionOptions);
      } else {
        result = await inspectSignerInclusions(inspectionOptions);
      }

      if (result.status !== 'inspected') {
        if (bracket.state === 'open') {
          owner.headBracket = { state: 'failed' };
          this.revokeActionAuthorization();
        }

        if (
          result.status === 'nonce-behind-journal' ||
          result.status === 'inconsistent-observations'
        ) {
          this.recoveryComplete = false;
        }

        return result;
      }

      if (bracket.state === 'open') {
        const changed = await checkBlockAnchor(
          bracket.publicClient,
          bracket.head,
        );

        if (changed !== null) {
          owner.headBracket = { state: 'failed' };
          this.revokeActionAuthorization();
          return changed;
        }
      }

      // Preserve previously recorded evidence of unattributed activity.
      // A lower observation cannot clear that condition.
      const lastObservation =
        this.blockers.has('unattributed-signer-activity') &&
        current.snapshot.lastObservation.nonce > result.observation.nonce
          ? current.snapshot.lastObservation
          : result.observation;

      const next = validateJournalSnapshotStructure({
        ...current.snapshot,
        lastObservation,
        attempts: result.attempts,
      }, this.identity);

      this.pendingWrite = {
        kind: 'observation',
      };

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

      if (bracket.state === 'open') {
        owner.headBracket = { state: 'closed' };
      }

      return result;
    } catch (error) {
      this.inclusionChecksComplete = false;

      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle);
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
   * Checks whether a missing journal can adopt the selected durable nonce.
   * Only a ready decision may proceed to baseline persistence.
   */
  private async readBootstrapObservation(
    options: RecoverSignerOptions,
  ): Promise<SignerBootstrapDecision> {
    if (this.blockers.size !== 0) {
      throw new Error('Cannot bootstrap while coordinator blockers remain.');
    }

    return inspectSignerBootstrap({
      publicClient: options.publicClient,
      signer: this.identity.signer,
      anchor: options.anchor,
    });
  }

  private assertInspectionWorkAllowed(
    owner: InspectionOwner,
  ): void {
    this.assertAvailable(owner);

    if (owner.headBracket.state === 'failed') {
      throw new Error('Signer inspection head bracket failed.');
    }

    if (owner.headBracket.state === 'closed') {
      throw new Error('Signer inspection head bracket is already closed.');
    }
  }

  private async openInspectionHeadOwned(
    options: OpenSignerInspectionHeadOptions,
    owner: InspectionOwner,
  ): Promise<SignerInspectionHeadResult> {
    this.assertInspectionWorkAllowed(owner);

    if (
      owner.hasRunOperation ||
      owner.headBracket.state !== 'none'
    ) {
      throw new Error(
        'The head bracket must be opened before recovery or inclusion work.'
      );
    }

    // Until opening succeeds, this inspection may only be abandoned.
    owner.headBracket = { state: 'failed' };

    const { publicClient, head } = options;

    if (
      typeof head.blockNumber !== 'bigint' ||
      head.blockNumber < 0n ||
      head.blockNumber >= (1n << 256n) ||
      !isFixedHex(head.blockHash, 32)
    ) {
      throw new TypeError('Invalid signer inspection head.');
    }

    const changed = await checkBlockAnchor(publicClient, head);
    if (changed !== null) {
      return changed;
    }

    owner.headBracket = {
      state: 'open',
      publicClient,
      head,
    };
    
    return null;
  }

  private revokeActionAuthorization(): void {
    this.broadcastPermit = undefined;
    this.inclusionChecksComplete = false;
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
    this.assertInspectionWorkAllowed(owner);

    if (owner.activeOperation !== null) {
      throw new Error('Signer inspection operation is already in progress.');
    }

    owner.cycle = cycle;

    // Register the promise before entering operation mode. This also
    // covers synchronous callbacks made before its first awaited RPC.
    const pending = Promise.resolve().then(() => {
      this.assertInspectionWorkAllowed(owner);
      return operation();
    });

    owner.activeOperation = pending;

    try {
      return await pending;
    } catch (error) {
      if (owner.headBracket.state === 'open') {
        owner.headBracket = { state: 'failed' };
        this.revokeActionAuthorization();
      }

      throw error;
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

    if (owner.headBracket.state === 'open') {
      throw new Error(
        'Signer inspection head bracket is still open.'
      );
    }

    if (owner.headBracket.state === 'failed') {
      throw new Error(
        'Signer inspection head bracket failed.'
      );
    }

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('Signer inspection has pending persistence.');
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
    this.inspectionOwner = null;
    this.refresh(owner.cycle);
  }

  private applyCommittedWrite(
    cycle?: number
  ): SignerEventOperation {
    const pending = this.pendingWrite!;

    if (pending.kind === 'resolution') {
      this.blockers.delete('conflict-search-exhausted');

      // Keep ownership and the signed-byte diagnostic policy through
      // resolution reporting.
      this.emit(
        (log) => log.attemptResolved(pending.event),
        cycle,
      );
    } else if (pending.kind === 'search-progress') {
      if (pending.exhausted) {
        this.blockers.add('conflict-search-exhausted');
      } else {
        this.blockers.delete('conflict-search-exhausted');
      }
    }

    this.pendingWrite = undefined;

    this.latchUnattributedActivity();
    this.latchExhaustedSearch();
    this.updateDurableRecoveryRevision();

    let operation: SignerEventOperation = 'reconcile-attempt';

    if (pending.kind === 'prepared') {
      operation = 'prepare-attempt';
    } else if (pending.kind === 'broadcast') {
      operation = 'broadcast-attempt';
    }

    this.refresh(cycle, operation);

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

  private latchExhaustedSearch(): void {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return;
    }

    const attempt = current.snapshot.attempts.find(
      (candidate) => candidate.phase !== 'included',
    );

    if (attempt === undefined) {
      return;
    }

    const through = attempt.replacementSearch?.searchedThrough;

    if (
      through !== null &&
      through !== undefined &&
      current.snapshot.lastObservation.nonce > attempt.nonce &&
      blockAnchorsMatch(
        through,
        current.snapshot.lastObservation.anchor,
      )
    ) {
      this.blockers.add('conflict-search-exhausted');
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

    let operation: SignerEventOperation = 'reconcile-attempt';

    this.busy = true;

    try {
      await this.persistence.retry();

      operation = this.applyCommittedWrite(cycle);
    } finally {
      this.busy = false;
      this.refresh(cycle, operation);
    }
  }

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

    if (
      status.open &&
      this.pendingWrite === undefined &&
      current.kind === 'present' &&
      current.snapshot.attempts.length === 0
    ) {
      this.attemptLog = undefined;
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