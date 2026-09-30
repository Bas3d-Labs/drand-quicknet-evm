import {
  type Hash,
  type PublicClient,
} from 'viem';

import {
  isFixedHex,
} from '../shared/hex.js';

export interface BlockAnchor {
  blockNumber: bigint;
  blockHash: Hash;
}

export async function getBlockAnchor(
  publicClient: PublicClient,
  blockNumber: bigint,
): Promise<BlockAnchor> {
  if (blockNumber < 0n) {
    throw new Error('Block anchor number must not be negative.');
  }

  const block = await publicClient.getBlock({
    blockNumber,
  });

  if (
    block.number !== blockNumber ||
    !isFixedHex(block.hash, 32)
  ) {
    throw new Error('Invalid block anchor response.');
  }

  return {
    blockNumber,
    blockHash: block.hash,
  };
}

export function blockAnchorsMatch(
  first: BlockAnchor,
  second: BlockAnchor,
): boolean {
  return (
    first.blockNumber === second.blockNumber &&
    first.blockHash.toLowerCase() === second.blockHash.toLowerCase()
  );
}