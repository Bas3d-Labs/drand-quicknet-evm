import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  inspectSignerRecovery,
  type InspectSignerRecoveryOptions,
} from '../../src/chain/inspect-signer-recovery.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const OTHER = `0x${'bb'.repeat(32)}` as const;

const hashAt = (number: bigint) =>
  `0x${number.toString(16).padStart(64, '0')}` as Hash;

const anchorAt = (number: bigint) => ({
  blockNumber: number,
  blockHash: hashAt(number),
});

async function setup() {
  const bytes = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: 4663,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  const hash = keccak256(bytes);

  const lowerBound = {
    anchor: anchorAt(100n),
    nonce: 4n,
  };

  const snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: {
      chainId: 4663,
      signer: ACCOUNT.address,
    },
    baseline: lowerBound,
    lastObservation: lowerBound,
    nextNonce: 4n,
    attempt: {
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      transactionHash: hash,
      signedTransaction: bytes,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      replacementSearch: null,
    },
  };

  const transactions = new Map<bigint, unknown[]>();
  const order: string[] = [];

  const getBlock = vi.fn(async (request: {
    blockNumber: bigint;
    includeTransactions?: boolean;
  }) => {
    if (request.includeTransactions) {
      order.push('scan');
    }

    return {
      number: request.blockNumber,
      hash: hashAt(request.blockNumber),
      parentHash: hashAt(request.blockNumber - 1n),
      transactions: transactions.get(request.blockNumber) ?? [],
    };
  });

  const getTransactionReceipt = vi.fn(async () => ({
    transactionHash: hash,
    blockNumber: 102n,
    blockHash: hashAt(102n),
    status: 'success' as 'success' | 'reverted',
  }));

  const getTransactionCount = vi.fn(async () => 5);

  const options: InspectSignerRecoveryOptions = {
    publicClient: {
      getBlock,
      getTransactionReceipt: () => {
        order.push('receipt');
        return getTransactionReceipt();
      },
      getTransactionCount: () => {
        order.push('nonce');
        return getTransactionCount();
      },
    } as unknown as PublicClient,
    snapshot,
    anchor: anchorAt(105n),
    maxBlockRange: 2n,
  };

  const missing = () => getTransactionReceipt.mockRejectedValue(
    new TransactionReceiptNotFoundError({ hash }),
  );

  const run = (
    overrides: Partial<InspectSignerRecoveryOptions> = {},
  ) => inspectSignerRecovery({
    ...options,
    ...overrides,
  });

  return {
    options,
    snapshot,
    hash,
    bytes,
    transactions,
    order,
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    missing,
    run,
  };
}

