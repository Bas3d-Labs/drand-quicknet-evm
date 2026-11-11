import {
  performance,
} from 'node:perf_hooks';

import type {
  Address,
  Hash,
  PublicClient,
} from 'viem';

import {
  captureAnchoredReadScope,
  registerAnchoredReadFailure,
  type AnchoredReadContext,
  type AnchoredReadScope,
} from '../diagnostics/anchored-read-errors.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

import type {
  AnchoredNonceObservation,
} from '../state/transaction-journal.js';

import type {
  BlockAnchor,
} from './block-anchor.js';

import {
  parseNonceResponse,
} from './nonce-response.js';

export interface ReadSearchLowerBoundProbeOptions {
  readonly publicClient: PublicClient;
  readonly signer: Address;
  readonly blockNumber: bigint;
  readonly scope?: AnchoredReadScope;
}

export type SearchLowerBoundProbeResult =
  | {
      readonly status: 'verified';
      readonly observation: AnchoredNonceObservation;
      readonly parentHash: Hash;
    }
  | {
      readonly status: 'anchor-changed';
      readonly observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      readonly status: 'inconsistent-observations';
    };

interface ProbeHeader extends Readonly<BlockAnchor> {
  readonly parentHash: Hash;
}

/**
 * Reads one candidate's header, nonce, and closing header. The opening read
 * establishes the candidate hash. No expected hash or preliminary read is needed.
 *
 * A verified result only certifies this probe. The repair caller must still
 * check the attempt nonce, adjacent parent links, and enclosing durable bracket
 * before it can use the observation as a replacement lower bound.
 */
export async function readSearchLowerBoundProbe(
  options: ReadSearchLowerBoundProbeOptions,
): Promise<SearchLowerBoundProbeResult> {
  const {
    publicClient,
    signer,
    blockNumber,
  } = options;

  if (
    !isFixedHex(signer, 20) ||
    typeof blockNumber !== 'bigint' ||
    blockNumber < 0n ||
    blockNumber > MAX_UINT256
  ) {
    throw new TypeError('Invalid search lower-bound probe input.');
  }

  const scope = captureAnchoredReadScope(options.scope);
  const opening = await readProbeHeader({
    publicClient,
    blockNumber,
    scope,
  });

  const startedAt = performance.now();
  let nonce: bigint;

  try {
    nonce = parseNonceResponse(
      await publicClient.getTransactionCount({
        address: signer,
        blockNumber,
      }),
    );
  } catch (error) {
    registerAnchoredReadFailure(error, {
      ...scope,
      method: 'eth_getTransactionCount',
      blockNumber,
      expectedBlockHash: opening.blockHash,
      durationMs: performance.now() - startedAt,
    });

    throw error;
  }

  const closing = await readProbeHeader({
    publicClient,
    blockNumber,
    scope,
    expectedBlockHash: opening.blockHash,
  });

  if (opening.blockHash.toLowerCase() !== closing.blockHash.toLowerCase()) {
    return Object.freeze({
      status: 'anchor-changed',
      observedAnchor: Object.freeze({
        blockNumber: closing.blockNumber,
        blockHash: closing.blockHash,
      }),
    });
  }

  // One hash cannot name headers with different parents. Do not publish the
  // nonce as a verified observation even though the anchor hash stayed stable.
  if (opening.parentHash.toLowerCase() !== closing.parentHash.toLowerCase()) {
    return Object.freeze({
      status: 'inconsistent-observations',
    });
  }

  return Object.freeze({
    status: 'verified',
    observation: Object.freeze({
      anchor: Object.freeze({
        blockNumber: opening.blockNumber,
        blockHash: opening.blockHash,
      }),
      nonce,
    }),
    parentHash: opening.parentHash,
  });
}

async function readProbeHeader(options: {
  readonly publicClient: PublicClient;
  readonly blockNumber: bigint;
  readonly scope: Readonly<AnchoredReadScope>;
  readonly expectedBlockHash?: Hash;
}): Promise<ProbeHeader> {
  const {
    publicClient,
    blockNumber,
    scope,
    expectedBlockHash,
  } = options;

  const startedAt = performance.now();

  try {
    const block = await publicClient.getBlock({
      blockNumber,
      includeTransactions: false,
    });

    if (
      block.number !== blockNumber ||
      !isFixedHex(block.hash, 32) ||
      !isFixedHex(block.parentHash, 32)
    ) {
      throw new Error('Invalid search lower-bound probe header.');
    }

    return Object.freeze({
      blockNumber,
      blockHash: block.hash,
      parentHash: block.parentHash,
    });
  } catch (error) {
    const context: AnchoredReadContext = {
      ...scope,
      method: 'eth_getBlockByNumber',
      blockNumber,
      durationMs: performance.now() - startedAt,
    };

    if (expectedBlockHash !== undefined) {
      context.expectedBlockHash = expectedBlockHash;
    }

    registerAnchoredReadFailure(error, context);

    throw error;
  }
}
