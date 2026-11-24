import type {
  SignerInclusionInspection,
} from '../chain/inspect-signer-inclusions.js';

import type {
  ErrorSummaryFactory,
} from '../config/config.js';

import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

import {
  JournalPersistence,
} from './journal-persistence.js';

import type {
  JournalIdentity,
} from './transaction-journal.js';

import type {
  SubmissionRecording,
} from './transaction-manager-types.js';

import {
  broadcastAttemptWorkflow,
} from './coordinator/broadcast-attempt-workflow.js';

import {
  checkInclusionsWorkflow,
} from './coordinator/check-inclusions-workflow.js';

import {
  CoordinatorDiagnostics,
} from './coordinator/coordinator-diagnostics.js';

import {
  CoordinatorStateStore,
} from './coordinator/coordinator-state.js';

import type {
  AttemptSummary,
  BroadcastAttemptOptions,
  BroadcastAttemptResult,
  CheckSignerInclusionsOptions,
  OpenSignerInspectionOptions,
  PrepareAttemptOptions,
  PrepareAttemptResult,
  RecoverSignerOptions,
  SignerCoordinatorOptions,
  SignerInspection,
  SignerRecoveryResult,
} from './coordinator/coordinator-types.js';

import {
  InspectionController,
  type InspectionOperationHandlers,
} from './coordinator/inspection-controller.js';

import {
  JournalCommitEngine,
} from './coordinator/journal-commit-engine.js';

import {
  prepareAttemptWorkflow,
} from './coordinator/prepare-attempt-workflow.js';

import {
  recoverSignerWorkflow,
} from './coordinator/recover-signer-workflow.js';

export type {
  AttemptSummary,
  BroadcastAttemptOptions,
  BroadcastAttemptResult,
  CheckSignerInclusionsOptions,
  OpenSignerInspectionOptions,
  PrepareAttemptOptions,
  PrepareAttemptResult,
  RecoverSignerOptions,
  SignerCoordinatorOptions,
  SignerInspection,
  SignerRecoveryResult,
} from './coordinator/coordinator-types.js';

/**
 * Coordinates durable nonce observations and attempt resolution so restart
 * recovery and signer availability follow the same journal state.
 */
export class SignerCoordinator {
  private readonly state: CoordinatorStateStore;
  private readonly diagnostics: CoordinatorDiagnostics;
  private readonly commit: JournalCommitEngine;
  private readonly inspections: InspectionController;
  private readonly inspectionHandlers: InspectionOperationHandlers;

  private constructor(
    persistence: JournalPersistence,
    identity: JournalIdentity,
    maxRetainedAttempts: number,
    log: ScopedRelayerLog,
    now: () => number,
    createErrorSummary: ErrorSummaryFactory,
  ) {
    this.state = new CoordinatorStateStore(
      persistence,
      identity,
      maxRetainedAttempts,
    );

    this.diagnostics = new CoordinatorDiagnostics(
      this.state,
      log,
      now,
      createErrorSummary,
    );

    this.commit = new JournalCommitEngine(
      this.state,
      this.diagnostics,
    );

    this.inspections = new InspectionController(
      this.state,
      this.diagnostics,
    );

    const workflowDeps = {
      state: this.state,
      diagnostics: this.diagnostics,
      commit: this.commit,
      inspections: this.inspections,
    };

    this.inspectionHandlers = {
      recoverOwned: (options, owner, cycle) =>
        recoverSignerWorkflow(workflowDeps, options, owner, cycle),
      checkInclusionsOwned: (options, owner, cycle) =>
        checkInclusionsWorkflow(workflowDeps, options, owner, cycle),
    };
  }

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

    coordinator.diagnostics.initializeStartupRetention();
    coordinator.state.initializeStartupBlockers();
    coordinator.diagnostics.refresh();
    coordinator.state.initializeDurableRecoveryRevision();

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
    return this.inspections.beginInspection(this.inspectionHandlers, options);
  }

  /**
   * Chain identity used by the signer journal and transaction signing.
   */
  get chainId(): number {
    return this.state.identity.chainId;
  }

  get attempts(): readonly AttemptSummary[] {
    return this.state.selectAttempts();
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
    return this.state.selectSubmissionRecording(workId);
  }

  /**
   * Whether a journal snapshot has been loaded or durably persisted.
   */
  get journalInitialized(): boolean {
    return this.state.selectJournalInitialized();
  }

  /** Counts acknowledged operator history only, never a staged candidate. */
  get operatorHistory() {
    return this.state.selectOperatorHistory();
  }

  /** Returns only acknowledged history, including after persistence retry. */
  operatorOutcome(
    requestId: string,
  ) {
    return this.state.selectOperatorOutcome(requestId);
  }

  /**
   * Determine whether the oldest unresolved attempt has a one-use
   * broadcast permit.
   */
  get canBroadcast(): boolean {
    return this.state.selectCanBroadcast();
  }

  get status() {
    return this.state.selectStatus(this.diagnostics.blockedSince);
  }

  /**
   * Token for the last completed recovery-relevant bookkeeping.
   * It is not a storage acknowledgement receipt. After completion fails,
   * the retained token is not eligible for recovery reuse.
   */
  get durableRecoveryRevision(): string {
    return this.state.durableRecoveryRevision;
  }

  /**
   * Signs and durably appends the next allocated transaction. Retained
   * attempts remain available for recovery and diagnostics.
   */
  async prepareAttempt(
    options: PrepareAttemptOptions,
    cycle?: number,
  ): Promise<PrepareAttemptResult> {
    return prepareAttemptWorkflow({
      state: this.state,
      diagnostics: this.diagnostics,
      commit: this.commit,
    }, options, cycle);
  }

  /**
   * Broadcasts the latest recorded signed transaction for the oldest
   * unresolved attempt after durably marking that broadcast may occur.
   */
  async broadcastAttempt(
    options: BroadcastAttemptOptions,
    cycle?: number,
  ): Promise<BroadcastAttemptResult> {
    return broadcastAttemptWorkflow({
      state: this.state,
      diagnostics: this.diagnostics,
      commit: this.commit,
    }, options, cycle);
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
    return this.inspections.runStandaloneInspection(
      this.inspectionHandlers,
      (inspection) => inspection.recover(options, cycle),
    );
  }

  /**
   * Persists a complete inclusion inspection without advancing either nonce
   * counter or removing retained attempts.
   *
   * Inclusion authorization becomes available only after persistence
   * succeeds. Retrying a failed write requires another inspection before
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

  /**
   * Publishes gate transitions after a complete reconciliation operation.
   */
  async observeReconciliation<T>(
    action: () => Promise<T>,
    cycle?: number,
  ): Promise<T> {
    return this.diagnostics.observeReconciliation(action, cycle);
  }

  /**
   * Retries the retained journal snapshot after a persistence failure,
   * then applies the corresponding observation or resolution transition.
   */
  async retryPersistence(
    cycle?: number,
  ): Promise<void> {
    return this.commit.retryPersistence(cycle);
  }
}
