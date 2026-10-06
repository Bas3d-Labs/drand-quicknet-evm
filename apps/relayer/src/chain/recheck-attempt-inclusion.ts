import {
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import {
  snapshotResolutionEvidence,
} from '../diagnostics/resolution-validation.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  JournalInclusionObservation,
} from '../state/transaction-journal.js';

export interface RecheckAttemptInclusionOptions {
  readonly publicClient: PublicClient;

  /** Inclusion observation from a verified journal snapshot. */
  readonly observation: JournalInclusionObservation;

  /** Explicit observed head selected by the caller. */
  readonly head: Readonly<BlockAnchor>;
}

export type InclusionRecheckResult =
  | {
      status: 'verified-unchanged';
      observedAt: Readonly<BlockAnchor>;
    }
  | {
      status: 'inclusion-block-changed';
      inclusion: Readonly<BlockAnchor>;
      canonicalBlock: Readonly<BlockAnchor>;
    }
  | {
      status: 'receipt-unavailable';
    }
  | {
      status: 'head-behind-inclusion';
    }
  | {
      status: 'anchor-changed';
      observedAnchor: Readonly<BlockAnchor>;
    };

/**
 * Rechecks a saved inclusion under an explicit observed head.
 * 
 * Only a changed canonical inclusion block contradicts the saved
 * observation. Receipt absence is uncertainty. RPC failures propogate.
 */
export async function recheckAttemptInclusion(
  options: RecheckAttemptInclusionOptions,
): Promise<InclusionRecheckResult> {
  const publicClient = options.publicClient;

  const saved = snapshotResolutionEvidence({
    ...options.observation,
    anchor: options.observation.observedAt,
  });

  const head = Object.freeze({
    blockNumber: options.head.blockNumber,
    blockHash: options.head.blockHash,
  });

  if (
    typeof head.blockNumber !== 'bigint' ||
    head.blockNumber < 0n ||
    !isFixedHex(head.blockHash, 32)
  ) {
    throw new TypeError('Invalid inclusion recheck input.');
  }

  if (head.blockNumber < saved.inclusion.blockNumber) {
    return {
      status: 'head-behind-inclusion',
    };
  }

  const before = await getBlockAnchor(publicClient, head.blockNumber);

  if (!blockAnchorsMatch(head, before)) {
    return {
      status: 'anchor-changed',
      observedAnchor: Object.freeze(before),
    };
  }

  const canonicalBlock = Object.freeze(
    await getBlockAnchor(publicClient, saved.inclusion.blockNumber),
  );

  let result: InclusionRecheckResult;

  if (!blockAnchorsMatch(saved.inclusion, canonicalBlock)) {
    result = {
      status: 'inclusion-block-changed',
      inclusion: saved.inclusion,
      canonicalBlock,
    };
  } else {
    const transactionHash = saved.outcome === 'replaced'
      ? saved.replacementTransactionHash
      : saved.transactionHash;

    let receipt;

    try {
      receipt = await publicClient.getTransactionReceipt({
        hash: transactionHash,
      });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) {
        throw error;
      }
    }

    if (receipt === undefined) {
      result = {
        status: 'receipt-unavailable',
      };
    } else {
      if (
        !isFixedHex(receipt.transactionHash, 32) ||
        receipt.transactionHash.toLowerCase() !==
          transactionHash.toLowerCase() ||
        typeof receipt.blockNumber !== 'bigint' ||
        receipt.blockNumber !== saved.inclusion.blockNumber ||
        !isFixedHex(receipt.blockHash, 32) ||
        receipt.blockHash.toLowerCase() !==
          saved.inclusion.blockHash.toLowerCase() ||
        (receipt.status !== 'success' && receipt.status !== 'reverted') ||
        (
          saved.outcome !== 'replaced' &&
          receipt.status !== saved.outcome
        )
      ) {
        throw new TypeError('Inconsistent inclusion receipt response.');
      }

      result = {
        status: 'verified-unchanged',
        observedAt: head,
      };
    }
  }

  const after = await getBlockAnchor(publicClient, head.blockNumber);

  if (!blockAnchorsMatch(head, after)) {
    return {
      status: 'anchor-changed',
      observedAnchor: Object.freeze(after),
    };
  }

  return result;
}