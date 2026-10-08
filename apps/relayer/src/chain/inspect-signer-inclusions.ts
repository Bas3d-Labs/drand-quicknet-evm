import type {
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import {
  readAnchoredNonce,
} from './read-anchored-nonce.js';

import {
  reconcileAttemptReceipt,
} from './reconcile-attempt-receipt.js';

import {
  recheckAttemptInclusion,
} from './recheck-attempt-inclusion.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  AnchoredNonceObservation,
  JournalAttempt,
  TransactionJournalSnapshot,
} from '../state/transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from '../state/transaction-journal-validation.js';

export interface InspectSignerInclusionsOptions {
  readonly publicClient: PublicClient;
  readonly snapshot: TransactionJournalSnapshot;
  readonly head: Readonly<BlockAnchor>;
}

export type SignerInclusionInspection =
  | {
      readonly status: 'anchor-changed';
      readonly observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      readonly status:
        | 'nonce-behind-journal'
        | 'inconsistent-observations';
      readonly observation: AnchoredNonceObservation;
    }
  | {
      readonly status: 'inspected';
      readonly observation: AnchoredNonceObservation;
      readonly attempts: readonly JournalAttempt[];
      readonly inclusionChecksComplete: boolean;
    };

/**
 * Inspects every retained attempt at one selected head.
 * 
 * Preserves uncertain inclusion observations and invalidates only records
 * whose saved inclusion block was contradicted. Does not persist changes,
 * advance either nonce counter, or authorize broadcasting.
 */
export async function inspectSignerInclusions(
  options: InspectSignerInclusionsOptions,
): Promise<SignerInclusionInspection> {
  const publicClient = options.publicClient;

  const snapshot = validateJournalSnapshotStructure(
    options.snapshot,
    options.snapshot.identity,
  );

  const head = Object.freeze({
    blockNumber: options.head.blockNumber,
    blockHash: options.head.blockHash,
  });

  if (
    typeof head.blockNumber !== 'bigint' ||
    head.blockNumber < 0n ||
    head.blockNumber >= (1n << 256n) ||
    !isFixedHex(head.blockHash, 32)
  ) {
    throw new TypeError('Invalid signer inclusion input.');
  }

  const openingHead = await getBlockAnchor(
    publicClient,
    head.blockNumber,
  );

  if (!blockAnchorsMatch(head, openingHead)) {
    return {
      status: 'anchor-changed',
      observedAnchor: Object.freeze(openingHead),
    };
  }

  const attempts: JournalAttempt[] = [];
  const verifiedNonces: bigint[] = [];
  let inclusionChecksComplete = true;

  for (const attempt of snapshot.attempts) {
    if (attempt.phase === 'included') {
      const result = await recheckAttemptInclusion({
        publicClient,
        observation: attempt.inclusion,
        head,
      });

      if (result.status === 'anchor-changed') {
        return result;
      }

      if (result.status === 'verified-unchanged') {
        attempts.push({
          ...attempt,
          inclusion: {
            ...attempt.inclusion,
            observedAt: result.observedAt,
          },
        });

        verifiedNonces.push(attempt.nonce);
        continue;
      }

      inclusionChecksComplete = false;

      if (result.status === 'inclusion-block-changed') {
        attempts.push({
          ...attempt,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,

          // Search progress from the previous fork must not skip blocks.
          // The retained lower bound will be checked by replacement search.
          replacementSearch: attempt.replacementSearch === null
            ? null
            : {
              lowerBound: attempt.replacementSearch.lowerBound,
              searchedThrough: null,
            },
        });
      } else {
        // Receipt absence or a head below inclusion proves no contradiction.
        attempts.push(attempt);
      }

      continue;
    }

    const receipt = await reconcileAttemptReceipt({
      publicClient,
      transactionHashes: attempt.signedTransactions.map(
        (transaction) => transaction.transactionHash,
      ),
      anchor: head,
    });

    if (receipt.status === 'anchor-changed') {
      return receipt;
    }

    if (receipt.status !== 'verified') {
      attempts.push(attempt);
      inclusionChecksComplete = false;
      continue;
    }

    const evidence = receipt.evidence;

    attempts.push({
      ...attempt,
      phase: 'included',
      inclusion: {
        outcome: evidence.outcome,
        transactionHash: evidence.transactionHash,
        inclusion: evidence.inclusion,
        observedAt: head,
      },
    });

    verifiedNonces.push(attempt.nonce);
  }

  // This read also closes the inspection against the selected head.
  const nonce = await readAnchoredNonce({
    publicClient,
    signer: snapshot.identity.signer,
    anchor: head,
  });

  if (nonce.status === 'anchor-changed') {
    return nonce;
  }

  const { observation } = nonce;

  if (observation.nonce < snapshot.durableNextNonce) {
    return {
      status: 'nonce-behind-journal',
      observation,
    };
  }

  if (verifiedNonces.some(
    (attemptNonce) => observation.nonce <= attemptNonce
  )) {
    return {
      status: 'inconsistent-observations',
      observation,
    };
  }

  const inspected = validateJournalSnapshotStructure({
    ...snapshot,
    lastObservation: observation,
    attempts,
  }, snapshot.identity);

  return Object.freeze({
    status: 'inspected',
    observation: inspected.lastObservation,
    attempts: inspected.attempts,
    inclusionChecksComplete,
  });
}