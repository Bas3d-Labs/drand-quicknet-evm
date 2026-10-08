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

import {
  searchAttemptReplacement,
} from './search-attempt-replacement.js';

export interface InspectSignerInclusionsOptions {
  readonly publicClient: PublicClient;
  readonly snapshot: TransactionJournalSnapshot;
  readonly head: Readonly<BlockAnchor>;
  
  /**
   * Maximum full blocks searched per unresolved attempt. Omit to
   * perform receipt and saved-inclusion checks only.
   */
  readonly maxReplacementBlockRange?: bigint;
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
      
      /**
       * Oldest unresolved attempt whose recorded receipts are absent or
       * fork-served and whose nonce remains unconsumed at this head.
       * Earlier retained attempts must have verified inclusions.
       */
      readonly broadcastAttemptId: string | null;
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

  const maxReplacementBlockRange = options.maxReplacementBlockRange;

  if (
    typeof head.blockNumber !== 'bigint' ||
    head.blockNumber < 0n ||
    head.blockNumber >= (1n << 256n) ||
    !isFixedHex(head.blockHash, 32) ||
    (
      maxReplacementBlockRange !== undefined &&
      (
        typeof maxReplacementBlockRange !== 'bigint' ||
        maxReplacementBlockRange <= 0n ||
        maxReplacementBlockRange >= (1n << 256n)
      )
    )
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
  const verifiedIndices = new Set<number>();
  const replacementCandidates: number[] = [];

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

        verifiedIndices.add(attempts.length - 1);
        verifiedNonces.push(attempt.nonce);
        continue;
      }

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
      if (
        receipt.status === 'receipt-not-found' ||
        receipt.status === 'fork-served-receipt'
      ) {
        replacementCandidates.push(attempts.length);
      }

      attempts.push(attempt);
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

    verifiedIndices.add(attempts.length - 1);
    verifiedNonces.push(attempt.nonce);
  }

  // Establish the anchored nonce before searching the consuming transactions.
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

  let searched = false;

  if (maxReplacementBlockRange !== undefined) {
    for (const index of replacementCandidates) {
      const attempt = attempts[index]!;

      if (observation.nonce <= attempt.nonce) {
        continue;
      }

      let replacementSearch = attempt.replacementSearch;

      if (
        replacementSearch === null &&
        snapshot.lastObservation.nonce <= attempt.nonce
      ) {
        replacementSearch = {
          lowerBound: snapshot.lastObservation,
          searchedThrough: null,
        };
      }

      const search = await searchAttemptReplacement({
        publicClient,
        signer: snapshot.identity.signer,
        attempt: {
          ...attempt,
          replacementSearch,
        },
        observation,
        maxBlockRange: maxReplacementBlockRange,
      });

      searched = true;

      if (search.status === 'anchor-changed') {
        return search;
      }

      if (search.status !== 'replacement-found') {
        continue;
      }

      const evidence = search.evidence;

      attempts[index] = {
        ...attempt,
        phase: 'included',
        inclusion: {
          outcome: 'replaced',
          replacementTransactionHash: evidence.replacementTransactionHash,
          nonceAtAnchor: evidence.nonceAtAnchor,
          inclusion: evidence.inclusion,
          observedAt: head,
        },
      };
      verifiedIndices.add(index);
    }
  }

  if (searched) {
    // Close the entire pass after all additional searches.
    const closingHead = await getBlockAnchor(
      publicClient,
      head.blockNumber,
    );

    if (!blockAnchorsMatch(head, closingHead)) {
      return {
        status: 'anchor-changed',
        observedAnchor: Object.freeze(closingHead),
      };
    }
  }

  const inclusionChecksComplete =
    verifiedIndices.size === attempts.length;

  const unresolvedIndex = attempts.findIndex(
    (attempt) => attempt.phase !== 'included',
  );

  let broadcastAttemptId: string | null = null;
  
  if (unresolvedIndex !== -1) {
    const attempt = attempts[unresolvedIndex]!;

    const earlierInclusionsVerified = attempts
      .slice(0, unresolvedIndex)
      .every((_earlier, index) => verifiedIndices.has(index));

    if (
      replacementCandidates.includes(unresolvedIndex) &&
      observation.nonce === attempt.nonce &&
      earlierInclusionsVerified
    ) {
      broadcastAttemptId = attempt.attemptId;
    }
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
    broadcastAttemptId,
  });
}