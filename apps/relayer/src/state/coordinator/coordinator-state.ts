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

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type ReadonlyPendingWrite = DeepReadonly<PendingWrite>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      const nested = (value as Record<PropertyKey, unknown>)[key];

      if (nested !== null && typeof nested === 'object') {
        deepFreeze(nested);
      }
    }

    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}

export interface DiagnosticsStateCapability {
  readonly identity: JournalIdentity;
  readonly current: JournalPersistence['current'];
  readonly isReconciliationObservationActive: boolean;
  readonly hasPendingWrite: boolean;
  selectStatus(
    blockedSince: string | null,
  ): ReturnType<CoordinatorStateStore['selectStatus']>;
  recordStoredFactDispute(dispute: StoredFactDisputeObservation): void;
  runEmitting(action: () => void): void;
  runReconciliationObservation<T>(
    action: () => Promise<T>,
    afterRelease: () => void,
  ): Promise<T>;
}

export interface CommitEngineStateCapability {
  readonly persistence: JournalPersistence;
  readonly identity: JournalIdentity;
  readonly authorization: Pick<
    SignerAuthorization,
    'terminalCorrectionCommitted'
  >;
  readonly hasPendingWrite: boolean;
  requirePendingWrite(): ReadonlyPendingWrite;
  stagePendingWrite(completion: PendingWrite): void;
  discardPendingWrite(): void;
  completePendingWrite(): void;
  latchRestartRequired(): void;
  assertAvailable(): void;
  assertRestartNotRequired(): void;
  runBusy<T>(
    action: () => Promise<T>,
    afterRelease: () => void,
  ): Promise<T>;
}

export interface InspectionStateCapability {
  readonly authorization: Pick<
    SignerAuthorization,
    | 'recoveryComplete'
    | 'inclusionChecksComplete'
    | 'evidenceContradicted'
    | 'bracketFailed'
    | 'abandonmentRequested'
    | 'abandonmentCompleted'
  >;
  assertAvailable(owner?: InspectionOwner): void;
  assertPersistenceIdle(): void;
  assertInspectionOwner(owner: InspectionOwner): void;
  assertInspectionContinuing(owner: InspectionOwner): void;
  assertNotOperating(): void;
  assertInspectionPersistenceIdle(): void;
  acquireInspectionOwner(owner: InspectionOwner): void;
  releaseInspectionOwner(owner: InspectionOwner): void;
  clearStoredFactDispute(origin: 'recovery'): void;
}

interface BaseWorkflowStateCapability {
  readonly identity: JournalIdentity;
  readonly current: JournalPersistence['current'];
  readonly hasBlockers: boolean;
  hasBlocker(blocker: CoordinatorBlocker): boolean;
  assertAvailable(owner?: InspectionOwner): void;
  assertPersistenceIdle(): void;
  runBusy<T>(
    action: () => Promise<T>,
    afterRelease: () => void,
  ): Promise<T>;
}

export interface PrepareAttemptState extends BaseWorkflowStateCapability {
  readonly authorization: Pick<
    SignerAuthorization,
    | 'inclusionChecksComplete'
    | 'storedFactConflictBeforeSigning'
    | 'preparationStarted'
    | 'preparationAboutToSave'
    | 'preparationRolledBack'
    | 'preparationReachedStorageWithoutCompletion'
    | 'grantPreparationPermit'
  >;
  isOpen(blockedSince: string | null): boolean;
  clearStoredFactDispute(origin: 'preparation'): void;
}

export interface BroadcastAttemptState extends BaseWorkflowStateCapability {
  readonly authorization: Pick<SignerAuthorization, 'broadcastStarted'>;
  selectCanBroadcast(): boolean;
}

export interface BootstrapSignerState extends BaseWorkflowStateCapability {
  readonly authorization: Pick<
    SignerAuthorization,
    'recoveryFailed' | 'bootstrapCommitted'
  >;
}

export interface RecoverSignerState extends BootstrapSignerState {
  readonly authorization: Pick<
    SignerAuthorization,
    | 'recoveryStarted'
    | 'recoveryFailed'
    | 'bootstrapCommitted'
    | 'evidenceContradicted'
    | 'recoveryCommitted'
    | 'grantRecoveryPermit'
  >;
}

