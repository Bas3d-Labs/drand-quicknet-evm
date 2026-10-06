import type {
  JournalPersistence,
} from './journal-persistence.js';

export type SignerBlocker =
  | 'recovery-incomplete'
  | 'unresolved-attempt'
  | 'unattributed-signer-activity'
  | 'persistence-failure'
  | 'conflict-search-exhausted'
  | 'journal-capacity-reached';

export type CoordinatorBlocker =
  | 'unattributed-signer-activity'
  | 'conflict-search-exhausted';

export const BLOCKER_PRECEDENCE: readonly SignerBlocker[] = Object.freeze([
  'persistence-failure',
  'unattributed-signer-activity',
  'conflict-search-exhausted',
  'unresolved-attempt',
  'journal-capacity-reached',
  'recovery-incomplete',
]);

export interface SignerGateDecision {
  readonly open: boolean;
  readonly blockers: readonly SignerBlocker[];
  readonly primaryReason: SignerBlocker | null;
}

export interface EvaluateSignerGateOptions {
  readonly persistence: Pick<JournalPersistence, 'state' | 'current'>;
  readonly recoveryComplete: boolean;

  /**
   * True only after the current inclusion recheck pass completes cleanly.
   * Persisted inclusion observations alone do not authorize preparation.
   */
  readonly inclusionChecksComplete: boolean;

  /** Maximum number of allocated attempts retained in the journal. */
  readonly maxRetainedAttempts: number;

  readonly blockers: ReadonlySet<CoordinatorBlocker>;
}

/**
 * Computes the gate from coordinator-owned state.
 * 
 * An empty blocker set is insufficient by itself: recovery must be
 * complete and persistence must be idle.
 */
export function evaluateSignerGate(
  options: EvaluateSignerGateOptions,
): SignerGateDecision {
  if (
    !Number.isSafeInteger(options.maxRetainedAttempts) ||
    options.maxRetainedAttempts <= 0
  ) {
    throw new TypeError('Invalid retained attempt capacity.');
  }

  const state = options.persistence.state;
  const current = options.persistence.current;
  const blockers = new Set<SignerBlocker>(options.blockers);

  if (state === 'failed') {
    blockers.add('persistence-failure');
  }

  if (
    !options.recoveryComplete ||
    !options.inclusionChecksComplete ||
    current.kind === 'missing'
  ) {
    blockers.add('recovery-incomplete');
  }

  if (current.kind === 'present') {
    const attempts = current.snapshot.attempts;

    if (attempts.some((attempt) => attempt.phase !== 'included')) {
      blockers.add('unresolved-attempt');
    }

    if (attempts.length >= options.maxRetainedAttempts) {
      blockers.add('journal-capacity-reached');
    }
  }

  const ordered = Object.freeze(
    BLOCKER_PRECEDENCE.filter((reason) => blockers.has(reason)),
  );

  return Object.freeze({
    open:
      state === 'idle' &&
      ordered.length === 0,
    blockers: ordered,
    primaryReason: ordered[0] ?? null,
  });
}