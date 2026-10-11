import type {
  Address,
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

import type {
  AnchoredNonceObservation,
} from '../state/transaction-journal.js';

export interface InspectSignerBootstrapOptions {
  readonly publicClient: PublicClient;
  readonly signer: Address;
  readonly anchor: Readonly<BlockAnchor>;
}

export type SignerBootstrapDecision =
  | {
      readonly status: 'ready';
      readonly observation: AnchoredNonceObservation;
    }
  | {
      readonly status: 'bootstrap-deferred';
      readonly reason: 'nonce-count-mismatch';
      readonly observation: AnchoredNonceObservation;
      readonly latestNonce: bigint;
      readonly pendingNonce: bigint;
    }
  | {
      readonly status: 'anchor-changed';
      readonly observedAnchor: Readonly<BlockAnchor>;
    };

/**
 * Determines whether a missing journal can adopt the selected durable
 * nonce as its initial baseline.
 * 
 * Requires a dedicated signer with no untracked outstanding transactions.
 * Matching RPC counts cannot establish that assumption by themselves.
 */
export async function inspectSignerBootstrap(
  options: InspectSignerBootstrapOptions,
): Promise<SignerBootstrapDecision> {
  const {
    publicClient,
    signer,
  } = options;

  const result = await readAnchoredNonce({
    publicClient,
    signer,
    anchor: options.anchor,
  });

  if (result.status === 'anchor-changed') {
    return result;
  }

  const { observation } = result;

  async function readLiveNonce(
    blockTag: 'latest' | 'pending',
  ): Promise<bigint> {
    const nonce = await publicClient.getTransactionCount({
      address: signer,
      blockTag,
    });

    if (
      !Number.isSafeInteger(nonce) ||
      nonce < 0
    ) {
      throw new TypeError('Invalid bootstrap nonce response.');
    }

    return BigInt(nonce);
  }

  const latestNonce = await readLiveNonce('latest');
  const pendingNonce = await readLiveNonce('pending');

  const closingAnchor = await getBlockAnchor(
    publicClient,
    observation.anchor.blockNumber,
  );

  if (!blockAnchorsMatch(observation.anchor, closingAnchor)) {
    return {
      status: 'anchor-changed',
      observedAnchor: Object.freeze(closingAnchor),
    };
  }

  if (
    latestNonce !== observation.nonce ||
    pendingNonce !== observation.nonce
  ) {
    return {
      status: 'bootstrap-deferred',
      reason: 'nonce-count-mismatch',
      observation,
      latestNonce,
      pendingNonce,
    };
  }

  return {
    status: 'ready',
    observation,
  };
}