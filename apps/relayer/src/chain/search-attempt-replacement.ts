import type {
  Address,
  Hash,
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  checkBlockAnchor,
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import type {
  AnchoredNonceObservation,
  JournalAttempt,
} from '../state/transaction-journal.js';

import type {
  AttemptResolutionEvidence,
} from '../diagnostics/transaction-evidence.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isNonNegativeSafeInteger,
} from '../shared/integer.js';

export interface SearchAttemptReplacementOptions {
  publicClient: PublicClient;
  signer: Address;

  attempt: Pick<
    JournalAttempt,
    'nonce' | 'replacementSearch'
  > & {
    readonly signedTransactions: readonly {
      readonly transactionHash: Hash;
    }[]
  };

  /** Verified nonce observation for this signer at the selected anchor. */
  observation: AnchoredNonceObservation;

  /** Maximum full blocks scanned per call, excluding anchor checks. */
  maxBlockRange: bigint;

  /** Durable recovery alone may certify a persisted boundary reset. */
  confirmDurableSearch?: boolean;
}

export interface SearchResetEvidence {
  readonly reason: 'searched-through-changed' | 'exhaustion-anchor-changed';
  readonly expected: Readonly<BlockAnchor>;
  readonly observed: Readonly<BlockAnchor>;
  readonly lowerBound: AnchoredNonceObservation;
}

/** A changed lower bound observed inside a successfully closed durable bracket. */
export interface ClosedLowerBoundMismatch {
  readonly durableAnchor: Readonly<BlockAnchor>;
  readonly lowerBound: AnchoredNonceObservation;
  readonly observedLower: Readonly<BlockAnchor>;
}

type ReplacementSearchClassification =
  | {
      status: 'search-lower-bound-changed';
      trigger: ClosedLowerBoundMismatch;
    }
  | {
      status: 'search-reset-required';
      reset: SearchResetEvidence;
    }
  | {
      /** There is no justified starting point. Keep the attempt unresolved. */
      status: 'missing-lower-bound';
    }
  | {
      /**
       * The selected anchor cannot support the saved search position.
       * Keep the attempt unresolved.
       */
      status: 'anchor-behind-search';
    }
  | {
      /** 
       * A saved block reference no longer matches. Do not accept progress
       * from this call. 
       */
      status: 'anchor-changed';
      observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      /** 
       * A saved block reference no longer matches. Do not accept progress
       * from this call. 
       */
      status: 'boundary-changed';
      boundary: 'lower-bound' | 'searched-through';
      observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      /**
       * A recorded signed transaction consumed the nonce. Return to receipt
       * reconciliation to determine success or revert.
       */
      status: 'recorded-transaction-found';
      transactionHash: Hash;
      anchor: Readonly<BlockAnchor>;
      inclusion: Readonly<BlockAnchor>;
    }
  | {
      /**
       * A different hash from the same signer consumed the nonce.
       * Replacement evidence is available.
       */
      status: 'replacement-found';
      evidence: Extract<
        AttemptResolutionEvidence,
        { outcome: 'replaced' }
      >;
    }
  | {
      /**
       * The checked chunk contained no match.
       */
      status: 'not-found';
      searchedThrough: Readonly<BlockAnchor>;
      scannedBlocks: bigint;
      remainingBlocks: bigint;
    };

/**
 * By-number reads inside a successfully closed search bracket, in read order:
 * saved-boundary validation and scanned full-block headers. Enclosing anchor
 * checks validate the interval and are not repeated in this list.
 * Failed or unopened brackets expose an empty list.
 */
export type ReplacementSearchResult = ReplacementSearchClassification & {
  readonly observations: readonly Readonly<BlockAnchor>[];
};

/**
 * Searches a bounded chunk of full blocks to identify which transaction
 * consumed an attempt's nonce after the anchored count advanced.
 * 
 * Checks saved block references before resuming. Returns a transaction
 * match or a checked search boundary for the coordinator to persist,
 * allowing later cycles to continue across large observation gaps.
 */
