import type {
  PublicClient,
} from 'viem';

import {
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import {
  getChainHeads,
} from './chain-heads.js';

import type {
  FinalityPolicy,
} from './finality-policy.js';

import {
  inspectSignerBootstrap,
} from './inspect-signer-bootstrap.js';

import type {
  AnchoredNonceObservation,
  JournalIdentity,
} from '../state/transaction-journal.js';

export interface InspectNonceSyncOptions {
  readonly publicClient: PublicClient;
  readonly identity: JournalIdentity;
  readonly finality: FinalityPolicy;
  readonly signal?: AbortSignal;
}

export type NonceSyncInspection =
  | {
      readonly status: 'observed';
      readonly observation: AnchoredNonceObservation;
      readonly latestNonce: bigint;
      readonly pendingNonce: bigint;
    }
  | {
      readonly status: 'anchor-changed';
      readonly observedAnchor: Readonly<BlockAnchor>;
    };

/**
 * Collects chain-verified nonce observations without modifying state.
 * 
 * Matching counts describe this RPC provider's view. They do not prove
 * the absence of untracked sign transactions or hidden pending work.
 */
export async function inspectNonceSync(
  options: InspectNonceSyncOptions,
): Promise<NonceSyncInspection> {
  const {
    publicClient,
    signal
  } = options;

  // Capture identity before awaiting external work.
  const identity = Object.freeze({
    chainId: options.identity.chainId,
    signer: options.identity.signer,
  });

  signal?.throwIfAborted();

  const chainId = await publicClient.getChainId();

  signal?.throwIfAborted();

  if (
    !Number.isSafeInteger(chainId) ||
    chainId !== identity.chainId
  ) {
    throw new Error('Nonce sync RPC chain ID does not match journal identity.');
  }

  const heads = await getChainHeads({
    publicClient,
    finality: options.finality,
  });

  signal?.throwIfAborted();

  const anchor = await getBlockAnchor(
    publicClient,
    heads.durableBlock,
  );

  signal?.throwIfAborted();

  const inspection = await inspectSignerBootstrap({
    publicClient,
    signer: identity.signer,
    anchor,
  });

  signal?.throwIfAborted();

  switch (inspection.status) {
    case 'anchor-changed':
      return Object.freeze({
        status: 'anchor-changed',
        observedAnchor: inspection.observedAnchor,
      });

    case 'bootstrap-deferred':
      return Object.freeze({
        status: 'observed',
        observation: inspection.observation,
        latestNonce: inspection.latestNonce,
        pendingNonce: inspection.pendingNonce,
      });

    case 'ready':
      // The bootstrap inspector returns ready when all three
      // counts equal the verified durable observation.
      return Object.freeze({
        status: 'observed',
        observation: inspection.observation,
        latestNonce: inspection.observation.nonce,
        pendingNonce: inspection.observation.nonce,
      });
  }
}