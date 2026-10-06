import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';

import {
  reconcileAttemptReceipt,
} from '../../src/chain/reconcile-attempt-receipt.js';

const HASH = `0x${'11'.repeat(32)}` as const;
const ANCHOR_HASH = `0x${'aa'.repeat(32)}` as const;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as const;
const FORK_HASH = `0x${'cc'.repeat(32)}` as const;

const anchor = {
  blockNumber: 110n,
  blockHash: ANCHOR_HASH,
};

function setup() {
  const calls: string[] = [];

  const receipt = {
    transactionHash: HASH,
    blockNumber: 109n,
    blockHash: BLOCK_HASH,
    status: 'success',
  };

  const getBlock = vi.fn(
    async ({ blockNumber }: { blockNumber: bigint }) => {
      calls.push(`block:${blockNumber}`);

      if (blockNumber === 110n) {
        return {
          number: blockNumber,
          hash: ANCHOR_HASH,
        };
      }

      return {
        number: blockNumber,
        hash: BLOCK_HASH,
      };
    },
  );

  const getTransactionReceipt = vi.fn(async () => {
    calls.push('receipt');
    return receipt;
  });

  const publicClient = {
    getBlock,
    getTransactionReceipt,
  } as unknown as PublicClient;

  const run = () => reconcileAttemptReceipt({
    publicClient,
    transactionHash: HASH,
    anchor,
  });

  return {
    calls,
    receipt,
    getBlock,
    getTransactionReceipt,
    publicClient,
    run,
  };
}

describe('attempt receipt reconciliation', () => {
  it.each(['success', 'reverted'])(
    'verifies durable %s inside the anchor bracket',
    async (status) => {
      const fixture = setup();
      fixture.receipt.status = status;

      const result = await fixture.run();

      expect(result).toEqual({
        status: 'verified',
        evidence: {
          outcome: status,
          transactionHash: HASH,
          anchor,
          inclusion: {
            blockNumber: 109n,
            blockHash: BLOCK_HASH,
          },
        },
      });

      expect(fixture.calls).toEqual([
        'block:110',
        'receipt',
        'block:109',
        'block:110',
      ]);

      expect(fixture.getTransactionReceipt)
        .toHaveBeenCalledExactlyOnceWith({
          hash: HASH,
        });

      if (result.status !== 'verified') {
        throw new Error('Expected evidence.');
      }

      expect(Object.isFrozen(result.evidence)).toBe(true);
      expect(Object.isFrozen(result.evidence.anchor)).toBe(true);

      fixture.receipt.blockNumber = 99n;

      expect(result.evidence.inclusion.blockNumber).toBe(109n);
    },
  );

  it('accepts inclusion at the anchor itself', async () => {
    const fixture = setup();

    fixture.receipt.blockNumber = 110n;
    fixture.receipt.blockHash = ANCHOR_HASH as typeof BLOCK_HASH;

    expect(await fixture.run()).toMatchObject({
      status: 'verified',
    });
  });

  it('does not construct resolution evidence above the anchor', async () => {
    const fixture = setup();
    fixture.receipt.blockNumber = 111n;

    expect(await fixture.run()).toEqual({
      status: 'included-not-durable',
      inclusion: {
        blockNumber: 111n,
        blockHash: BLOCK_HASH,
      },
    });
  });

  it('reports a fork-served receipt as an observation', async () => {
    const fixture = setup();
    fixture.receipt.blockHash = FORK_HASH as typeof BLOCK_HASH;

    expect(await fixture.run()).toEqual({
      status: 'fork-served-receipt',
      inclusion: {
        blockNumber: 109n,
        blockHash: FORK_HASH,
      },
      canonicalBlock: {
        blockNumber: 109n,
        blockHash: BLOCK_HASH,
      },
    });
  });

  it('stops before receipt lookup if the selected anchor changed', async () => {
    const fixture = setup();

    fixture.getBlock.mockResolvedValueOnce({
      number: 110n,
      hash: FORK_HASH,
    });

    expect(await fixture.run()).toMatchObject({
      status: 'anchor-changed',
    });

    expect(fixture.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('discards receipt evidence when the closing anchor changes', async () => {
    const fixture = setup();

    fixture.getBlock
      .mockResolvedValueOnce({
        number: 110n,
        hash: ANCHOR_HASH,
      })
      .mockResolvedValueOnce({
        number: 109n,
        hash: BLOCK_HASH,
      })
      .mockResolvedValueOnce({
        number: 110n,
        hash: FORK_HASH,
      });

    expect(await fixture.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 110n,
        blockHash: FORK_HASH,
      },
    });
  });

  it('recognizes only explicit receipt absence and closes its anchor bracket', async () => {
    const fixture = setup();

    fixture.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({
        hash: HASH,
      }),
    );

    expect(await fixture.run()).toEqual({
      status: 'receipt-not-found',
    });

    expect(fixture.getBlock).toHaveBeenCalledTimes(2);
  });

  it.each([
    'opening',
    'receipt',
    'inclusion',
    'closing',
  ])(
    'propagates %s RPC failure without evidence',
    async (stage) => {
      const fixture = setup();
      const failure = new Error('RPC unavailable');

      if (stage === 'receipt') {
        fixture.getTransactionReceipt.mockRejectedValueOnce(failure);
      } else {
        if (stage !== 'opening') {
          fixture.getBlock.mockResolvedValueOnce({
            number: 110n,
            hash: ANCHOR_HASH,
          });
        }

        if (stage === 'closing') {
          fixture.getBlock.mockResolvedValueOnce({
            number: 109n,
            hash: BLOCK_HASH,
          });
        }

        fixture.getBlock.mockRejectedValueOnce(failure);
      }

      await expect(fixture.run()).rejects.toBe(failure);
    },
  );

  it.each([
    { transactionHash: FORK_HASH },
    { blockHash: 'invalid' },
    { blockNumber: -1n },
    { status: 'unknown' },
  ])(
    'rejects invalid receipt metadata %#',
    async (invalid) => {
      const fixture = setup();
      Object.assign(fixture.receipt, invalid);

      await expect(fixture.run()).rejects.toThrow(
        'Invalid attempt receipt response.',
      );
    },
  );
});