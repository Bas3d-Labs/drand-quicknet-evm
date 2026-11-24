import type {
  JournalPersistence,
} from './journal-persistence.js';

import type {
  TransactionJournalSnapshot,
} from './transaction-journal.js';

export type WriteOutcome =
  | {
      readonly status: 'acknowledged';
    }
  | {
      readonly status: 'not-written';
      readonly error: unknown;
    }
  | {
      readonly status: 'uncertain';
      readonly error: unknown;
    };

export type RetryWriteOutcome = Exclude<
  WriteOutcome,
  { status: 'not-written' }
>;

/**
 * Called with idle persistence after the coordinator stages its completion.
 * Classifies storage only, immediately after save settles. Completion and
 * authorization remain the caller's responsibility.
 */
export async function saveJournalWrite(
  persistence: JournalPersistence,
  snapshot: TransactionJournalSnapshot,
): Promise<WriteOutcome> {
  try {
    await persistence.save(snapshot);
  } catch (error) {
    if (persistence.state === 'failed') {
      return { status: 'uncertain', error };
    }

    if (persistence.state === 'idle') {
      return { status: 'not-written', error };
    }

    throw error;
  }

  return { status: 'acknowledged' };
}

/** A valid retry has already passed verification and cannot be not-written. */
export async function retryJournalWrite(
  persistence: JournalPersistence,
): Promise<RetryWriteOutcome> {
  try {
    await persistence.retry();
  } catch (error) {
    return { status: 'uncertain', error };
  }

  return { status: 'acknowledged' };
}
