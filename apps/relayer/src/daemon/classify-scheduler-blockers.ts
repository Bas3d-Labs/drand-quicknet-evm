import type {
  TransactionAdmissionReason,
} from '../state/transaction-manager-types.js';

export type SchedulerBlockerClass =
  | 'recovery-clearable'
  | 'operator-only'
  | 'unknown';

/** Scheduling policy only. This table never grants signer authorization. */
export const SCHEDULER_BLOCKER_CLASSES = Object.freeze({
  'recovery-incomplete': 'recovery-clearable',
  'unresolved-attempt': 'recovery-clearable',
  'unattributed-signer-activity': 'operator-only',
  'persistence-failure': 'recovery-clearable',
  'conflict-search-exhausted': 'unknown',
  'retention-capacity-reached': 'recovery-clearable',
} satisfies Record<TransactionAdmissionReason, SchedulerBlockerClass>);

/**
 * Exhaustion can clear through verified receipts, resolution or validated
 * search repairs. The manager status exposes none of the exhaustion evidence,
 * so its blocker name alone cannot justify the fast retry or an operator-only
 * classification. Keep it unknown and use the ordinary inspection cadence.
 */
export function classifySchedulerBlockers(
  blockers: readonly string[],
): {
  readonly classifications: readonly {
    readonly blocker: string;
    readonly classification: SchedulerBlockerClass;
  }[];
  readonly recoveryClearableOnly: boolean;
} {
  const classifications = blockers.map((blocker) => {
    let classification: SchedulerBlockerClass = 'unknown';

    if (Object.hasOwn(SCHEDULER_BLOCKER_CLASSES, blocker)) {
      classification = SCHEDULER_BLOCKER_CLASSES[blocker as TransactionAdmissionReason];
    }

    return Object.freeze({ blocker, classification });
  });

  return Object.freeze({
    classifications: Object.freeze(classifications),
    recoveryClearableOnly:
      classifications.length > 0 &&
      classifications.every((item) => item.classification === 'recovery-clearable'),
  });
}
