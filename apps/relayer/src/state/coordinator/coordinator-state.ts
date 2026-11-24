import type {
  Hash,
} from 'viem';

import {
  durableRecoveryRevision as computeDurableRecoveryRevision,
} from '../durable-recovery-revision.js';

import type {
  JournalPersistence,
} from '../journal-persistence.js';

import {
  SignerAuthorization,
} from '../signer-authorization.js';

import {
  evaluateSignerGate,
  type CoordinatorBlocker,
} from '../signer-gate.js';

import {
  SignerRestartRequiredError,
} from '../signer-restart-required-error.js';

import type {
  StoredFactDisputeObservation,
} from '../status-observations.js';

import {
  MAX_OPERATOR_OUTCOMES,
  type JournalIdentity,
} from '../transaction-journal.js';

import type {
  SubmissionRecording,
} from '../transaction-manager-types.js';

import type {
  PendingWrite,
} from '../write-completion.js';

import type {
  AttemptSummary,
  InspectionOwner,
} from './coordinator-types.js';

/**
 * Single owner of orthogonal mutable coordinator state, guard checks,
 * explicit state transitions, blocker updates, and pure read projections.
 */
export class CoordinatorStateStore {
  readonly authorization = new SignerAuthorization();

  private readonly blockers = new Set<CoordinatorBlocker>();
  private reconciliationObservationActive = false;
  private busy = false;
  private emitting = false;
  private inspectionOwner: InspectionOwner | null = null;
  private pendingWrite: PendingWrite | undefined;
  private restartRequired = false;
  private committedDurableRecoveryRevision = '';
  private storedFactDispute: StoredFactDisputeObservation | null = null;

  constructor(
    readonly persistence: JournalPersistence,
    readonly identity: JournalIdentity,
    readonly maxRetainedAttempts: number,
  ) {}

  get durableRecoveryRevision(): string {
    return this.committedDurableRecoveryRevision;
  }

  get isReconciliationObservationActive(): boolean {
    return this.reconciliationObservationActive;
  }

  get hasPendingWrite(): boolean {
    return this.pendingWrite !== undefined;
  }

  get hasBlockers(): boolean {
    return this.blockers.size !== 0;
  }

  hasBlocker(blocker: CoordinatorBlocker): boolean {
    return this.blockers.has(blocker);
  }

  requirePendingWrite(): PendingWrite {
    if (this.pendingWrite === undefined) {
      throw new Error('No journal write is pending.');
    }

    return this.pendingWrite;
  }

  selectAttempts(): readonly AttemptSummary[] {
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
   * Check acknowledged state first because a failed broadcast-marker
   * write does not undo an acknowledged preparation. That attempt remains
   * retained even while its marker snapshot awaits persistence retry.
   */
  selectSubmissionRecording(
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

  selectJournalInitialized(): boolean {
    return this.persistence.current.kind === 'present';
  }

  /** Counts acknowledged operator history only, never a staged candidate. */
  selectOperatorHistory() {
    const current = this.persistence.current;

    if (current.kind === 'missing') {
      return null;
    }

    return Object.freeze({
      count: current.snapshot.ledger.outcomes.length,
      limit: MAX_OPERATOR_OUTCOMES,
    });
  }

  /** Returns only acknowledged history, including after persistence retry. */
  selectOperatorOutcome(
    requestId: string,
  ) {
    const current = this.persistence.current;

    if (current.kind === 'missing') {
      return undefined;
    }

    return current.snapshot.ledger.outcomes.find(
      (row) => row.requestId === requestId,
    );
  }

  /**
   * Determine whether the oldest unresolved attempt has a one-use
   * broadcast permit.
   */
  selectCanBroadcast(): boolean {
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
      (candidate) => candidate.phase !== 'included',
    );

    if (attempt === undefined) {
      return false;
    }

    return (
      this.authorization.recoveryComplete &&
      this.authorization.broadcastPermit === attempt.attemptId &&
      this.blockers.size === 0 &&
      current.snapshot.lastObservation.nonce === attempt.nonce
    );
  }

  /**
   * Pure projection over stored coordinator blockers and authorization.
   * Deliberately checks `!busy` and `inspectionOwner === null` (not `emitting`)
   * so gate-release callbacks observe `status.open === true` while commands
   * remain excluded.
   */
  selectStatus(
    blockedSince: string | null,
  ) {
    const gate = evaluateSignerGate({
      persistence: this.persistence,
      recoveryComplete: this.authorization.recoveryComplete,
      inclusionChecksComplete: this.authorization.inclusionChecksComplete,
      maxRetainedAttempts: this.maxRetainedAttempts,
      blockers: this.blockers,
    });

    return Object.freeze({
      ...gate,
      operatorHistory: this.selectOperatorHistory(),
      storedFactDispute: this.storedFactDispute,
      open:
        gate.open &&
        !this.busy &&
        this.inspectionOwner === null,
      recoveryComplete: this.authorization.recoveryComplete,
      inclusionChecksComplete: this.authorization.inclusionChecksComplete,
      persistenceState: this.persistence.state,
      blockedSince,
    });
  }

  initializeStartupBlockers(): void {
    this.latchUnattributedActivity();
    this.reconcileExhaustedSearch();
  }

  initializeDurableRecoveryRevision(): void {
    this.updateDurableRecoveryRevision();
  }

  async runBusy<T>(
    action: () => Promise<T>,
    afterRelease: () => void,
  ): Promise<T> {
    if (this.busy) {
      throw new Error('Signer coordinator operation is already in progress.');
    }

    this.busy = true;

    try {
      return await action();
    } finally {
      this.busy = false;
      afterRelease();
    }
  }

  runEmitting(action: () => void): void {
    if (this.emitting) {
      throw new Error('Signer coordinator operation is already in progress.');
    }

    this.emitting = true;

    try {
      action();
    } finally {
      this.emitting = false;
    }
  }

  async runReconciliationObservation<T>(
    action: () => Promise<T>,
    afterRelease: () => void,
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
      afterRelease();
    }
  }

