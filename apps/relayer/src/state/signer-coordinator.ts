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
  AnchoredNonceObservation,
  JournalIdentity,
  TransactionJournalStore,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface SignerCoordinatorOptions {
  readonly identity: JournalIdentity;
  readonly store: TransactionJournalStore;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly now?: () => number;
}

type ResolutionEvent =
  Parameters<ScopedRelayerLog['attemptResolved']>[0];

type PendingWrite =
  | {
      kind: 'resolution';
      event: ResolutionEvent;
    }
  | {
      kind: 'observation';
    };

/**
 * Coordinates durable nonce observations and attempt resolution so restart
 * recovery and signer availability follow the same journal state.
 */
export class SignerCoordinator {
  private recoveryComplete = false;
  private busy = false;
  private emitting = false;

  private readonly blockers = new Set<CoordinatorBlocker>();
  private readonly episodeReasons = new Set<SignerBlocker>();

  private blockedSince: string | null = null;
  private previousPrimary: SignerBlocker | null = null;
  private pendingWrite: PendingWrite | undefined;
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
    
    coordinator.latchUnattributedActivity();
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

  async resolveAttempt(
    evidence: AttemptResolutionEvidence,
    cycle?: number,
  ): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (
      current.kind !== 'present' ||
      current.snapshot.attempt === null
    ) {
      throw new Error('No recorded attempt is available to resolve.');
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

    this.pendingWrite = {
      kind: 'resolution',
      event: Object.freeze({
        signer: this.identity.signer,
        attemptId: attempt.attemptId,
        transactionHash: attempt.transactionHash,
        nonce: attempt.nonce,
        resolution,
      }),
    };

    let lastObservation = current.snapshot.lastObservation;

    if (
      resolution.outcome === 'replaced' &&
      resolution.nonceAtAnchor > lastObservation.nonce
    ) {
      lastObservation = Object.freeze({
        anchor: resolution.anchor,
        nonce: resolution.nonceAtAnchor,
      });
    }

    this.busy = true;

    try {
      await this.persistence.save({
        ...current.snapshot,
        nextNonce: attempt.nonce + 1n,
        attempt: null,
        lastObservation,
      });
    } catch (error) {
      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishWrite(cycle);
  }

  /** 
   * Saves a verified nonce observation for restart recovery and preserves a
   * starting point for replacement search before the nonce is consumed.
   */
  async recordObservation(
    observation: AnchoredNonceObservation,
    cycle?: number,
  ): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;
    if (current.kind !== 'present') {
      throw new Error(
        'Cannot record an observation without an initialized journal.'
      );
    }

    if (this.blockers.has('unattributed-signer-activity')) {
      throw new Error(
        'Cannot overwrite the observation of unattributed signer activity.'
      );
    }

    const next = validateJournalSnapshotStructure({
      ...current.snapshot,
      lastObservation: observation,
    }, this.identity);

    if (next.lastObservation.nonce < next.nextNonce) {
      this.recoveryComplete = false;
      this.refresh(cycle);

      throw new Error(
        'Observed nonce is behind the journal. Recovery is required.'
      );
    }

    let attempt = next.attempt;

    if (
      attempt !== null &&
      attempt.replacementSearch === null
    ) {
      let lowerBound: AnchoredNonceObservation | undefined;

      if (next.lastObservation.nonce <= attempt.nonce) {
        lowerBound = next.lastObservation;
      } else if (
        current.snapshot.lastObservation.nonce <= attempt.nonce
      ) {
        lowerBound = current.snapshot.lastObservation;
      }

      if (lowerBound !== undefined) {
        attempt = Object.freeze({
          ...attempt,
          replacementSearch: Object.freeze({
            lowerBound,
            searchedThrough: null,
          }),
        });
      }
    }

    this.pendingWrite = {
      kind: 'observation',
    };

    this.busy = true;

    try {
      await this.persistence.save({
        ...next,
        attempt,
      });
    } catch (error) {
      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishWrite(cycle);
  }

  recordSearchProgress(cycle?: number): void {
    this.assertAvailable();
    this.blockers.delete('conflict-search-exhausted');
    this.refresh(cycle);
  }

  private finishWrite(cycle?: number): void {
    const pending = this.pendingWrite!;

    if (pending.kind === 'resolution') {
      // Keep the gate closed and the attempt policy alive through
      // this emission.
      this.emit(
        (log) => log.attemptResolved(pending.event),
        cycle,
      );
    }

    this.pendingWrite = undefined;
    this.busy = false;

    this.latchUnattributedActivity();
    this.refresh(cycle);
  }

  private latchUnattributedActivity(): void {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return;
    }

    let accountedNonce = current.snapshot.nextNonce;

    if (current.snapshot.attempt !== null) {
      accountedNonce += 1n;
    }

    if (current.snapshot.lastObservation.nonce > accountedNonce) {
      this.blockers.add('unattributed-signer-activity');
    }
  }

  /**
   * Retries the retained journal snapshot after a persistence failure,
   * then applies the corresponding observation or resolution transition.
   */
  async retryPersistence(cycle?: number): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite === undefined ||
      this.persistence.state !== 'failed'
    ) {
      throw new Error('No failed journal write is available to retry.');
    }

    this.busy = true;

    try {
      await this.persistence.retry();
    } catch (error) {
      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishWrite(cycle);
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

    if (status.open && this.pendingWrite === undefined) {
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