import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Hash,
  PublicClient,
} from 'viem';

import {
  recheckAttemptInclusion,
} from '../../src/chain/recheck-attempt-inclusion.js';

import type {
  JournalInclusionObservation,
} from '../../src/state/transaction-journal.js';

type SuccessfulInclusion = JournalInclusionObservation & {
  readonly outcome: 'success';
};

const HEAD_HASH = `0x${'aa'.repeat(32)}` as const;
const INCLUSION_HASH = `0x${'bb'.repeat(32)}` as const;

const HEAD = {
  blockNumber: 200n,
  blockHash: HEAD_HASH,
};

const INCLUSION = {
  blockNumber: 100n,
  blockHash: INCLUSION_HASH,
};

function transactionHash(index: number): Hash {
  return `0x${(index + 1).toString(16).padStart(64, '0')}`;
}

describe('retained inclusion RPC budget', () => {
  it.each([1, 8, 16, 32, 64])(
    'characterizes successful revalidation of %s retained inclusions',
    async (retainedCount) => {
      const getBlock = vi.fn(
        async ({ blockNumber }: { blockNumber?: bigint }) => {
          if (blockNumber === HEAD.blockNumber) {
            return {
              number: HEAD.blockNumber,
              hash: HEAD.blockHash,
            };
          }

          if (blockNumber === INCLUSION.blockNumber) {
            return {
              number: INCLUSION.blockNumber,
              hash: INCLUSION.blockHash,
            };
          }

          throw new Error('Unexpected block lookup.');
        },
      );

      const getTransactionReceipt = vi.fn(
        async ({ hash }: { hash: Hash }) => ({
          transactionHash: hash,
          blockNumber: INCLUSION.blockNumber,
          blockHash: INCLUSION.blockHash,
          status: 'success',
        }),
      );

      const publicClient = {
        getBlock,
        getTransactionReceipt,
      } as unknown as PublicClient;

      const observations: SuccessfulInclusion[] = Array.from(
        { length: retainedCount },
        (_, index): SuccessfulInclusion => ({
          outcome: 'success',
          transactionHash: transactionHash(index),
          inclusion: INCLUSION,
          observedAt: {
            blockNumber: 150n,
            blockHash: HEAD_HASH,
          },
        }),
      );

      // Characterize the per-attempt recheck only. Full inclusion
      // inspection and daemon recovery have additional RPC overhead.
      // Even records sharing an inclusion block are checked separately.
      for (const observation of observations) {
        expect(await recheckAttemptInclusion({
          publicClient,
          observation,
          head: HEAD,
        })).toEqual({
          status: 'verified-unchanged',
          observedAt: HEAD,
        });
      }

      const headReads = getBlock.mock.calls.filter(
        ([request]) => request.blockNumber === HEAD.blockNumber,
      );

      const inclusionReads = getBlock.mock.calls.filter(
        ([request]) => request.blockNumber === INCLUSION.blockNumber,
      );

      expect(headReads).toHaveLength(retainedCount * 2);
      expect(inclusionReads).toHaveLength(retainedCount);
      expect(getBlock).toHaveBeenCalledTimes(retainedCount * 3);
      expect(getTransactionReceipt).toHaveBeenCalledTimes(
        retainedCount,
      );

      expect(
        getBlock.mock.calls.length
        + getTransactionReceipt.mock.calls.length,
      ).toBe(retainedCount * 4);

      expect(getTransactionReceipt.mock.calls.map(
        ([request]) => request.hash,
      )).toEqual(observations.map(
        (observation) => observation.transactionHash,
      ));
    },
  );
});