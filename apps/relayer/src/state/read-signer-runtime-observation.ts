import type {
  AttemptSummary,
  SignerCoordinator,
} from './signer-coordinator.js';

export type SignerRuntimeObservationSource = Pick<
  SignerCoordinator,
  'journalInitialized' | 'status' | 'attempts'
>;

export interface SignerRuntimeObservation {
  readonly journalInitialized: boolean;
  readonly status: SignerCoordinator['status'];
  readonly attempts: readonly AttemptSummary[];
}

/**
 * Projects trusted coordinator state into detached public fields.
 */
export function readSignerRuntimeObservation(
  source: SignerRuntimeObservationSource,
): SignerRuntimeObservation {
  const journalInitialized = source.journalInitialized;
  const status = source.status;
  const attempts = source.attempts;

  return Object.freeze({
    journalInitialized,
    status: Object.freeze({
      open: status.open,
      primaryReason: status.primaryReason,
      blockers: Object.freeze([...status.blockers]),
      recoveryComplete: status.recoveryComplete,
      inclusionChecksComplete: status.inclusionChecksComplete,
      persistenceState: status.persistenceState,
      blockedSince: status.blockedSince,
    }),
    attempts: Object.freeze(
      attempts.map((attempt): AttemptSummary => {
        const [first, ...remaining] = attempt.transactionHashes;

        const transactionHashes:
          AttemptSummary['transactionHashes'] = Object.freeze([
            first,
            ...remaining,
          ]);

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