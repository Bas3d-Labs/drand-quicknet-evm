import type {
  JournalAttempt,
} from '../../src/state/transaction-journal.js';

type BroadcastAttemptOptions = Pick<
  JournalAttempt,
  'attemptId' | 'workId' | 'nonce' | 'signedTransactions'
>;

export function broadcastAttempt(
  options: BroadcastAttemptOptions,
): JournalAttempt {
  return {
    attemptId: options.attemptId,
    workId: options.workId,
    nonce: options.nonce,
    signedTransactions: options.signedTransactions,
    createdAt: '2026-10-04T00:00:00.000Z',
    phase: 'broadcast-may-have-occurred',
    inclusion: null,
    replacementSearch: null,
  };
}