import {
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  checkBlockAnchor,
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

type ReceiptResolutionEvidence = Extract<
  AttemptResolutionEvidence,
  { outcome: 'success' | 'reverted' }
>;

type AttemptReceiptClassification =
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
      transactionHash: Hash;
      outcome: 'success' | 'reverted';
      inclusion: Readonly<BlockAnchor>;
    }
  | {
      status: 'fork-served-receipt';
      inclusion: Readonly<BlockAnchor>;
      canonicalBlock: Readonly<BlockAnchor>;
    };

/**
 * By-number receipt-verification reads in candidate order, including hashes
 * that contradict a receipt and reads above the selected anchor. Enclosing
 * anchor checks validate the interval and are not repeated in this list.
 * Failed brackets expose an empty list. Recovery filters above-anchor reads
 * before forwarding durable evidence; they remain useful for classification.
 */
export type AttemptReceiptResult = AttemptReceiptClassification & {
  readonly observations: readonly Readonly<BlockAnchor>[];
};

export interface ReconcileAttemptReceiptOptions {
  publicClient: PublicClient;
  transactionHashes: readonly Hash[];
  anchor: Readonly<BlockAnchor>;
}

/**
 * Checks every recorded transaction hash under one durable anchor bracket.
 * Missing or fork-served receipts do not prevent checking later hashes.
 */
export async function reconcileAttemptReceipt(
  options: ReconcileAttemptReceiptOptions,
): Promise<AttemptReceiptResult> {
  const publicClient = options.publicClient;
  const anchor = Object.freeze({ ...options.anchor });

  if (
    !Array.isArray(options.transactionHashes) ||
    options.transactionHashes.length === 0 ||
    typeof anchor.blockNumber !== 'bigint' ||
    anchor.blockNumber < 0n ||
    !isFixedHex(anchor.blockHash, 32)
  ) {
    throw new TypeError('Invalid receipt reconciliation input.');
  }

  const transactionHashes = [...options.transactionHashes];
  const uniqueHashes = new Set<string>();

  for (const hash of transactionHashes) {
    if (
      !isFixedHex(hash, 32) ||
      uniqueHashes.has(hash.toLowerCase())
    ) {
      throw new TypeError('Invalid receipt reconciliation input.');
    }

    uniqueHashes.add(hash.toLowerCase());
  }

  const before = await checkBlockAnchor(publicClient, anchor);
  if (before !== null) {
    return {
      ...before,
      observations: Object.freeze([]),
    };
  }

  const observations: Readonly<BlockAnchor>[] = [];

  let included: AttemptReceiptClassification | undefined;
  let fork: AttemptReceiptClassification | undefined;
  let conflictingInclusions = false;

  for (const transactionHash of transactionHashes) {
    const result = await readReceipt(
      publicClient,
      transactionHash,
      anchor,
      observations,
    );

    switch (result.status) {
      case 'verified':
      case 'included-not-durable':
        if (included !== undefined) {
          conflictingInclusions = true;
        } else {
          included = result;
        }
        break;

      case 'fork-served-receipt':
        fork ??= result;
        break;

      case 'receipt-not-found':
        break;
    }
  }

  const after = await checkBlockAnchor(publicClient, anchor);
  if (after !== null) {
    return {
      ...after,
      observations: Object.freeze([]),
    };
  }

  if (conflictingInclusions) {
    throw new TypeError('Conflicting attempt receipt observations.');
  }

  const result = included ?? fork ?? { status: 'receipt-not-found' as const };

  return {
    ...result,
    observations: Object.freeze(observations),
  };
}

async function readReceipt(
  publicClient: PublicClient,
  transactionHash: Hash,
  anchor: Readonly<BlockAnchor>,
  observations: Readonly<BlockAnchor>[],
): Promise<AttemptReceiptClassification> {
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

  // Preserve the observed header even when it disproves the receipt's claim.
  observations.push(canonicalBlock);

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
      transactionHash,
      outcome,
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