  acquireInspectionOwner(owner: InspectionOwner): void {
    if (this.inspectionOwner !== null) {
      throw new Error('Signer inspection is already in progress.');
    }

    this.inspectionOwner = owner;
    this.authorization.inspectionBegun();
  }

  releaseInspectionOwner(owner: InspectionOwner): void {
    this.assertInspectionOwner(owner);
    this.inspectionOwner = null;
  }

  stagePendingWrite(completion: PendingWrite): void {
    if (this.pendingWrite !== undefined) {
      throw new Error('A journal write is already signed.');
    }

    this.pendingWrite = completion;
  }

  discardPendingWrite(): void {
    this.pendingWrite = undefined;
  }

  /**
   * Executes post-emission completion steps 4-6 in strict order:
   * clears pending metadata before updating blockers and revision so any
   * later failure preserves the original error without latching restart.
   */
  completePendingWrite(): void {
    this.pendingWrite = undefined;
    this.latchUnattributedActivity();
    this.reconcileExhaustedSearch();
    this.updateDurableRecoveryRevision();
  }

  latchRestartRequired(): void {
    this.restartRequired = true;
    this.authorization.completionFailed();
  }

  recordStoredFactDispute(
    dispute: StoredFactDisputeObservation,
  ): void {
    this.storedFactDispute = dispute;
  }

  clearStoredFactDispute(
    origin: StoredFactDisputeObservation['origin'],
  ): void {
    if (this.storedFactDispute?.origin === origin) {
      this.storedFactDispute = null;
    }
  }

  assertInspectionOwner(
    owner: InspectionOwner,
  ): void {
    if (this.inspectionOwner !== owner) {
      throw new Error('Signer inspection is no longer active.');
    }
  }

  assertInspectionContinuing(
    owner: InspectionOwner,
  ): void {
    this.assertInspectionOwner(owner);

    if (owner.abandoning) {
      throw new Error('Signer inspection is being abandoned.');
    }
  }

  assertNotOperating(): void {
    if (this.busy || this.emitting) {
      throw new Error('Signer coordinator operation is already in progress.');
    }
  }

  assertAvailable(
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

    this.assertNotOperating();
  }

  assertRestartNotRequired(): void {
    if (this.restartRequired) {
      throw new SignerRestartRequiredError();
    }
  }

  assertPersistenceIdle(): void {
    this.assertRestartNotRequired();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }
  }

  assertInspectionPersistenceIdle(): void {
    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('Signer inspection has pending persistence.');
    }
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

  private updateDurableRecoveryRevision(): void {
    this.committedDurableRecoveryRevision = computeDurableRecoveryRevision(
      this.persistence.current,
      this.blockers,
    );
  }
}
