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
} from '../write-outcome.js';

import type {
  CoordinatorDiagnostics,
} from './coordinator-diagnostics.js';

import type {
  CommitEngineStateCapability,
  ReadonlyPendingWrite,
} from './coordinator-state.js';

export type SavedWriteOutcome =
  | {
      readonly status: 'not-written';
      readonly error: unknown;
    }
  | {
      readonly status: 'uncertain';
      readonly error: unknown;
    }
  | {
      readonly status: 'acknowledged';
      readonly apply: (cycle?: number) => SignerEventOperation;
      readonly complete: (cycle?: number) => SignerEventOperation;
      readonly failCompletion: (error: unknown) => never;
    };

export interface WorkflowCommitHandle {
  saveWrite(
    snapshot: TransactionJournalSnapshot,
    completion: PendingWrite,
  ): Promise<SavedWriteOutcome>;
}

/**
 * Sole authority for journal persistence, lockstep staging, the 6-step
 * post-acknowledgement completion sequence, the narrow fatal completion
 * boundary, and retry isolation.
 */
export class JournalCommitEngine {
  constructor(
    private readonly state: CommitEngineStateCapability,
    private readonly diagnostics: CoordinatorDiagnostics,
  ) {}

  /**
   * Returns a frozen save-gated capability for workflows. Completion controls
   * are minted only after a journal write is acknowledged, preventing any
   * workflow from staging or completing metadata without an acknowledged save.
   */
  createWorkflowHandle(): WorkflowCommitHandle {
    return Object.freeze({
      saveWrite: (
        snapshot: TransactionJournalSnapshot,
        completion: PendingWrite,
      ) => this.saveWrite(snapshot, completion),
    });
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

    const pendingWrite = this.state.requirePendingWrite();
    let operation: SignerEventOperation = 'reconcile-attempt';

    await this.state.runBusy(async () => {
      const outcome = await retryJournalWrite(this.state.persistence);

      if (outcome.status === 'uncertain') {
        throw outcome.error;
      }

      try {
        operation = this.applyCommittedWrite(cycle);
      } catch (error) {
        return this.throwCompletionFailure(error, pendingWrite);
      }
    }, () => this.diagnostics.refresh(cycle, operation));
  }

  /** Stages one completion and saves without running any completion effects. */
  private async saveWrite(
    snapshot: TransactionJournalSnapshot,
    completion: PendingWrite,
  ): Promise<SavedWriteOutcome> {
    const pendingWrite = this.state.stagePendingWrite(completion);

    const outcome = await saveJournalWrite(this.state.persistence, snapshot);

    switch (outcome.status) {
      case 'not-written':
        this.state.discardPendingWrite();

        return Object.freeze({
          status: 'not-written' as const,
          error: outcome.error,
        });

      case 'uncertain':
        return Object.freeze({
          status: 'uncertain' as const,
          error: outcome.error,
        });

      case 'acknowledged': {
        let completed = false;
        let failed = false;

        const claimCompletion = (): void => {
          if (failed) {
            throw new Error(
              'Journal write completion has already failed.',
            );
          }

          if (completed) {
            throw new Error('Journal write completion was already applied.');
          }

          completed = true;
        };

        return Object.freeze({
          status: 'acknowledged' as const,
          apply: (cycle?: number) => {
            claimCompletion();

            return this.applyCommittedWrite(cycle);
          },
          complete: (cycle?: number) => {
            claimCompletion();

            return this.completeCommittedWrite(cycle);
          },
          failCompletion: (error: unknown) => {
            failed = true;

            return this.throwCompletionFailure(error, pendingWrite);
          },
        });
      }

      default:
        return outcome satisfies never;
    }
  }

  /** Called only after acknowledgement; never reclassifies a committed save. */
  private throwCompletionFailure(
    error: unknown,
    pendingWrite: ReadonlyPendingWrite,
  ): never {
    if (this.state.isPendingWrite(pendingWrite)) {
      this.state.latchRestartRequired();

      throw new SignerRestartRequiredError();
    }

    // Completion already cleared this write's metadata: preserve error as-is.
    throw error;
  }

  private applyCommittedWrite(
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
  private completeCommittedWrite(
    cycle?: number,
  ): SignerEventOperation {
    // Construction must not throw for planner output: this is outside the
    // logging boundary.
    const description = describeWriteCompletion(
      this.state.requirePendingWrite() as PendingWrite,
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
}
