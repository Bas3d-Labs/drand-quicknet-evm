import {
  broadcastSignedTransaction,
} from '../../chain/broadcast-signed-transaction.js';
import type {
  CoordinatorDiagnostics,
} from './coordinator-diagnostics.js';
import type {
  BroadcastAttemptState,
} from './coordinator-state.js';
import type {
  BroadcastAttemptOptions,
  BroadcastAttemptResult,
} from './coordinator-types.js';
import type {
  WorkflowCommitHandle,
} from './journal-commit-engine.js';

export interface BroadcastAttemptWorkflowDeps {
  readonly state: BroadcastAttemptState;
  readonly diagnostics: CoordinatorDiagnostics;
  readonly commit: WorkflowCommitHandle;
}

/**
 * Broadcasts the latest recorded signed transaction for the oldest
 * unresolved attempt after durably marking that broadcast may occur.
 */
export async function broadcastAttemptWorkflow(
  deps: BroadcastAttemptWorkflowDeps,
  options: BroadcastAttemptOptions,
  cycle?: number,
): Promise<BroadcastAttemptResult> {
  const { state, diagnostics, commit } = deps;
  state.assertAvailable();
  state.assertPersistenceIdle();

  const current = state.current;
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
  if (!state.selectCanBroadcast()) {
    throw new Error('Fresh reconciliation is required before broadcasting.');
  }

  const transaction =
    attempt.signedTransactions[attempt.signedTransactions.length - 1]!;
  const publicClient = options.publicClient;
  state.authorization.broadcastStarted();
  return state.runBusy(async () => {
    if (attempt.phase === 'signed') {
      const outcome = await commit.saveWrite({
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
      }, { kind: 'broadcast' });
      if (outcome.status !== 'acknowledged') {
        throw outcome.error;
      }

      try {
        outcome.complete(cycle);
      } catch (error) {
        return outcome.failCompletion(error);
      }
    }

    const identity = {
      signer: state.identity.signer,
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
      diagnostics.emit(
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

    diagnostics.emit(
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
  }, () => diagnostics.refresh(cycle, 'broadcast-attempt'));
}