export interface CheckInclusionsState extends BaseWorkflowStateCapability {
  readonly authorization: Pick<
    SignerAuthorization,
    | 'recoveryComplete'
    | 'inclusionCheckEntered'
    | 'evidenceContradicted'
    | 'inclusionCheckFailed'
    | 'inclusionCheckCommitted'
    | 'grantInclusionPermit'
  >;
  assertInspectionContinuing(owner: InspectionOwner): void;
}

/**
 * Single owner of orthogonal mutable coordinator state, guard checks,
 * explicit state transitions, blocker updates, and pure read projections.
 * Collaborators interact only through narrowed, frozen capability views.
 */
export class CoordinatorStateStore {
  private readonly authorization = new SignerAuthorization();
  private readonly blockers = new Set<CoordinatorBlocker>();
  private reconciliationObservationActive = false;
  private busy = false;
  private emitting = false;
  private inspectionOwner: InspectionOwner | null = null;
  private pendingWrite: ReadonlyPendingWrite | undefined;
  private restartRequired = false;
  private committedDurableRecoveryRevision = '';
  private storedFactDispute: StoredFactDisputeObservation | null = null;
  private commitEngineCapabilityIssued = false;

  constructor(
    private readonly persistence: JournalPersistence,
    readonly identity: JournalIdentity,
    readonly maxRetainedAttempts: number,
  ) {}

  get durableRecoveryRevision(): string {
    return this.committedDurableRecoveryRevision;
  }

  get hasPendingWrite(): boolean {
    return this.pendingWrite !== undefined;
  }

