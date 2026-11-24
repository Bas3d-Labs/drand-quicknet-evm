import type {
  Hex,
} from 'viem';

import type {
  SignerBootstrapDecision,
} from '../../chain/inspect-signer-bootstrap.js';

import type {
  ErrorSummaryFactory,
} from '../../config/config.js';

import type {
  ScopedRelayerLog,
} from '../../diagnostics/relayer-log.js';

import {
  SignerGateDiagnostics,
} from '../signer-gate-diagnostics.js';

import {
  observeStoredFactDispute,
  type StoredFactDisputeObservation,
} from '../status-observations.js';

import type {
  StoredFactNonceConflict,
} from '../stored-fact-nonce-conflict.js';

import type {
  JournalAttempt,
} from '../transaction-journal.js';

import type {
  SignerEventOperation,
} from '../write-completion.js';

import type {
  CoordinatorStateStore,
} from './coordinator-state.js';

export interface PreparationDiagnosticSnapshot {
  readonly attemptLog: ScopedRelayerLog | undefined;
  readonly blockedSince: string | null;
}

/**
 * Owns diagnostic emission, signed-byte redaction lifetime, gate episode
 * tracking, and per-path diagnostic deduplication & exception boundaries.
 */
export class CoordinatorDiagnostics {
  private lastStoredFactConflict: string | undefined;
  private attemptLog: ScopedRelayerLog | undefined;
  private lastBootstrapDeferral: {
    readonly durableNonce: bigint;
    readonly latestNonce: bigint;
    readonly pendingNonce: bigint;
  } | undefined;

  private readonly gateDiagnostics = new SignerGateDiagnostics(
    () => this.timestamp(),
  );

  constructor(
    private readonly state: CoordinatorStateStore,
    private readonly log: ScopedRelayerLog,
    private readonly now: () => number,
    private readonly createErrorSummary: ErrorSummaryFactory,
  ) {}

  get blockedSince(): string | null {
    return this.gateDiagnostics.blockedSince;
  }

  initializeStartupRetention(): void {
    const current = this.state.persistence.current;

    if (current.kind === 'present') {
      const attempts = current.snapshot.attempts;
      const first = attempts[0];

      if (first !== undefined) {
        this.attemptLog = this.createSignedAttemptLog(attempts);
        this.gateDiagnostics.blockedSince = first.createdAt;
      }
    }
  }

  snapshotPreparationState(): PreparationDiagnosticSnapshot {
    return {
      attemptLog: this.attemptLog,
      blockedSince: this.gateDiagnostics.blockedSince,
    };
  }

  expandSignedAttemptLog(
    attempts: readonly JournalAttempt[],
    signedTransaction: Hex,
  ): void {
    this.attemptLog = this.createSignedAttemptLog(
      attempts,
      signedTransaction,
    );
  }

  seedBlockedSince(
    createdAt: string,
  ): void {
    this.gateDiagnostics.blockedSince ??= createdAt;
  }

  restorePreparationState(
    snapshot: PreparationDiagnosticSnapshot,
  ): void {
    this.attemptLog = snapshot.attemptLog;
    this.gateDiagnostics.blockedSince = snapshot.blockedSince;
  }

  clearStoredFactConflictDeduplication(): void {
    this.lastStoredFactConflict = undefined;
  }

  clearBootstrapDeferralDeduplication(): void {
    this.lastBootstrapDeferral = undefined;
  }

  reportBootstrapDeferred(
    result: Extract<SignerBootstrapDecision, { status: 'bootstrap-deferred' }>,
    cycle?: number,
  ): void {
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
          signer: this.state.identity.signer,
          durableBlock: observation.anchor.blockNumber,
          durableBlockHash: observation.anchor.blockHash,
          durableNonce: observation.nonce,
          latestNonce,
          pendingNonce,
        }),
        cycle,
      );
    }
  }

  /**
   * Records a stored-fact dispute and reports it directly via the scoped base
   * logger (outside `emit()` error containment and without toggling `emitting`).
   * Deduplication key updates only after the log call succeeds.
   */
  reportStoredFactConflict(
    detail: StoredFactNonceConflict,
    origin: StoredFactDisputeObservation['origin'],
    cycle?: number,
  ): void {
    this.state.storedFactDispute = observeStoredFactDispute(
      detail,
      origin,
      this.timestamp(),
    );

    const fields = {
      signer: this.state.identity.signer,
      firstAttemptId: detail.first.attemptId,
      secondAttemptId: detail.second.attemptId,
      blockNumber: detail.anchor.blockNumber,
      blockHash: detail.anchor.blockHash,
      firstNonce: detail.first.nonce,
      secondNonce: detail.second.nonce,
      firstExhausted: detail.first.kind === 'exhausted',
      secondExhausted: detail.second.kind === 'exhausted',
      firstCandidate: detail.first.source === 'candidate',
      secondCandidate: detail.second.source === 'candidate',
    };

    const key = JSON.stringify(fields, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    const log = this.log.withContext(cycle === undefined ? {} : { cycle });

    if (key === this.lastStoredFactConflict) {
      log.storedFactNonceConflictRepeated(fields);
    } else {
      log.storedFactNonceConflict(fields);
    }

    this.lastStoredFactConflict = key;
  }

  /**
   * Publishes gate transitions after a complete reconciliation operation.
   */
  async observeReconciliation<T>(
    action: () => Promise<T>,
    cycle?: number,
  ): Promise<T> {
    if (this.state.reconciliationObservationActive) {
      throw new Error('Signer reconciliation observation is already active.');
    }

    this.state.assertAvailable();
    this.state.reconciliationObservationActive = true;

    try {
      return await action();
    } finally {
      this.state.reconciliationObservationActive = false;
      this.refresh(cycle);
    }
  }

  /**
   * Publishes gate transitions and then releases signed-byte diagnostic
   * protection when the signer is open and no attempts remain.
   */
  refresh(
    cycle?: number,
    operation: SignerEventOperation = 'reconcile-attempt',
  ): void {
    if (this.state.reconciliationObservationActive) {
      return;
    }

    const status = this.state.selectStatus(this.gateDiagnostics.blockedSince);

    this.gateDiagnostics.observe(status, (event) => {
      this.emit((log) => {
        if (event.kind === 'blocked') {
          log.signerBlocked({
            signer: this.state.identity.signer,
            reason: event.reason,
            blockers: event.blockers,
            blockedSince: event.blockedSince,
          });

          return;
        }

        log.signerGateReleased({
          signer: this.state.identity.signer,
          cleared: event.cleared,
          blockedSince: event.blockedSince,
        });
      }, cycle, operation);
    });

    const current = this.state.persistence.current;

    // Keep signed-byte protection through gate publication, including
    // logging-failure reporting, before releasing the attempt logger.
    if (
      status.open &&
      this.state.pendingWrite === undefined &&
      current.kind === 'present' &&
      current.snapshot.attempts.length === 0
    ) {
      this.attemptLog = undefined;
    }
  }

  emit(
    action: (log: ScopedRelayerLog) => void,
    cycle?: number,
    operation: SignerEventOperation = 'reconcile-attempt',
  ): void {
    const log = this.attemptLog ?? this.log;
    this.state.emitting = true;

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
      this.state.emitting = false;
    }
  }

  timestamp(): string {
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

  /**
   * Creates diagnostic protection for every retained signed transaction
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
}
