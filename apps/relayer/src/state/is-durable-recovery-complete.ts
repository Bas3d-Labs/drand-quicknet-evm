import type {
  SignerCoordinator,
  SignerRecoveryResult,
} from './signer-coordinator.js';

export interface DurableRecoveryCompletionState {
  readonly recoveryComplete: boolean;
  readonly persistenceState:
    SignerCoordinator['status']['persistenceState'];

  /** Remaining retained attempts, in nonce order, after persistence. */
  readonly attempts: readonly {
    readonly nonce: bigint;
  }[];
}

/**
 * Determines whether a completed durable recovery pass may
 * advance its schedule.
 */
export function isDurableRecoveryComplete(
  result: SignerRecoveryResult,
  state: DurableRecoveryCompletionState,
): boolean {
  if (
    !state.recoveryComplete ||
    state.persistenceState !== 'idle'
  ) {
    return false;
  }

  switch (result.status) {
    case 'no-attempt':
    case 'resolution-available':
      // A resolution with remaining attempts does not establish that
      // the rest of the population has been inspected at this anchor.
      return state.attempts.length === 0;

    case 'unresolved': {
      const oldest = state.attempts[0];
      if (oldest === undefined) {
        return false;
      }

      // Consumed nonce without an established outcome stays due,
      // including when a bounded replacement search is exhuasted.
      if (result.observation.nonce > oldest.nonce) {
        return false;
      }

      if (
        result.search !== null ||
        result.receipt.status === 'fork-served-receipt'
      ) {
        return false;
      }

      return true;
    }

    default:
      return false;
  }
}