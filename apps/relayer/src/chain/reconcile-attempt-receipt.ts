import {
  TransactionReceiptNotFoundError,
  type Hash,
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

import type {
  AttemptResolutionEvidence,
} from '../diagnostics/transaction-evidence.js';

import {
  isFixedHex,
} from '../shared/hex.js';

export type ReceiptResolutionEvidence = Extract<
  AttemptResolutionEvidence,
  { outcome: 'success' | 'reverted' }
>;

export type AttemptReceiptResult =
  | {
      status: 'verified';
      evidence: ReceiptResolutionEvidence;
    }
  | {
      status: 'receipt-not-found';
    }
  | {
      status: 'anchor-changed';
      observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      status: 'included-not-durable';
      inclusion: Readonly<BlockAnchor>;
    }
  | {
      status: 'fork-served-receipt';
      inclusion: Readonly<BlockAnchor>;
      canonicalBlock: Readonly<BlockAnchor>;
    };

export interface ReconcileAttemptReceiptOptions {
  publicClient: PublicClient;
  transactionHash: Hash;
  anchor: Readonly<BlockAnchor>;
}

/**
 * Reads receipt evidence under the caller's selected durable anchor.
 */
export async function reconcileAttemptReceipt(
  options: ReconcileAttemptReceiptOptions,
): Promise<AttemptReceiptResult> {
  const {
    publicClient,
    transactionHash,
  } = options;

  const anchor = Object.freeze({ ...options.anchor });

  if (
    !isFixedHex(transactionHash, 32) ||
    typeof anchor.blockNumber !== 'bigint' ||
    anchor.blockNumber < 0n ||
    !isFixedHex(anchor.blockHash, 32)
  ) {
    throw new TypeError('Invalid receipt reconciliation input.');
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

  const result = await readReceipt(
    publicClient,
    transactionHash,
    anchor,
  );

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

  return result;
}

async function readReceipt(
  publicClient: PublicClient,
  transactionHash: Hash,
  anchor: Readonly<BlockAnchor>,
): Promise<AttemptReceiptResult> {
  let receipt;

  try {
    receipt = await publicClient.getTransactionReceipt({
      hash: transactionHash,
    });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return {
        status: 'receipt-not-found',
      };
    }

    throw error;
  }

  if (
    !isFixedHex(receipt.transactionHash, 32) ||
    receipt.transactionHash.toLowerCase() !==
      transactionHash.toLowerCase() ||
    typeof receipt.blockNumber !== 'bigint' ||
    receipt.blockNumber < 0n ||
    !isFixedHex(receipt.blockHash, 32) ||
    (receipt.status !== 'success' && receipt.status !== 'reverted')
  ) {
    throw new TypeError('Invalid attempt receipt response.');
  }

  const outcome = receipt.status;

  const inclusion = Object.freeze({
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  });

  const canonicalBlock = Object.freeze(
    await getBlockAnchor(
      publicClient,
      inclusion.blockNumber,
    ),
  );

  if (!blockAnchorsMatch(inclusion, canonicalBlock)) {
    return {
      status: 'fork-served-receipt',
      inclusion,
      canonicalBlock,
    };
  }

  if (inclusion.blockNumber > anchor.blockNumber) {
    return {
      status: 'included-not-durable',
      inclusion,
    };
  }

  const evidence = snapshotResolutionEvidence({
    outcome,
    transactionHash,
    anchor,
    inclusion,
  }) as ReceiptResolutionEvidence;

  return {
    status: 'verified',
    evidence,
  };
}