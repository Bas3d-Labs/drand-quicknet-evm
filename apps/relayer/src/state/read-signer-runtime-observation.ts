import type {
  TransactionManager,
} from './transaction-manager.js';

import type {
  TransactionAttemptSummary,
  TransactionManagerStatus,
} from './transaction-manager-types.js';

export type SignerRuntimeObservationSource =
  Pick<TransactionManager, 'status'>;

export interface SignerRuntimeObservation {
  readonly journalInitialized: boolean;
  readonly status: Pick<
    TransactionManagerStatus,
    | 'open'
    | 'primaryReason'
    | 'blockers'
    | 'recoveryComplete'
    | 'inclusionChecksComplete'
    | 'persistenceState'
    | 'blockedSince'
  >;
  readonly attempts: readonly TransactionAttemptSummary[];
}

/**
 * Captures one manager observation while preserving the persisted
 * daemon-status schema.
 */
export function readSignerRuntimeObservation(
  source: SignerRuntimeObservationSource,
): SignerRuntimeObservation {
  const current = source.status;

  return Object.freeze({
    journalInitialized: current.journalInitialized,
    status: Object.freeze({
      open: current.open,
      primaryReason: current.primaryReason,
      blockers: Object.freeze([...current.blockers]),
      recoveryComplete: current.recoveryComplete,
      inclusionChecksComplete: current.inclusionChecksComplete,
      persistenceState: current.persistenceState,
      blockedSince: current.blockedSince,
    }),
    attempts: Object.freeze(
      current.attempts.map((attempt): TransactionAttemptSummary => {
        const [first, ...remaining] = attempt.transactionHashes;

        const transactionHashes:
          TransactionAttemptSummary['transactionHashes'] =
            Object.freeze([first, ...remaining]);

        return Object.freeze({
          attemptId: attempt.attemptId,
          workId: attempt.workId,
          nonce: attempt.nonce,
          phase: attempt.phase,
          transactionHashes,
        });
      }),
    ),
  });
}