import type {
  Address,
  PublicClient,
} from 'viem';

import type {
  AnchoredNonceObservation,
} from '../state/transaction-journal.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  checkBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import {
  parseNonceResponse,
} from './nonce-response.js';

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

  const before = await checkBlockAnchor(publicClient, anchor);
  if (before !== null) {
    return before;
  }

  const nonce = parseNonceResponse(
    await publicClient.getTransactionCount({
      address: signer,
      blockNumber: anchor.blockNumber,
    }),
  );

  const after = await checkBlockAnchor(publicClient, anchor);
  if (after !== null) {
    return after;
  }

  return {
    status: 'verified',
    observation: Object.freeze({
      anchor,
      nonce,
    }),
  };
}