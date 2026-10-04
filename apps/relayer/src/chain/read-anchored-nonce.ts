import type {
  Address,
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import type {
  AnchoredNonceObservation,
} from '../state/transaction-journal.js';

import {
  isFixedHex,
} from '../shared/hex.js';

export interface ReadAnchoredNonceOptions {
  publicClient: PublicClient;
  signer: Address;
  anchor: Readonly<BlockAnchor>;
}

export type AnchoredNonceResult =
  | {
      status: 'verified';
      observation: AnchoredNonceObservation;
    }
  | {
      status: 'anchor-changed';
      observedAnchor: Readonly<BlockAnchor>;
    };

/**
 * Reads the signer's transaction count at the selected block, checking
 * its hash before and after the read to detect a chain reorganization.
 *
 * Returns the nonce together with its block reference for journal
 * initialization and transaction recovery, or reports an anchor change
 * so the caller can retry.
 */
export async function readAnchoredNonce(
  options: ReadAnchoredNonceOptions,
): Promise<AnchoredNonceResult> {
  const {
    publicClient,
    signer,
  } = options;

  const anchor = Object.freeze({
    blockNumber: options.anchor.blockNumber,
    blockHash: options.anchor.blockHash,
  });

  if (
    !isFixedHex(signer, 20) ||
    typeof anchor.blockNumber !== 'bigint' ||
    anchor.blockNumber < 0n ||
    !isFixedHex(anchor.blockHash, 32)
  ) {
    throw new TypeError('Invalid anchored nonce input.');
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

  const nonce = await publicClient.getTransactionCount({
    address: signer,
    blockNumber: anchor.blockNumber,
  });

  if (
    typeof nonce !== 'number' ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0
  ) {
    throw new TypeError('Invalid anchored nonce response.');
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

  return {
    status: 'verified',
    observation: Object.freeze({
      anchor,
      nonce: BigInt(nonce),
    }),
  };
}