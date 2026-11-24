import {
  SignerRestartRequiredError,
} from '../signer-restart-required-error.js';

import type {
  TransactionJournalSnapshot,
} from '../transaction-journal.js';

import {
  describeWriteCompletion,
  type PendingWrite,
  type SignerEventOperation,
} from '../write-completion.js';

import {
  retryJournalWrite,
  saveJournalWrite,
  type WriteOutcome,
} from '../write-outcome.js';

import type {
  CoordinatorDiagnostics,
} from './coordinator-diagnostics.js';

import type {
  CoordinatorStateStore,
} from './coordinator-state.js';

/**
 * Owns lockstep staging, journal persistence, the 6-step post-acknowledgement
 * completion sequence, the narrow fatal completion boundary, and retry
 * isolation.
 */
export class JournalCommitEngine {
  constructor(
    private readonly state: CoordinatorStateStore,
    private readonly diagnostics: CoordinatorDiagnostics,
  ) {}

  /** Stages one completion and saves without running any completion effects. */
  async saveWrite(
    snapshot: TransactionJournalSnapshot,
    completion: PendingWrite,
  ): Promise<WriteOutcome> {
    this.state.stagePendingWrite(completion);

    return saveJournalWrite(this.state.persistence, snapshot);
  }

  discardUnwrittenWrite(): void {
    this.state.discardPendingWrite();
  }

  throwWriteFailure(
    outcome: Exclude<WriteOutcome, { status: 'acknowledged' }>,
  ): never {
    if (outcome.status === 'not-written') {
      this.state.discardPendingWrite();
    }

    throw outcome.error;
  }

  /** Called only after acknowledgement; never reclassifies a committed save. */
  throwCompletionFailure(error: unknown): never {
    if (this.state.hasPendingWrite) {
      this.state.latchRestartRequired();

      throw new SignerRestartRequiredError();
    }

    // Completion already cleared its metadata: preserve later failures as-is.
    throw error;
  }

  applyCommittedWrite(
    cycle?: number,
  ): SignerEventOperation {
    const operation = this.completeCommittedWrite(cycle);

    this.diagnostics.refresh(cycle, operation);

    return operation;
  }

  /**
   * Strict 6-step completion boundary:
   * 1. Describe completion
   * 2. Revoke authorization on terminal correction
   * 3. Emit completion event (before metadata clearance, blocker updates,
   *    or revision update)
   * 4. Clear pendingWrite
   * 5. Latch unattributed activity and reconcile conflict-search exhaustion
   * 6. Update committed durable recovery revision
   */
  completeCommittedWrite(
    cycle?: number,
  ): SignerEventOperation {
    // Construction must not throw for planner output: this is outside the
    // logging boundary.
    const description = describeWriteCompletion(
      this.state.requirePendingWrite(),
      this.state.identity.signer,
    );

    if (description.terminalCorrection) {
      this.state.authorization.terminalCorrectionCommitted();
    }

    const event = description.event;

    if (event !== null) {
      // Keep ownership and the signed-byte diagnostic policy through reporting.
      this.diagnostics.emit((log) => {
        switch (event.kind) {
          case 'attemptResolved':
            log.attemptResolved(event.fields);

            return;

          case 'attemptOperatorAccepted':
            log.attemptOperatorAccepted(event.fields);

            return;

          case 'attemptOperatorAttributed':
            log.attemptOperatorAttributed(event.fields);

            return;

          case 'searchReset':
            log.searchReset(event.fields);

            return;

          case 'searchUnconsumedBoundRebased':
            log.searchUnconsumedBoundRebased(event.fields);

            return;

          case 'searchLowerBoundReplaced':
            log.searchLowerBoundReplaced(event.fields);

            return;

          default:
            event satisfies never;
        }
      }, cycle);
    }

    this.state.completePendingWrite();

    return description.operation;
  }

  /**
   * Retries the retained journal snapshot after a persistence failure,
   * then applies the corresponding observation or resolution transition.
   * Performs no grant transitions (terminal-correction and completion-failure
   * revocations remain permitted), zero signing, zero RPC, and zero replanning.
   */
  async retryPersistence(
    cycle?: number,
  ): Promise<void> {
    this.state.assertAvailable();
    this.state.assertRestartNotRequired();

    if (
      !this.state.hasPendingWrite ||
      this.state.persistence.state !== 'failed'
    ) {
      throw new Error('No failed journal write is available to retry.');
    }

    let operation: SignerEventOperation = 'reconcile-attempt';

    await this.state.runBusy(async () => {
      const outcome = await retryJournalWrite(this.state.persistence);

      if (outcome.status === 'uncertain') {
        throw outcome.error;
      }

      try {
        operation = this.applyCommittedWrite(cycle);
      } catch (error) {
        return this.throwCompletionFailure(error);
      }
    }, () => this.diagnostics.refresh(cycle, operation));
  }
}
