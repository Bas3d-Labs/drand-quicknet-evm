import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

import {
  BLOCKER_PRECEDENCE,
  type CoordinatorBlocker,
} from './signer-gate.js';

import type {
  JournalInclusionObservation,
  ReplacementSearch,
  TransactionJournalRead,
} from './transaction-journal.js';

/**
 * Projects already validated, committed journal content.
 */
export function durableRecoveryRevision(
  current: TransactionJournalRead,
  blockers: ReadonlySet<CoordinatorBlocker>,
): string {
  const persistentBlockers = BLOCKER_PRECEDENCE.filter((blocker) => {
    switch (blocker) {
      case 'unattributed-signer-activity':
      case 'conflict-search-exhausted':
        return blockers.has(blocker);

      default:
        return false;
    }
  });

  if (current.kind === 'missing') {
    return JSON.stringify({
      kind: 'missing',
      blockers: persistentBlockers,
    });
  }

  const snapshot = current.snapshot;

  return JSON.stringify({
    kind: 'present',
    nextNonce: snapshot.nextNonce.toString(),
    durableNextNonce: snapshot.durableNextNonce.toString(),
    attempts: snapshot.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      nonce: attempt.nonce.toString(),
      phase: attempt.phase,
      transactionHashes: attempt.signedTransactions.map(
        (transaction) => transaction.transactionHash.toLowerCase(),
      ),
      inclusion: projectInclusion(attempt.inclusion),
      replacementSearch: projectSearch(attempt.replacementSearch),
    })),
    blockers: persistentBlockers,
  });
}

function projectAnchor(
  anchor: Readonly<BlockAnchor>,
) {
  return {
    blockNumber: anchor.blockNumber.toString(),
    blockHash: anchor.blockHash.toLowerCase(),
  };
}

function projectInclusion(
  inclusion: JournalInclusionObservation | null,
) {
  if (inclusion === null) {
    return null;
  }

  if (inclusion.outcome === 'replaced') {
    return {
      outcome: inclusion.outcome,
      replacementTransactionHash:
        inclusion.replacementTransactionHash.toLowerCase(),
      nonceAtAnchor: inclusion.nonceAtAnchor.toString(),
      inclusion: projectAnchor(inclusion.inclusion),
    };
  }

  return {
    outcome: inclusion.outcome,
    transactionHash: inclusion.transactionHash.toLowerCase(),
    inclusion: projectAnchor(inclusion.inclusion),
  };
}

function projectSearch(
  search: ReplacementSearch | null,
) {
  if (search === null) {
    return null;
  }

  let searchedThrough: ReturnType<typeof projectAnchor> | null = null;

  if (search.searchedThrough !== null) {
    searchedThrough = projectAnchor(search.searchedThrough);
  }

  return {
    lowerBound: {
      anchor: projectAnchor(search.lowerBound.anchor),
      nonce: search.lowerBound.nonce.toString(),
    },
    searchedThrough,
  };
}