import type {
  ErrorSummaryFactory,
} from '../config/config.js';

import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import type {
  AttemptResolutionEvidence,
} from '../diagnostics/transaction-evidence.js';

import {
  snapshotResolutionEvidence,
  assertResolutionTransaction,
} from '../diagnostics/resolution-validation.js';

import {
  JournalPersistence,
} from './journal-persistence.js';

import {
  evaluateSignerGate,
  BLOCKER_PRECEDENCE,
  type CoordinatorBlocker,
  type SignerBlocker,
} from './signer-gate.js';

import type {
  JournalIdentity,
  TransactionJournalStore,
} from './transaction-journal.js';

export interface SignerCoordinatorOptions {
  readonly identity: JournalIdentity;
  readonly store: TransactionJournalStore;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly now?: () => number;
}

type ResolutionEvent =
  Parameters<ScopedRelayerLog['attemptResolved']>[0];

/**
 * Owns recovery gate transitions and evidence-backed clears of
 * existing attempts.
 * 
 * The reconciler must establish canonicality before supplying
 * resolution evidence.
 */
export class SignerCoordinator {
  private recoveryComplete = false;
  private busy = false;
  private emitting = false;

  private readonly blockers = new Set<CoordinatorBlocker>();
  private readonly episodeReasons = new Set<SignerBlocker>();

  private blockedSince: string | null = null;
  private previousPrimary: SignerBlocker | null = null;
  private pendingResolution: ResolutionEvent | undefined;
  private attemptLog: ScopedRelayerLog | undefined;

  private constructor(
    private readonly persistence: JournalPersistence,
    private readonly identity: JournalIdentity,
    private readonly log: ScopedRelayerLog,
    private readonly now: () => number,
  ) {}

  static async create(
    options: SignerCoordinatorOptions,
  ): Promise<SignerCoordinator> {
    const identity = Object.freeze({ ...options.identity });

    const persistence = await JournalPersistence.create({
      identity,
      store: options.store,
      initial: await options.store.load(),
    });

    const coordinator = new SignerCoordinator(
      persistence,
      identity,
      options.log.withContext({ signer: identity.signer }),
      options.now ?? Date.now,
    );

    const current = persistence.current;
    if (
      current.kind === 'present' &&
      current.snapshot.attempt !== null
    ) {
      const attempt = current.snapshot.attempt;

      coordinator.attemptLog = coordinator.log
        .withErrorSummary(
          options.createErrorSummary([attempt.signedTransaction]),
        )
        .withContext({ attemptId: attempt.attemptId });

      coordinator.blockedSince = attempt.createdAt;
    }

    if (current.kind === 'present') {
      let accountedNonce = current.snapshot.nextNonce;

      if (current.snapshot.attempt !== null) {
        accountedNonce += 1n;
      }

      if (current.snapshot.lastObservation.nonce > accountedNonce) {
        coordinator.blockers.add('unattributed-signer-activity');
      }
    }

    coordinator.refresh();

    return coordinator;
  }

  get status() {
    const gate = evaluateSignerGate({
      persistence: this.persistence,
      recoveryComplete: this.recoveryComplete,
      blockers: this.blockers,
    });

    return Object.freeze({
      ...gate,
      open: gate.open && !this.busy,
      recoveryComplete: this.recoveryComplete,
      persistenceState: this.persistence.state,
      blockedSince: this.blockedSince,
    });
  }

  completeRecovery(cycle?: number): void {
    this.assertAvailable();

    if (this.persistence.current.kind === 'missing') {
      throw new Error(
        'Cannot complete recovery without an initialized journal'
      );
    }

    this.recoveryComplete = true;
    this.refresh(cycle);
  }

  /**
   * Records a decision made by reconciliation.
   */
  block(reason: CoordinatorBlocker, cycle?: number): void {
    this.assertAvailable();

    if (
      reason !== 'unattributed-signer-activity' &&
      reason !== 'conflict-search-exhausted'
    ) {
      throw new TypeError('Invalid coordinator blocker.');
    }

    this.blockers.add(reason);
    this.refresh(cycle);
  }

  recordSearchProgress(cycle?: number): void {
    this.assertAvailable();
    this.blockers.delete('conflict-search-exhausted');
    this.refresh(cycle);
  }

  async resolveAttempt(
    evidence: AttemptResolutionEvidence,
    cycle?: number,
  ): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingResolution !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (
      current.kind !== 'present' ||
      current.snapshot.attempt === null
    ) {
      throw new Error('No recorded attempt is available to translate.');
    }

    const attempt = current.snapshot.attempt;
    const resolution = snapshotResolutionEvidence(evidence);

    assertResolutionTransaction(attempt, resolution);

    if (
      resolution.outcome === 'replaced' &&
      resolution.nonceAtAnchor > attempt.nonce + 1n
    ) {
      this.blockers.add('unattributed-signer-activity');
    }

    this.pendingResolution = Object.freeze({
      signer: this.identity.signer,
      attemptId: attempt.attemptId,
      transactionHash: attempt.transactionHash,
      nonce: attempt.nonce,
      resolution,
    });

    this.busy = true;

    try {
      await this.persistence.save({
        ...current.snapshot,
        nextNonce: attempt.nonce + 1n,
        attempt: null,
      });
    } catch (error) {
      if (this.persistence.state === 'idle') {
        this.pendingResolution = undefined;
      }

      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishResolution(cycle);
  }

  async retryPersistence(cycle?: number): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingResolution === undefined ||
      this.persistence.state !== 'failed'
    ) {
      throw new Error('No failed resolution write is available to retry.');
    }

    this.busy = true;

    try {
      await this.persistence.retry();
    } catch (error) {
      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishResolution(cycle);
  }

  private finishResolution(cycle?: number): void {
    const event = this.pendingResolution!;

    // Keep the gate closed and the attempt policy alive through this emission.
    this.emit((log) => log.attemptResolved(event), cycle);

    this.pendingResolution = undefined;
    this.busy = false;
    this.refresh(cycle);
  }

  private refresh(cycle?: number): void {
    const status = this.status;

    if (status.blockers.length > 0) {
      if (this.blockedSince === null) {
        this.blockedSince = this.timestamp();
      }

      for (const reason of status.blockers) {
        this.episodeReasons.add(reason);
      }

      if (status.primaryReason !== this.previousPrimary) {
        this.emit((log) => log.signerBlocked({
          signer: this.identity.signer,
          reason: status.primaryReason!,
          blockers: status.blockers,
          blockedSince: this.blockedSince!,
        }), cycle);
      }
    }

    this.previousPrimary = status.primaryReason;

    if (status.open && this.blockedSince !== null) {
      const blockedSince = this.blockedSince;

      const cleared = BLOCKER_PRECEDENCE.filter(
        (reason) => this.episodeReasons.has(reason)
      );

      this.emit((log) => log.signerGateReleased({
        signer: this.identity.signer,
        cleared,
        blockedSince,
      }), cycle);

      this.blockedSince = null;
      this.episodeReasons.clear();
    }

    if (status.open && this.pendingResolution === undefined) {
      this.attemptLog = undefined;
    }
  }

  private assertAvailable(): void {
    if (this.busy || this.emitting) {
      throw new Error('Signer coordinator operation is already in progress.');
    }
  }

  private emit(
    action: (log: ScopedRelayerLog) => void,
    cycle?: number,
  ): void {
    const log = this.attemptLog ?? this.log;
    this.emitting = true;

    let failureLog = log;

    try {
      let scoped = log.withContext({
        operation: { name: 'reconcile-attempt' },
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