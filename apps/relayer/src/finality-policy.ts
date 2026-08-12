import type {
  PublicClient,
} from 'viem';
import { isDecimalInteger } from './decimal.js';

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

export const FinalityPolicy = {
  parseJson(value: unknown): FinalityPolicy {
    if (!isObject(value)) {
      throw new Error('Finality policy must be an object.');
    }

    switch (value.type) {
      case 'safe':
        assertExactKeys(value, ['type']);
        return { type: 'safe' };

      case 'finalized':
        assertExactKeys(value, ['type']);
        return { type: 'finalized' };
      
      case 'confirmations':
        assertExactKeys(value, ['type', 'confirmations']);
        if (
          typeof value.confirmations !== 'string' ||
          !isDecimalInteger(value.confirmations)
        ) {
          throw new Error('Finality confirmations must be a non-negative decimal integer string.');
        }

        return {
          type: 'confirmations',
          confirmations: BigInt(value.confirmations),
        };

      default:
        throw new Error('Finality policy type must be safe, finalized, or confirmations.');
    }
  },
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

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const expected = new Set(expectedKeys);

  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`Unexpected finality policy field: ${key}.`);
    }
  }

  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Missing finality policy field: ${key}.`);
    }
  }
}

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}