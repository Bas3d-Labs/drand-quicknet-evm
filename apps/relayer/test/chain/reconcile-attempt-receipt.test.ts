import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from 'viem';

import {
  reconcileAttemptReceipt,
} from '../../src/chain/reconcile-attempt-receipt.js';

const HASH = `0x${'11'.repeat(32)}` as const;
const ANCHOR_HASH = `0x${'aa'.repeat(32)}` as const;
const BUMP_HASH = `0x${'22'.repeat(32)}` as const;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as const;
const FORK_HASH = `0x${'cc'.repeat(32)}` as const;

const anchor = {
  blockNumber: 110n,
  blockHash: ANCHOR_HASH,
};

function setup() {
  const calls: string[] = [];

  const receipt = {
    transactionHash: HASH as Hash,
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
    transactionHashes: [HASH],
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
      transactionHash: HASH,
      outcome: 'success',
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

  it.each(['success', 'reverted'] as const)(
    'finds a durable %s receipt for a later recorded hash',
    async (status) => {
      const fixture = setup();

      fixture.getTransactionReceipt
        .mockRejectedValueOnce(
          new TransactionReceiptNotFoundError({ hash: HASH }),
        )
        .mockResolvedValueOnce({
          ...fixture.receipt,
          transactionHash: BUMP_HASH,
          status,
        });

      const result = await reconcileAttemptReceipt({
        publicClient: fixture.publicClient,
        transactionHashes: [HASH, BUMP_HASH],
        anchor,
      });

      expect(result).toMatchObject({
        status: 'verified',
        evidence: {
          outcome: status,
          transactionHash: BUMP_HASH,
        },
      });

      expect(fixture.getTransactionReceipt)
        .toHaveBeenNthCalledWith(1, { hash: HASH });
      expect(fixture.getTransactionReceipt)
        .toHaveBeenNthCalledWith(2, { hash: BUMP_HASH });

      expect(fixture.getBlock.mock.calls.map(
        ([options]) => options.blockNumber,
      )).toEqual([110n, 109n, 110n]);
    },
  );

  it('continues past a fork-served receipt to a canonical recorded transaction', async () => {
    const fixture = setup();

    fixture.getTransactionReceipt
      .mockResolvedValueOnce({
        ...fixture.receipt,
        blockHash: FORK_HASH as typeof BLOCK_HASH,
      })
      .mockResolvedValueOnce({
        ...fixture.receipt,
        transactionHash: BUMP_HASH,
      });

    expect(await reconcileAttemptReceipt({
      publicClient: fixture.publicClient,
      transactionHashes: [HASH, BUMP_HASH],
      anchor,
    })).toMatchObject({
      status: 'verified',
      evidence: {
        transactionHash: BUMP_HASH,
      },
    });

    expect(fixture.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it('returns receipt absence only after checking every recorded hash', async () => {
    const fixture = setup();

    fixture.getTransactionReceipt
      .mockRejectedValueOnce(
        new TransactionReceiptNotFoundError({ hash: HASH }),
      )
      .mockRejectedValueOnce(
        new TransactionReceiptNotFoundError({ hash: BUMP_HASH }),
      );

    expect(await reconcileAttemptReceipt({
      publicClient: fixture.publicClient,
      transactionHashes: [HASH, BUMP_HASH],
      anchor,
    })).toEqual({
      status: 'receipt-not-found',
    });

    expect(fixture.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(fixture.getBlock).toHaveBeenCalledTimes(2);
  });

  it('rejects two canonically included recorded hashes', async () => {
    const fixture = setup();

    fixture.getTransactionReceipt
      .mockResolvedValueOnce({ ...fixture.receipt })
      .mockResolvedValueOnce({
        ...fixture.receipt,
        transactionHash: BUMP_HASH,
      });

    await expect(reconcileAttemptReceipt({
      publicClient: fixture.publicClient,
      transactionHashes: [HASH, BUMP_HASH],
      anchor,
    })).rejects.toThrow('Conflicting attempt receipt observations.');

    expect(fixture.getBlock.mock.calls.map(
      ([options]) => options.blockNumber,
    )).toEqual([110n, 109n, 109n, 110n]);
  });

  it('propagates a later RPC failure even after finding a receipt', async () => {
    const fixture = setup();
    const failure = new Error('RPC unavailable');

    fixture.getTransactionReceipt
      .mockResolvedValueOnce({ ...fixture.receipt })
      .mockRejectedValueOnce(failure);

    await expect(reconcileAttemptReceipt({
      publicClient: fixture.publicClient,
      transactionHashes: [HASH, BUMP_HASH],
      anchor,
    })).rejects.toBe(failure);
  });

  it('captures all hashes before the first RPC completes', async () => {
    const fixture = setup();
    const transactionHashes: Hash[] = [HASH, BUMP_HASH];

    fixture.getTransactionReceipt
      .mockRejectedValueOnce(
        new TransactionReceiptNotFoundError({ hash: HASH }),
      )
      .mockResolvedValueOnce({
        ...fixture.receipt,
        transactionHash: BUMP_HASH,
      });

    const pending = reconcileAttemptReceipt({
      publicClient: fixture.publicClient,
      transactionHashes,
      anchor,
    });

    transactionHashes[1] = FORK_HASH;
    transactionHashes.push(ANCHOR_HASH);

    expect(await pending).toMatchObject({
      status: 'verified',
      evidence: {
        transactionHash: BUMP_HASH,
      },
    });

    expect(fixture.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(fixture.getTransactionReceipt)
      .toHaveBeenNthCalledWith(2, { hash: BUMP_HASH });
  });

  it.each([
    { hashes: [] },
    { hashes: [HASH, HASH] },
    { hashes: [ANCHOR_HASH, `0x${'AA'.repeat(32)}`] },
    { hashes: ['invalid'] },
  ])('rejects invalid hash collections before RPC calls: %#', async ({ hashes }) => {
    const fixture = setup();

    await expect(reconcileAttemptReceipt({
      publicClient: fixture.publicClient,
      transactionHashes: hashes as Hash[],
      anchor,
    })).rejects.toThrow('Invalid receipt reconciliation input.');

    expect(fixture.getBlock).not.toHaveBeenCalled();
    expect(fixture.getTransactionReceipt).not.toHaveBeenCalled();
  });
});