describe('signer recovery inspection', () => {
  it.each(['success', 'reverted'] as const)(
    'checks receipt then nonce before returning %s evidence',
    async (status) => {
      const t = await setup();

      t.getTransactionReceipt.mockResolvedValueOnce({
        transactionHash: t.hash,
        blockNumber: 102n,
        blockHash: hashAt(102n),
        status,
      });

      const result = await t.run();

      expect(result).toMatchObject({
        status: 'resolution-available',
        observation: {
          anchor: anchorAt(105n),
          nonce: 5n,
        },
        evidence: {
          outcome: status,
          transactionHash: t.hash,
        },
      });

      expect(t.order).toEqual(['receipt', 'nonce']);

      expect(JSON.stringify(result, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      )).not.toContain(t.bytes);
    },
  );

  it('includes excess nonce activity alongside receipt evidence', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(8);

    expect(await t.run()).toMatchObject({
      status: 'resolution-available',
      observation: {
        nonce: 8n,
      },
    });
  });

  it('reads only the nonce when there is no attempt', async () => {
    const t = await setup();

    expect(await t.run({
      snapshot: {
        ...t.snapshot,
        attempt: null,
      },
    })).toMatchObject({
      status: 'no-attempt',
      observation: {
        nonce: 5n,
      },
    });

    expect(t.order).toEqual(['nonce']);
  });

  it('does not offer resolution when the nonce is behind the journal', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(3);

    expect(await t.run()).toMatchObject({
      status: 'nonce-behind-journal',
    });
  });

  it('rejects a durable receipt paired with an unconsumed nonce', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(4);

    expect(await t.run()).toMatchObject({
      status: 'inconsistent-observations',
    });

    expect(t.order).toEqual(['receipt', 'nonce']);
  });

  it('rejects a later inclusion paired with an already consumed nonce', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValue({
      transactionHash: t.hash,
      blockNumber: 106n,
      blockHash: hashAt(106n),
      status: 'success',
    });

    expect(await t.run()).toMatchObject({
      status: 'inconsistent-observations',
    });

    expect(t.order).toEqual(['receipt', 'nonce']);
  });

  it('keeps a missing receipt unresolved without scanning an unconsumed nonce', async () => {
    const t = await setup();

    t.missing();
    t.getTransactionCount.mockResolvedValue(4);

    expect(await t.run()).toMatchObject({
      status: 'unresolved',
      receipt: {
        status: 'receipt-not-found',
      },
      search: null,
    });

    expect(t.order).toEqual(['receipt', 'nonce']);
  });

  it('searches from the recorded observation and respects the block budget', async () => {
    const t = await setup();

    t.missing();

    expect(await t.run()).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        searchedThrough: anchorAt(102n),
        scannedBlocks: 2n,
        remainingBlocks: 3n,
      },
    });

    expect(t.snapshot.attempt!.replacementSearch).toBeNull();

    expect(t.order).toEqual([
      'receipt',
      'nonce',
      'scan',
      'scan',
    ]);
  });

  it('returns replacement evidence after identifying the consuming transaction', async () => {
    const t = await setup();

    t.missing();

    t.transactions.set(101n, [{
      hash: OTHER,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    expect(await t.run()).toMatchObject({
      status: 'resolution-available',
      evidence: {
        outcome: 'replaced',
        replacementTransactionHash: OTHER,
      },
    });
  });

  it('leaves the recorded hash unresolved until a receipt becomes available', async () => {
    const t = await setup();

    t.missing();

    t.transactions.set(101n, [{
      hash: t.hash,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    expect(await t.run()).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'recorded-transaction-found',
      },
    });

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('does not invent a lower bound when the saved nonce already advanced', async () => {
    const t = await setup();

    t.missing();

    expect(await t.run({
      snapshot: {
        ...t.snapshot,
        lastObservation: {
          anchor: anchorAt(104n),
          nonce: 5n,
        },
      },
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'missing-lower-bound',
      },
    });

    expect(t.order).toEqual(['receipt', 'nonce']);
  });

  it('discards receipt evidence when the anchor changes during the nonce read', async () => {
    const t = await setup();

    t.getTransactionCount.mockImplementationOnce(async () => {
      t.getBlock.mockResolvedValueOnce({
        number: 105n,
        hash: OTHER,
        parentHash: hashAt(104n),
        transactions: [],
      });

      return 5;
    });

    expect(await t.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 105n,
        blockHash: OTHER,
      },
    });
  });

  it('stops before nonce lookup when the receipt anchor changed', async () => {
    const t = await setup();

    t.getBlock.mockResolvedValueOnce({
      number: 105n,
      hash: OTHER,
      parentHash: hashAt(104n),
      transactions: [],
    });

    expect(await t.run()).toMatchObject({
      status: 'anchor-changed',
    });

    expect(t.getTransactionCount).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'nonce', 'scan'] as const)(
    'propagates %s RPC failures without returning a decision',
    async (phase) => {
      const t = await setup();
      const error = new Error('RPC unavailable');

      if (phase === 'receipt') {
        t.getTransactionReceipt.mockRejectedValue(error);
      }

      if (phase === 'nonce') {
        t.getTransactionCount.mockRejectedValue(error);
      }

      if (phase === 'scan') {
        t.missing();

        const read = t.getBlock.getMockImplementation()!;

        t.getBlock.mockImplementation(async (request) => {
          if (request.includeTransactions) {
            throw error;
          }

          return read(request);
        });
      }

      await expect(t.run()).rejects.toBe(error);
    },
  );

  it('searches after a fork-served receipt instead of accepting its outcome', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValue({
      transactionHash: t.hash,
      blockNumber: 102n,
      blockHash: OTHER,
      status: 'success',
    });

    expect(await t.run()).toMatchObject({
      status: 'unresolved',
      receipt: {
        status: 'fork-served-receipt',
      },
      search: {
        status: 'not-found',
      },
    });
  });

  it('resumes an existing search without replacing its lower bound', async () => {
    const t = await setup();

    t.missing();

    const attempt = t.snapshot.attempt!;

    expect(await t.run({
      snapshot: {
        ...t.snapshot,
        lastObservation: {
          anchor: anchorAt(104n),
          nonce: 5n,
        },
        attempt: {
          ...attempt,
          replacementSearch: {
            lowerBound: t.snapshot.baseline,
            searchedThrough: anchorAt(102n),
          },
        },
      },
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        searchedThrough: anchorAt(104n),
        scannedBlocks: 2n,
        remainingBlocks: 1n,
      },
    });

    expect(
      t.getBlock.mock.calls
        .filter(([request]) => request.includeTransactions)
        .map(([request]) => request.blockNumber),
    ).toEqual([103n, 104n]);
  });

  it('discards the nonce observation when the search anchor changes', async () => {
    const t = await setup();

    t.missing();

    const read = t.getBlock.getMockImplementation()!;

    t.getBlock.mockImplementation(async (request) => {
      const block = await read(request);

      if (request.includeTransactions) {
        t.getBlock.mockResolvedValueOnce({
          number: 105n,
          hash: OTHER,
          parentHash: hashAt(104n),
          transactions: [],
        });
      }

      return block;
    });

    expect(await t.run({
      maxBlockRange: 1n,
    })).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 105n,
        blockHash: OTHER,
      },
    });
  });

  it('captures the snapshot and anchor before the first RPC finishes', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockImplementationOnce(async () => {
      Object.assign(t.options.anchor, anchorAt(200n));

      Object.assign(t.snapshot.lastObservation, {
        nonce: 8n,
      });

      Object.assign(t.snapshot.attempt!, {
        nonce: 8n,
      });

      throw new TransactionReceiptNotFoundError({
        hash: t.hash,
      });
    });

    expect(await t.run()).toMatchObject({
      status: 'unresolved',
      observation: {
        anchor: anchorAt(105n),
        nonce: 5n,
      },
      search: {
        status: 'not-found',
        searchedThrough: anchorAt(102n),
      },
    });
  });

  it('rejects an invalid budget before making RPC calls', async () => {
    const t = await setup();

    await expect(t.run({
      maxBlockRange: 0n,
    })).rejects.toThrow(TypeError);

    expect(t.getBlock).not.toHaveBeenCalled();
  });
});