import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

import type {
  JournalAttempt,
  AnchoredNonceObservation,
} from './transaction-journal.js';

export type SearchFactKind = 'lowerBound' | 'exhausted';

export interface ConflictingSearchFact {
  readonly attemptId: string;
  readonly kind: SearchFactKind;
  readonly nonce: bigint;
  readonly source: 'candidate' | 'retained';
}

export interface StoredFactNonceConflict {
  readonly reason: 'stored-fact-nonce-conflict';
  readonly anchor: Readonly<BlockAnchor>;
  readonly first: ConflictingSearchFact;
  readonly second: ConflictingSearchFact;
}

/** Active search facts only. Historical ledger rows are deliberately excluded. */
export function findStoredFactNonceConflict(
  attempts: readonly Pick<JournalAttempt, 'attemptId' | 'replacementSearch'>[],
  previous: readonly Pick<JournalAttempt, 'attemptId' | 'replacementSearch'>[] = attempts,
): StoredFactNonceConflict | null {
  const seen = new Map<bigint, Map<string, ConflictingSearchFact>>();

  for (const attempt of attempts) {
    const search = attempt.replacementSearch;

    if (search === null) {
      continue;
    }

    for (const kind of ['lowerBound', 'exhausted'] as const) {
      const observation = search[kind];

      if (observation === null) {
        continue;
      }

      const { anchor, nonce } = observation;

      const hash = anchor.blockHash.toLowerCase();

      const atHeight = seen.get(anchor.blockNumber) ?? new Map<string, ConflictingSearchFact>();

      const prior = previous.find((entry) => entry.attemptId === attempt.attemptId);

      const fact: ConflictingSearchFact = Object.freeze({
        attemptId: attempt.attemptId,
        kind,
        nonce,
        source: sameObservation(prior?.replacementSearch?.[kind], observation)
          ? 'retained'
          : 'candidate',
      });

      const first = atHeight.get(hash);

      if (first !== undefined && first.nonce !== nonce) {
        return Object.freeze({
          reason: 'stored-fact-nonce-conflict',
          anchor: Object.freeze({ ...anchor }),
          first,
          second: fact,
        });
      }

      atHeight.set(hash, fact);
      seen.set(anchor.blockNumber, atHeight);
    }
  }

  return null;
}

function sameObservation(
  left: AnchoredNonceObservation | null | undefined,
  right: AnchoredNonceObservation,
): boolean {
  return left !== undefined && left !== null &&
    left.nonce === right.nonce &&
    left.anchor.blockNumber === right.anchor.blockNumber &&
    left.anchor.blockHash.toLowerCase() === right.anchor.blockHash.toLowerCase();
}

/** A proposed preparation was refused before any transaction was signed. */
export class StoredFactNonceConflictError extends Error {
  constructor(readonly detail: StoredFactNonceConflict) {
    super('Attempt preparation conflicts with a retained signer nonce fact.');
    this.name = 'StoredFactNonceConflictError';
  }
}