  private requirePendingWrite(): ReadonlyPendingWrite {
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

  private stagePendingWrite(completion: PendingWrite): void {
    if (this.pendingWrite !== undefined) {
      throw new Error('A journal write is already signed.');
    }

    // Clone to detach caller aliases and freeze recursively so retained
    // completion metadata cannot be mutated through any read reference.
    this.pendingWrite = deepFreeze(structuredClone(completion));
  }

  createDiagnosticsCapability(): DiagnosticsStateCapability {
    const store = this;

    return Object.freeze({
      identity: store.identity,
      get current() {
        return store.persistence.current;
      },
      get isReconciliationObservationActive() {
        return store.reconciliationObservationActive;
      },
      get hasPendingWrite() {
        return store.hasPendingWrite;
      },
      selectStatus: (blockedSince: string | null) =>
        store.selectStatus(blockedSince),
      recordStoredFactDispute: (dispute: StoredFactDisputeObservation) =>
        store.recordStoredFactDispute(dispute),
      runEmitting: (action: () => void) => store.runEmitting(action),
      runReconciliationObservation: <T>(
        action: () => Promise<T>,
        afterRelease: () => void,
      ) => store.runReconciliationObservation(action, afterRelease),
    });
  }

  createCommitEngineCapability(): CommitEngineStateCapability {
    if (this.commitEngineCapabilityIssued) {
      throw new Error('Commit engine capability has already been issued.');
    }
    this.commitEngineCapabilityIssued = true;
    const store = this;

    const authorization = Object.freeze({
      terminalCorrectionCommitted: () =>
        store.authorization.terminalCorrectionCommitted(),
    });

    return Object.freeze({
      persistence: store.persistence,
      identity: store.identity,
      authorization,
      get hasPendingWrite() {
        return store.hasPendingWrite;
      },
      requirePendingWrite: () => store.requirePendingWrite(),
      stagePendingWrite: (completion: PendingWrite) =>
        store.stagePendingWrite(completion),
      discardPendingWrite: () => store.discardPendingWrite(),
      completePendingWrite: () => store.completePendingWrite(),
      latchRestartRequired: () => store.latchRestartRequired(),
      assertAvailable: () => store.assertAvailable(),
      assertRestartNotRequired: () => store.assertRestartNotRequired(),
      runBusy: <T>(action: () => Promise<T>, afterRelease: () => void) =>
        store.runBusy(action, afterRelease),
    });
  }

  createInspectionCapability(): InspectionStateCapability {
    const store = this;

    const authorization = Object.freeze({
      get recoveryComplete() {
        return store.authorization.recoveryComplete;
      },
      get inclusionChecksComplete() {
        return store.authorization.inclusionChecksComplete;
      },
      evidenceContradicted: () => store.authorization.evidenceContradicted(),
      bracketFailed: () => store.authorization.bracketFailed(),
      abandonmentRequested: () => store.authorization.abandonmentRequested(),
      abandonmentCompleted: () => store.authorization.abandonmentCompleted(),
    });

    return Object.freeze({
      authorization,
      assertAvailable: (owner?: InspectionOwner) =>
        store.assertAvailable(owner),
      assertPersistenceIdle: () => store.assertPersistenceIdle(),
      assertInspectionOwner: (owner: InspectionOwner) =>
        store.assertInspectionOwner(owner),
      assertInspectionContinuing: (owner: InspectionOwner) =>
        store.assertInspectionContinuing(owner),
      assertNotOperating: () => store.assertNotOperating(),
      assertInspectionPersistenceIdle: () =>
        store.assertInspectionPersistenceIdle(),
      acquireInspectionOwner: (owner: InspectionOwner) =>
        store.acquireInspectionOwner(owner),
      releaseInspectionOwner: (owner: InspectionOwner) =>
        store.releaseInspectionOwner(owner),
      clearStoredFactDispute: (origin: 'recovery') =>
        store.clearStoredFactDispute(origin),
    });
  }

  createPrepareWorkflowCapability(): PrepareAttemptState {
    const store = this;

    const authorization = Object.freeze({
      get inclusionChecksComplete() {
        return store.authorization.inclusionChecksComplete;
      },
      storedFactConflictBeforeSigning: () =>
        store.authorization.storedFactConflictBeforeSigning(),
      preparationStarted: () => store.authorization.preparationStarted(),
      preparationAboutToSave: () =>
        store.authorization.preparationAboutToSave(),
      preparationRolledBack: (previousInclusionChecksComplete: boolean) =>
        store.authorization.preparationRolledBack(
          previousInclusionChecksComplete,
        ),
      preparationReachedStorageWithoutCompletion: () =>
        store.authorization.preparationReachedStorageWithoutCompletion(),
      grantPreparationPermit: (attemptId: string) =>
        store.authorization.grantPreparationPermit(attemptId),
    });

    return Object.freeze({
      identity: store.identity,
      get current() {
        return store.persistence.current;
      },
      get hasBlockers() {
        return store.blockers.size !== 0;
      },
      hasBlocker: (blocker: CoordinatorBlocker) =>
        store.blockers.has(blocker),
      assertAvailable: (owner?: InspectionOwner) =>
        store.assertAvailable(owner),
      assertPersistenceIdle: () => store.assertPersistenceIdle(),
      runBusy: <T>(action: () => Promise<T>, afterRelease: () => void) =>
        store.runBusy(action, afterRelease),
      authorization,
      isOpen: (blockedSince: string | null) =>
        store.selectStatus(blockedSince).open,
      clearStoredFactDispute: (origin: 'preparation') =>
        store.clearStoredFactDispute(origin),
    });
  }

  createBroadcastWorkflowCapability(): BroadcastAttemptState {
    const store = this;

    const authorization = Object.freeze({
      broadcastStarted: () => store.authorization.broadcastStarted(),
    });

    return Object.freeze({
      identity: store.identity,
      get current() {
        return store.persistence.current;
      },
      get hasBlockers() {
        return store.blockers.size !== 0;
      },
      hasBlocker: (blocker: CoordinatorBlocker) =>
        store.blockers.has(blocker),
      assertAvailable: (owner?: InspectionOwner) =>
        store.assertAvailable(owner),
      assertPersistenceIdle: () => store.assertPersistenceIdle(),
      runBusy: <T>(action: () => Promise<T>, afterRelease: () => void) =>
        store.runBusy(action, afterRelease),
      authorization,
      selectCanBroadcast: () => store.selectCanBroadcast(),
    });
  }

  createRecoverWorkflowCapability(): RecoverSignerState {
    const store = this;

    const authorization = Object.freeze({
      recoveryStarted: () => store.authorization.recoveryStarted(),
      recoveryFailed: () => store.authorization.recoveryFailed(),
      bootstrapCommitted: () => store.authorization.bootstrapCommitted(),
      evidenceContradicted: () => store.authorization.evidenceContradicted(),
      recoveryCommitted: (terminalCorrection: boolean) =>
        store.authorization.recoveryCommitted(terminalCorrection),
      grantRecoveryPermit: (attemptId: string) =>
        store.authorization.grantRecoveryPermit(attemptId),
    });

    return Object.freeze({
      identity: store.identity,
      get current() {
        return store.persistence.current;
      },
      get hasBlockers() {
        return store.blockers.size !== 0;
      },
      hasBlocker: (blocker: CoordinatorBlocker) =>
        store.blockers.has(blocker),
      assertAvailable: (owner?: InspectionOwner) =>
        store.assertAvailable(owner),
      assertPersistenceIdle: () => store.assertPersistenceIdle(),
      runBusy: <T>(action: () => Promise<T>, afterRelease: () => void) =>
        store.runBusy(action, afterRelease),
      authorization,
    });
  }

  createCheckInclusionsWorkflowCapability(): CheckInclusionsState {
    const store = this;

    const authorization = Object.freeze({
      get recoveryComplete() {
        return store.authorization.recoveryComplete;
      },
      inclusionCheckEntered: () =>
        store.authorization.inclusionCheckEntered(),
      evidenceContradicted: () => store.authorization.evidenceContradicted(),
      inclusionCheckFailed: () => store.authorization.inclusionCheckFailed(),
      inclusionCheckCommitted: (inclusionChecksComplete: boolean) =>
        store.authorization.inclusionCheckCommitted(inclusionChecksComplete),
      grantInclusionPermit: (attemptId: string) =>
        store.authorization.grantInclusionPermit(attemptId),
    });

    return Object.freeze({
      identity: store.identity,
      get current() {
        return store.persistence.current;
      },
      get hasBlockers() {
        return store.blockers.size !== 0;
      },
      hasBlocker: (blocker: CoordinatorBlocker) =>
        store.blockers.has(blocker),
      assertAvailable: (owner?: InspectionOwner) =>
        store.assertAvailable(owner),
      assertPersistenceIdle: () => store.assertPersistenceIdle(),
      assertInspectionContinuing: (owner: InspectionOwner) =>
        store.assertInspectionContinuing(owner),
      runBusy: <T>(action: () => Promise<T>, afterRelease: () => void) =>
        store.runBusy(action, afterRelease),
      authorization,
    });
  }

  private async runBusy<T>(
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

  private runEmitting(action: () => void): void {
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

  private async runReconciliationObservation<T>(
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

  private acquireInspectionOwner(owner: InspectionOwner): void {
    if (this.inspectionOwner !== null) {
      throw new Error('Signer inspection is already in progress.');
    }

    this.inspectionOwner = owner;
    this.authorization.inspectionBegun();
  }

  private releaseInspectionOwner(owner: InspectionOwner): void {
    this.assertInspectionOwner(owner);
    this.inspectionOwner = null;
  }

  private discardPendingWrite(): void {
    this.pendingWrite = undefined;
  }

  /**
   * Executes post-emission completion steps 4-6 in strict order:
   * clears pending metadata before updating blockers and revision so any
   * later failure preserves the original error without latching restart.
   */
  private completePendingWrite(): void {
    this.pendingWrite = undefined;
    this.latchUnattributedActivity();
    this.reconcileExhaustedSearch();
    this.updateDurableRecoveryRevision();
  }

  private latchRestartRequired(): void {
    this.restartRequired = true;
    this.authorization.completionFailed();
  }

  private recordStoredFactDispute(
    dispute: StoredFactDisputeObservation,
  ): void {
    this.storedFactDispute = dispute;
  }

  private clearStoredFactDispute(
    origin: StoredFactDisputeObservation['origin'],
  ): void {
    if (this.storedFactDispute?.origin === origin) {
      this.storedFactDispute = null;
    }
  }

  private assertInspectionOwner(
    owner: InspectionOwner,
  ): void {
    if (this.inspectionOwner !== owner) {
      throw new Error('Signer inspection is no longer active.');
    }
  }

  private assertInspectionContinuing(
    owner: InspectionOwner,
  ): void {
    this.assertInspectionOwner(owner);

    if (owner.abandoning) {
      throw new Error('Signer inspection is being abandoned.');
    }
  }

  private assertNotOperating(): void {
    if (this.busy || this.emitting) {
      throw new Error('Signer coordinator operation is already in progress.');
    }
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

    this.assertNotOperating();
  }

  private assertRestartNotRequired(): void {
    if (this.restartRequired) {
      throw new SignerRestartRequiredError();
    }
  }

  private assertPersistenceIdle(): void {
    this.assertRestartNotRequired();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }
  }

  private assertInspectionPersistenceIdle(): void {
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