export async function searchAttemptReplacement(
  options: SearchAttemptReplacementOptions,
): Promise<ReplacementSearchResult> {
  const {
    publicClient,
    signer,
    maxBlockRange,
  } = options;

  const {
    nonce,
    signedTransactions,
    replacementSearch,
  } = options.attempt;

  if (
    !Array.isArray(signedTransactions) ||
    signedTransactions.length === 0
  ) {
    throw new TypeError('Invalid replacement search input.');
  }

  const recordedHashes = new Map<string, Hash>();

  for (const transaction of signedTransactions) {
    const hash = transaction.transactionHash;

    if (
      !isFixedHex(hash, 32) ||
      recordedHashes.has(hash.toLowerCase())
    ) {
      throw new TypeError('Invalid replacement search input.');
    }

    recordedHashes.set(hash.toLowerCase(), hash);
  }

  const anchor = copyAnchor(options.observation.anchor);
  const nonceAtAnchor = options.observation.nonce;

  if (
    !isFixedHex(signer, 20) ||
    !isUint(nonce) ||
    !isUint(nonceAtAnchor) ||
    nonceAtAnchor <= nonce ||
    !isUint(maxBlockRange) ||
    maxBlockRange === 0n
  ) {
    throw new TypeError('Invalid replacement search input.');
  }

  if (replacementSearch === null) {
    return {
      status: 'missing-lower-bound',
      observations: Object.freeze([]),
    };
  }

  const lower = copyAnchor(replacementSearch.lowerBound.anchor);
  const lowerNonce = replacementSearch.lowerBound.nonce;

  let boundary = lower;

  if (replacementSearch.searchedThrough !== null) {
    boundary = copyAnchor(replacementSearch.searchedThrough);

    if (boundary.blockNumber <= lower.blockNumber) {
      throw new TypeError('Invalid replacement search boundary.');
    }
  }

  if (!isUint(lowerNonce) || lowerNonce > nonce) {
    throw new TypeError('Invalid replacement search lower bound.');
  }

  if (
    lower.blockNumber >= anchor.blockNumber ||
    boundary.blockNumber > anchor.blockNumber
  ) {
    return {
      status: 'anchor-behind-search',
      observations: Object.freeze([]),
    };
  }

  let fact: AnchoredNonceObservation | null = null;
  if (options.confirmDurableSearch === true) {
    fact = replacementSearch.exhausted;
  }
  if (fact !== null && fact.anchor.blockNumber > anchor.blockNumber) {
    return { status: 'anchor-behind-search', observations: Object.freeze([]) };
  }

  const before = await checkBlockAnchor(publicClient, anchor);
  if (before !== null) {
    return {
      ...before,
      observations: Object.freeze([]),
    };
  }

  const observations: Readonly<BlockAnchor>[] = [];

  const observedLower = await getBlockAnchor(
    publicClient,
    lower.blockNumber,
  );

  observations.push(Object.freeze(observedLower));

  if (!blockAnchorsMatch(lower, observedLower)) {
    if (options.confirmDurableSearch === true) {
      const closing = await checkBlockAnchor(publicClient, anchor);

      if (closing !== null) {
        return {
          ...closing,
          observations: Object.freeze([]),
        };
      }

      return {
        status: 'search-lower-bound-changed',
        trigger: Object.freeze({
          durableAnchor: anchor,
          lowerBound: Object.freeze({
            anchor: lower,
            nonce: lowerNonce,
          }),
          observedLower,
        }),
        observations: Object.freeze(observations),
      };
    }

    return {
      status: 'boundary-changed',
      observations: Object.freeze([]),
      boundary: 'lower-bound',
      observedAnchor: Object.freeze(observedLower),
    };
  }

  // Only a completed durable bracket can authorize discarding saved evidence.
  const resetAfterClosing = async (
    reason: SearchResetEvidence['reason'],
    expected: Readonly<BlockAnchor>,
    observed: Readonly<BlockAnchor>,
  ): Promise<ReplacementSearchResult> => {
    const closing = await checkBlockAnchor(publicClient, anchor);
    if (closing !== null) {
      return { ...closing, observations: Object.freeze([]) };
    }
    return {
      status: 'search-reset-required',
      observations: Object.freeze(observations),
      reset: Object.freeze({
        reason,
        expected: copyAnchor(expected),
        observed: copyAnchor(observed),
        lowerBound: replacementSearch.lowerBound,
      }),
    };
  };

  let factConfirmed = fact === null;

  if (boundary !== lower) {
    const observed = await getBlockAnchor(
      publicClient,
      boundary.blockNumber,
    );

    observations.push(Object.freeze(observed));

    if (!blockAnchorsMatch(boundary, observed)) {
      if (options.confirmDurableSearch === true) {
        return resetAfterClosing('searched-through-changed', boundary, observed);
      }
      return {
        status: 'boundary-changed',
        observations: Object.freeze([]),
        boundary: 'searched-through',
        observedAnchor: Object.freeze(observed),
      };
    }
  }

  let through = boundary.blockNumber + maxBlockRange;
  if (through > anchor.blockNumber) {
    through = anchor.blockNumber;
  }

  const confirmFact = async (): Promise<ReplacementSearchResult | null> => {
    if (fact === null || factConfirmed) {
      return null;
    }
    const factAnchor = fact.anchor;
    let observed = observations.find(
      (value) => value.blockNumber === factAnchor.blockNumber,
    );
    if (observed === undefined) {
      observed = Object.freeze(await getBlockAnchor(
        publicClient,
        factAnchor.blockNumber,
      ));
      observations.push(observed);
    }
    if (!blockAnchorsMatch(fact.anchor, observed)) {
      return resetAfterClosing('exhaustion-anchor-changed', fact.anchor, observed);
    }
    factConfirmed = true;
    return null;
  };

  // Reuse the cursor read, or a forthcoming full-block read. A distinct fact
  // outside the scan window needs its own read even when a cursor exists.
  if (fact !== null && (
    fact.anchor.blockNumber <= boundary.blockNumber ||
    fact.anchor.blockNumber > through
  )) {
    const reset = await confirmFact();
    if (reset !== null) {
      return reset;
    }
  }

  let previous = boundary;
  let scannedBlocks = 0n;

  let match: {
    hash: Hash;
    inclusion: Readonly<BlockAnchor>;
  } | undefined;

  for (
    let number = boundary.blockNumber + 1n;
    number <= through;
    number += 1n
  ) {
    const block = await publicClient.getBlock({
      blockNumber: number,
      includeTransactions: true,
    });

    if (
      block.number !== number ||
      !isFixedHex(block.hash, 32) ||
      !isFixedHex(block.parentHash, 32) ||
      block.parentHash.toLowerCase() !==
        previous.blockHash.toLowerCase() ||
      !Array.isArray(block.transactions)
    ) {
      throw new TypeError('Invalid replacement search block.');
    }

    const inclusion = Object.freeze({
      blockNumber: number,
      blockHash: block.hash,
    });

    if (
      number === anchor.blockNumber &&
      !blockAnchorsMatch(anchor, inclusion)
    ) {
      return {
        status: 'anchor-changed',
        observations: Object.freeze([]),
        observedAnchor: inclusion,
      };
    }

    observations.push(inclusion);

    for (const transaction of block.transactions) {
      if (
        typeof transaction !== 'object' ||
        transaction === null ||
        !isFixedHex(transaction.hash, 32) ||
        !isFixedHex(transaction.from, 20) ||
        !isNonNegativeSafeInteger(transaction.nonce)
      ) {
        throw new TypeError('Invalid replacement search transaction.');
      }

      if (
        transaction.from.toLowerCase() === signer.toLowerCase() &&
        BigInt(transaction.nonce) === nonce
      ) {
        if (match !== undefined) {
          throw new TypeError(
            'Multiple transactions matched the recorded nonce.'
          );
        }

        match = {
          hash: transaction.hash,
          inclusion,
        };
      }
    }

    if (fact !== null && number === fact.anchor.blockNumber) {
      const reset = await confirmFact();
      if (reset !== null) {
        return reset;
      }
    }

    previous = inclusion;
    scannedBlocks += 1n;

    if (match !== undefined) {
      break;
    }
  }

  // A transaction match can end the scan before its planned fact-height read.
  const reset = await confirmFact();
  if (reset !== null) {
    return reset;
  }

  const after = await checkBlockAnchor(publicClient, anchor);
  if (after !== null) {
    return {
      ...after,
      observations: Object.freeze([]),
    };
  }

  if (match !== undefined) {
    const recordedHash = recordedHashes.get(match.hash.toLowerCase());
    if (recordedHash !== undefined) {
      return {
        status: 'recorded-transaction-found',
        observations: Object.freeze(observations),
        transactionHash: recordedHash,
        anchor,
        inclusion: match.inclusion,
      };
    }

    return {
      status: 'replacement-found',
      observations: Object.freeze(observations),
      evidence: Object.freeze({
        outcome: 'replaced',
        anchor,
        inclusion: match.inclusion,
        replacementTransactionHash: match.hash,
        nonceAtAnchor,
      }),
    };
  }

  return {
    status: 'not-found',
    observations: Object.freeze(observations),
    searchedThrough: previous,
    scannedBlocks,
    remainingBlocks: anchor.blockNumber - previous.blockNumber,
  }
}

function copyAnchor(
  value: Readonly<BlockAnchor>,
): Readonly<BlockAnchor> {
  if (
    !isUint(value.blockNumber) ||
    !isFixedHex(value.blockHash, 32)
  ) {
    throw new TypeError('Invalid replacement search anchor.');
  }

  return Object.freeze({
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
  });
}

function isUint(value: unknown): value is bigint {
  return (
    typeof value === 'bigint' &&
    value >= 0n &&
    value < (1n << 256n)
  );
}
