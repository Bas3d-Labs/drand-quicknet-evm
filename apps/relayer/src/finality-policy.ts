import type {
  PublicClient,
} from 'viem';

export type FinalityPolicy = 
  | {
      type: 'safe';
    }
  | {
      type: 'finalized';
    }
  | {
      type: 'confirmations';
      confirmations: bigint;
    };

export async function getDurableBlockNumber(
  publicClient: PublicClient,
  policy: FinalityPolicy,
): Promise<bigint> {
  switch (policy.type) {
    case 'safe': {
      const block = await publicClient.getBlock({
        blockTag: 'safe',
      });

      return block.number;
    }

    case 'finalized': {
      const block = await publicClient.getBlock({
        blockTag: 'finalized',
      });

      return block.number;
    }

    case 'confirmations': {
      if (policy.confirmations < 0n) {
        throw new Error('Finality confirmations must not be negative.');
      }

      const latest = await publicClient.getBlockNumber();
      if (latest <= policy.confirmations) {
        return 0n;
      }

      return latest - policy.confirmations;
    }
  }
}