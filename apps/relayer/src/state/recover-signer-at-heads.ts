import type {
  PublicClient,
} from 'viem';

import {
  getBlockAnchor,
} from '../chain/block-anchor.js';

import type {
  ChainHeads,
} from '../chain/chain-heads.js';

import type {
  SignerRecoveryCycle,
  SignerRecoveryCycleResult,
} from './signer-recovery-cycle.js';

export interface RecoverSignerAtHeadsOptions {
  readonly publicClient: PublicClient;
  readonly recovery: Pick<SignerRecoveryCycle, 'run'>;
  readonly readChainHeads: () => Promise<ChainHeads>;
  readonly maxBlockRange: bigint;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Runs signer recovery against selected durable and latest block anchors.
 * Reuses the caller's recovery cycle so broacast backoff survives passes.
 */
export async function recoverSignerAtHeads(
  options: RecoverSignerAtHeadsOptions,
  cycle?: number,
): Promise<SignerRecoveryCycleResult> {
  const {
    publicClient,
    recovery,
    readChainHeads,
    maxBlockRange,
    signal,
  } = options;

  signal?.throwIfAborted();

  const {
    durableBlock,
    latestBlock,
  } = await readChainHeads();

  signal?.throwIfAborted();

  if (durableBlock > latestBlock) {
    throw new Error(
      'Cannot recover a signer with the durable block ahead of latest.'
    );
  }

  const anchor = await getBlockAnchor(
    publicClient,
    durableBlock,
  );

  signal?.throwIfAborted();

  let head = anchor;

  if (latestBlock !== durableBlock) {
    head = await getBlockAnchor(
      publicClient,
      latestBlock,
    );

    signal?.throwIfAborted();
  }

  if (signal !== undefined) {
    return recovery.run({
      publicClient,
      anchor,
      head,
      maxBlockRange,
      signal,
    }, cycle);
  }

  return recovery.run({
    publicClient,
    anchor,
    head,
    maxBlockRange,
  }, cycle);
}