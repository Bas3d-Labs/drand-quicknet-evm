import type {
  AnchoredNonceObservation,
  TransactionJournalRead,
} from './transaction-journal.js';

/**
 * Projects an already-validated journal read into public status data.
 */
export function projectJournalStatus(read: TransactionJournalRead) {
  if (read.kind === 'missing') {
    return {
      source: 'journal' as const,
      journal: 'missing' as const,
      gate: 'unknown' as const,
    };
  }

  const snapshot = read.snapshot;

  return {
    source: 'journal' as const,
    journal: 'present' as const,
    gate: 'unknown' as const,
    identity: {
      chainId: snapshot.identity.chainId,
      signer: snapshot.identity.signer,
    },
    baseline: projectObservation(snapshot.baseline),
    lastObservation: projectObservation(snapshot.lastObservation),
    nextNonce: snapshot.nextNonce.toString(),
    durableNextNonce: snapshot.durableNextNonce.toString(),
    attempts: snapshot.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      workId: attempt.workId,
      nonce: attempt.nonce.toString(),
      createdAt: attempt.createdAt,
      phase: attempt.phase,
      transactionHashes: attempt.signedTransactions.map(
        (transaction) => transaction.transactionHash,
      ),
    })),
    repairs: snapshot.repairs.map((repair) => ({
      kind: repair.kind,
      at: repair.at,
      previousNextNonce: repair.previousNextNonce.toString(),
      nextNonce: repair.nextNonce.toString(),
      observation: projectObservation(repair.observation),
    })),
  };
}

export type JournalStatus = ReturnType<typeof projectJournalStatus>;

function projectObservation(observation: AnchoredNonceObservation) {
  return {
    anchor: {
      blockNumber: observation.anchor.blockNumber.toString(),
      blockHash: observation.anchor.blockHash,
    },
    nonce: observation.nonce.toString(),
  };
}