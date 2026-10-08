import type {
  Address,
  Hash,
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
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
}

export type ReplacementSearchResult =
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
 * Searches a boudned chunk of full blocks to identify which transaction
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
    };
  }

  const before = await getBlockAnchor(
    publicClient,
    anchor.blockNumber,
  );

  if (!blockAnchorsMatch(anchor, before)) {
    return {
      status: 'anchor-changed',
      observedAnchor: Object.freeze(before),
    };
  }

  const observedLower = await getBlockAnchor(
    publicClient,
    lower.blockNumber,
  );

  if (!blockAnchorsMatch(lower, observedLower)) {
    return {
      status: 'boundary-changed',
      boundary: 'lower-bound',
      observedAnchor: Object.freeze(observedLower),
    };
  }

  if (boundary !== lower) {
    const observed = await getBlockAnchor(
      publicClient,
      boundary.blockNumber,
    );

    if (!blockAnchorsMatch(boundary, observed)) {
      return {
        status: 'boundary-changed',
        boundary: 'searched-through',
        observedAnchor: Object.freeze(observed),
      };
    }
  }

  let through = boundary.blockNumber + maxBlockRange;
  if (through > anchor.blockNumber) {
    through = anchor.blockNumber;
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
        observedAnchor: inclusion,
      };
    }

    for (const transaction of block.transactions) {
      if (
        typeof transaction !== 'object' ||
        transaction === null ||
        !isFixedHex(transaction.hash, 32) ||
        !isFixedHex(transaction.from, 20) ||
        !Number.isSafeInteger(transaction.nonce) ||
        transaction.nonce < 0
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

    previous = inclusion;
    scannedBlocks += 1n;

    if (match !== undefined) {
      break;
    }
  }

  const after = await getBlockAnchor(
    publicClient,
    anchor.blockNumber,
  );

  if (!blockAnchorsMatch(anchor, after)) {
    return {
      status: 'anchor-changed',
      observedAnchor: Object.freeze(after),
    };
  }

  if (match !== undefined) {
    const recordedHash = recordedHashes.get(match.hash.toLowerCase());
    if (recordedHash !== undefined) {
      return {
        status: 'recorded-transaction-found',
        transactionHash: recordedHash,
        anchor,
        inclusion: match.inclusion,
      };
    }

    return {
      status: 'replacement-found',
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