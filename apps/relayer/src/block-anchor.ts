import type {
  Hash,
  PublicClient,
} from 'viem';

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