import type {
  AnchoredNonceObservation,
  JournalAttempt,
  ReplacementSearch,
} from '../state/transaction-journal.js';

export function resolveReplacementSearch(
  attempt: Pick<JournalAttempt, 'nonce' | 'replacementSearch'>,
  lastObservation: AnchoredNonceObservation,
): ReplacementSearch | null {
  if (attempt.replacementSearch !== null) {
    return attempt.replacementSearch;
  }

  if (lastObservation.nonce <= attempt.nonce) {
    return {
      lowerBound: lastObservation,
      searchedThrough: null,
    };
  }

  return null;
}