import type {
  JournalPersistence,
} from './journal-persistence.js';

export type SignerBlocker =
  | 'unresolved-attempt'
  | 'unattributed-signer-activity'
  | 'persistence-failure'
  | 'conflict-search-exhausted';

export type CoordinatorBlocker =
  | 'unattributed-signer-activity'
  | 'conflict-search-exhausted';

const BLOCKER_PRECEDENCE: readonly SignerBlocker[] = [
  'persistence-failure',
  'unattributed-signer-activity',
  'conflict-search-exhausted',
  'unresolved-attempt',
];

export interface SignerGateDecision {
  readonly open: boolean;
  readonly blockers: readonly SignerBlocker[];
  readonly primaryReason: SignerBlocker | null;
}

export interface EvaluateSignerGateOptions {
  readonly persistence: Pick<JournalPersistence, 'state' | 'current'>;
  readonly recoveryComplete: boolean;
  readonly blockers: ReadonlySet<CoordinatorBlocker>;
}

/**
 * Computes the gate from coordinate-owned state.
 * 
 * An empty blocker set is insufficient by itself: recovery must be
 * complete and persistence must be idle.
 */
export function evaluateSignerGate(
  options: EvaluateSignerGateOptions,
): SignerGateDecision {
  const state = options.persistence.state;
  const current = options.persistence.current;
  const blockers = new Set<SignerBlocker>(options.blockers);

  if (state === 'failed') {
    blockers.add('persistence-failure');
  }

  if (current.kind === 'missing') {
    // No initialized nonce baseline is available. Missing must never
    // be interpreted as an initialized journal with no attempt.
    blockers.add('unattributed-signer-activity');
  } else if (current.snapshot.attempt !== null) {
    blockers.add('unresolved-attempt');
  }

  const ordered = Object.freeze(
    BLOCKER_PRECEDENCE.filter((reason) => blockers.has(reason)),
  );

  return Object.freeze({
    open:
      options.recoveryComplete &&
      state === 'idle' &&
      ordered.length === 0,
    blockers: ordered,
    primaryReason: ordered[0] ?? null,
  });
}