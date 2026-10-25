import type {
  TransactionJournalSnapshot,
} from './transaction-journal.js';

/**
 * Maximum allocated attempts retained until durable resolution.
 */
export const MAX_RETAINED_ATTEMPTS = 16;

export const DEFAULT_MAX_RETAINED_ATTEMPTS = 16;

/**
 * Maximum signed variants retained for one allocated nonce.
 */
export const MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT = 16;

export interface JournalBounds {
  readonly maxRetainedAttempts: number;
  readonly maxSignedTransactionsPerAttempt: number;
}

export const DEFAULT_JOURNAL_BOUNDS: JournalBounds = Object.freeze({
  maxRetainedAttempts: DEFAULT_MAX_RETAINED_ATTEMPTS,
  maxSignedTransactionsPerAttempt: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
});

export interface JournalBoundViolation {
  readonly bound:
    | 'retained-attempts'
    | 'signed-transactions-per-attempt';
  readonly maximum: number;
  readonly observed: number;
  readonly attemptId: string | null;
  readonly message: string;
}

export function validateJournalBounds(
  bounds: JournalBounds,
): void {
  const {
    maxRetainedAttempts,
    maxSignedTransactionsPerAttempt,
  } = bounds;

  if (
    !Number.isSafeInteger(maxRetainedAttempts) ||
    maxRetainedAttempts < 1 ||
    maxRetainedAttempts > MAX_RETAINED_ATTEMPTS
  ) {
    throw new TypeError('Invalid retained-attempt bound.');
  }

  if (
    !Number.isSafeInteger(maxSignedTransactionsPerAttempt) ||
    maxSignedTransactionsPerAttempt < 1 ||
    maxSignedTransactionsPerAttempt > MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT
  ) {
    throw new TypeError('Invalid signed-transaction bound.');
  }
}

/**
 * Checks operation bounds on an already structurally validated snapshot.
 */
export function inspectJournalBounds(
  snapshot: TransactionJournalSnapshot,
  bounds: JournalBounds = DEFAULT_JOURNAL_BOUNDS,
): readonly JournalBoundViolation[] {
  validateJournalBounds(bounds);

  const {
    maxRetainedAttempts,
    maxSignedTransactionsPerAttempt,
  } = bounds;

  const violations: JournalBoundViolation[] = [];

  if (snapshot.attempts.length > maxRetainedAttempts) {
    const observed = snapshot.attempts.length;

    violations.push(Object.freeze({
      bound: 'retained-attempts',
      maximum: maxRetainedAttempts,
      observed,
      attemptId: null,
      message:
        'Journal retained-attempt count exceeds its limit: observed '
        + observed
        + ', maximum '
        + maxRetainedAttempts
        + '.',
    }));
  }

  for (const attempt of snapshot.attempts) {
    const observed = attempt.signedTransactions.length;

    if (observed > maxSignedTransactionsPerAttempt) {
      violations.push(Object.freeze({
        bound: 'signed-transactions-per-attempt',
        maximum: maxSignedTransactionsPerAttempt,
        observed,
        attemptId: attempt.attemptId,
        message:
          'Journal signed-transaction count exceeds its per-attempt limit: '
          + 'attempt '
          + attempt.attemptId
          + ', observed '
          + observed
          + ', maximum '
          + maxSignedTransactionsPerAttempt
          + '.',
      }));
    }
  }

  return Object.freeze(violations);
}