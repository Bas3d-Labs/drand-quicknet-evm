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

async function signedTransaction(
  nonce: number,
  maxFeePerGas = 2n,
) {
  const signedTransaction = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: 4663,
    nonce,
    gas: 21_000n,
    to: ACCOUNT.address,
    maxFeePerGas,
    maxPriorityFeePerGas: 1n,
  });

  return {
    transactionHash: keccak256(signedTransaction),
    signedTransaction,
  };
}

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
    nextNonce: 5n,
    durableNextNonce: 4n,
    repairs: [],
    attempts: [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      workId: 'test-work:4',
      nonce: 4n,
      signedTransactions: [{
        transactionHash: hash,
        signedTransaction: bytes,
      }],
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      replacementSearch: null,
    }],
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

  const getTransactionReceipt = vi.fn(
    async (_request: { hash: Hash }) => ({
      transactionHash: hash,
      blockNumber: 102n,
      blockHash: hashAt(102n),
      status: 'success' as 'success' | 'reverted',
    }),
  );

  const getTransactionCount = vi.fn(async () => 5);

  const options: InspectSignerRecoveryOptions = {
    publicClient: {
      getBlock,
      getTransactionReceipt: (request: { hash: Hash }) => {
        order.push('receipt');
        return getTransactionReceipt(request);
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
        nextNonce: 4n,
        durableNextNonce: 4n,
        attempts: [],
      },
    })).toMatchObject({
      status: 'no-attempt',
      observations: [],
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

    expect(t.snapshot.attempts[0]!.replacementSearch).toBeNull();

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

    const attempt = t.snapshot.attempts[0]!;

    expect(await t.run({
      snapshot: {
        ...t.snapshot,
        lastObservation: {
          anchor: anchorAt(104n),
          nonce: 5n,
        },
        attempts: [{
          ...attempt,
          replacementSearch: {
            exhausted: null,
            lowerBound: t.snapshot.baseline,
            searchedThrough: anchorAt(102n),
          },
        }],
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

      Object.assign(t.snapshot.attempts[0]!, {
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

  it('offers resolution below allocation progress and inspects only the oldest record', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const secondTransaction = await signedTransaction(5);

    const snapshot: TransactionJournalSnapshot = {
      ...t.snapshot,
      nextNonce: 6n,
      attempts: [
        {
          ...first,
          phase: 'included',
          inclusion: {
            outcome: 'success',
            transactionHash: t.hash,
            inclusion: anchorAt(102n),
            observedAt: anchorAt(105n),
          },
        },
        {
          ...first,
          attemptId: '22222222-2222-4222-8222-222222222222',
          workId: 'test-work:5',
          nonce: 5n,
          signedTransactions: [secondTransaction],
        },
      ],
    };

    const result = await t.run({ snapshot });

    expect(result).toMatchObject({
      status: 'resolution-available',
      observation: {
        nonce: 5n,
      },
      evidence: {
        outcome: 'success',
        transactionHash: t.hash,
      },
    });

    expect(t.getTransactionReceipt)
      .toHaveBeenCalledExactlyOnceWith({ hash: t.hash });

    expect(snapshot.nextNonce).toBe(6n);
    expect(snapshot.durableNextNonce).toBe(4n);
    expect(snapshot.attempts).toHaveLength(2);
  });

  it('rejects a nonce below advanced durable progress', async () => {
    const t = await setup();
    const signed = await signedTransaction(5);

    const snapshot: TransactionJournalSnapshot = {
      ...t.snapshot,
      nextNonce: 6n,
      durableNextNonce: 5n,
      attempts: [{
        ...t.snapshot.attempts[0]!,
        nonce: 5n,
        signedTransactions: [signed],
      }],
    };

    t.getTransactionReceipt.mockResolvedValue({
      transactionHash: signed.transactionHash,
      blockNumber: 102n,
      blockHash: hashAt(102n),
      status: 'success',
    });

    t.getTransactionCount.mockResolvedValue(4);

    expect(await t.run({ snapshot })).toMatchObject({
      status: 'nonce-behind-journal',
      observation: {
        nonce: 4n,
      },
    });

    expect(t.order).toEqual(['receipt', 'nonce']);
  });

  it.each(['success', 'reverted'] as const)(
    'accepts durable %s evidence for a recorded fee replacement',
    async (status) => {
      const t = await setup();
      const first = t.snapshot.attempts[0]!;
      const bump = await signedTransaction(4, 4n);

      const snapshot: TransactionJournalSnapshot = {
        ...t.snapshot,
        attempts: [{
          ...first,
          signedTransactions: [
            first.signedTransactions[0],
            bump,
          ],
        }],
      };

      t.getTransactionReceipt
        .mockRejectedValueOnce(
          new TransactionReceiptNotFoundError({ hash: t.hash }),
        )
        .mockResolvedValueOnce({
          transactionHash: bump.transactionHash,
          blockNumber: 102n,
          blockHash: hashAt(102n),
          status,
        });

      expect(await t.run({ snapshot })).toMatchObject({
        status: 'resolution-available',
        evidence: {
          outcome: status,
          transactionHash: bump.transactionHash,
        },
      });

      expect(t.getTransactionReceipt)
        .toHaveBeenNthCalledWith(1, { hash: t.hash });
      expect(t.getTransactionReceipt)
        .toHaveBeenNthCalledWith(2, { hash: bump.transactionHash });

      expect(t.order).toEqual(['receipt', 'receipt', 'nonce']);
    },
  );

  it('keeps a scanned recorded fee replacement unresolved without a receipt', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const bump = await signedTransaction(4, 4n);

    const snapshot: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...first,
        signedTransactions: [
          first.signedTransactions[0],
          bump,
        ],
      }],
    };

    t.missing();

    t.transactions.set(101n, [{
      hash: bump.transactionHash,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    expect(await t.run({ snapshot })).toMatchObject({
      status: 'unresolved',
      receipt: {
        status: 'receipt-not-found',
      },
      search: {
        status: 'recorded-transaction-found',
        transactionHash: bump.transactionHash,
      },
    });

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(t.order).toEqual([
      'receipt',
      'receipt',
      'nonce',
      'scan',
    ]);
  });
});
describe('durable inspection block observations', () => {
  it('forwards receipt and replacement-search headers in read order', async () => {
    const t = await setup();

    // The receipt claims a different hash. Evidence must retain the hash
    // actually read at that height, even though the receipt is unusable.
    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: t.hash,
      blockNumber: 102n,
      blockHash: OTHER,
      status: 'success',
    });
    t.transactions.set(101n, [{
      hash: OTHER,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    const result = await t.run();

    expect(result).toMatchObject({
      status: 'resolution-available',
      observations: [anchorAt(102n), anchorAt(100n), anchorAt(101n)],
      evidence: { outcome: 'replaced' },
    });
  });

  it('keeps above-anchor receipt reads for classification but excludes them from durable evidence', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: t.hash,
      blockNumber: 106n,
      blockHash: hashAt(106n),
      status: 'success',
    });
    t.getTransactionCount.mockResolvedValue(4);

    expect(await t.run()).toMatchObject({
      status: 'unresolved',
      observations: [],
      receipt: {
        status: 'included-not-durable',
        observations: [anchorAt(106n)],
      },
    });
  });

  it('forwards a fork-served header without requiring a journal write decision', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: t.hash,
      blockNumber: 102n,
      blockHash: OTHER,
      status: 'success',
    });
    t.getTransactionCount.mockResolvedValue(4);

    expect(await t.run()).toMatchObject({
      status: 'unresolved',
      observations: [anchorAt(102n)],
      receipt: { status: 'fork-served-receipt' },
      search: null,
    });
  });

  it('discards receipt observations when the subsequent nonce bracket fails', async () => {
    const t = await setup();
    const read = t.getBlock.getMockImplementation()!;
    let anchorReads = 0;

    t.getBlock.mockImplementation(async (request) => {
      const block = await read(request);

      // Receipt opening/closing, then nonce opening/closing.
      if (request.blockNumber === 105n && ++anchorReads === 4) {
        return { ...block, hash: OTHER };
      }

      return block;
    });

    const result = await t.run();

    expect(result.status).toBe('anchor-changed');
    expect(result).not.toHaveProperty('observations');
  });
});


describe('stored exhaustion consistency', () => {
  it('refuses an anchor below a retained fact before RPC', async () => {
    const t = await setup();
    const exhausted = { anchor: anchorAt(106n), nonce: 5n };
    const snapshot: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...t.snapshot.attempts[0]!,
        replacementSearch: {
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
          exhausted,
        },
      }],
    };
    expect(await t.run({ snapshot })).toEqual({
      status: 'anchor-behind-exhaustion', anchor: anchorAt(105n), exhausted,
    });
    expect(t.order).toEqual([]);
    expect(t.getBlock).not.toHaveBeenCalled();
  });

  it.each([
    { searchedThrough: null, nonce: 4 },
    { searchedThrough: null, nonce: 5 },
    { searchedThrough: null, nonce: 6 },
    { searchedThrough: anchorAt(105n), nonce: 4 },
    { searchedThrough: anchorAt(105n), nonce: 5 },
    { searchedThrough: anchorAt(105n), nonce: 6 },
  ])(
    'confirms a changed exhaustion hash without scanning: %#',
    async ({ searchedThrough, nonce }) => {
      const t = await setup();
      const exhausted = { anchor: anchorAt(105n), nonce: 5n };
      const anchor = { blockNumber: 105n, blockHash: OTHER };
      const snapshot: TransactionJournalSnapshot = {
        ...t.snapshot,
        attempts: [{
          ...t.snapshot.attempts[0]!,
          replacementSearch: {
            lowerBound: t.snapshot.baseline,
            searchedThrough,
            exhausted,
          },
        }],
      };
      const before = structuredClone(snapshot);

      const read = t.getBlock.getMockImplementation()!;
      t.getBlock.mockImplementation(async (request) => {
        const block = await read(request);
        if (request.blockNumber === 105n) return { ...block, hash: OTHER };
        return block;
      });
      t.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: t.hash }));
      t.getTransactionCount.mockResolvedValue(nonce);
      const result = await t.run({ snapshot, anchor });
      expect(result).toMatchObject({
        status: 'search-reset-required',
        attemptId: snapshot.attempts[0]!.attemptId,
        observation: { anchor, nonce: BigInt(nonce) },
        reset: {
          reason: 'exhaustion-anchor-changed',
          expected: anchorAt(105n),
          observed: anchor,
          lowerBound: snapshot.baseline,
        },
      });
      expect(t.getBlock.mock.calls.map(([request]) => request.blockNumber))
        .toEqual([105n, 105n, 105n, 105n, 105n, 100n, 105n]);
      expect(t.getBlock.mock.calls.every(([request]) => request.includeTransactions !== true))
        .toBe(true);
      expect(t.getTransactionCount).toHaveBeenCalledTimes(1);
      expect(snapshot).toEqual(before);
    },
  );

  it.each([5n, 6n])('compares nonce %s at the same anchor using case-insensitive hashes', async (nonce) => {
    const t = await setup();
    const anchor = { blockNumber: 105n, blockHash: OTHER };
    t.getBlock.mockImplementation(async (request) => ({
      number: request.blockNumber,
      hash: OTHER,
      parentHash: OTHER,
      transactions: [],
    }));
    t.getTransactionReceipt.mockResolvedValue({
      transactionHash: t.hash, blockNumber: 102n, blockHash: OTHER, status: 'success',
    });
    t.getTransactionCount.mockResolvedValue(Number(nonce));
    const snapshot: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...t.snapshot.attempts[0]!,
        replacementSearch: {
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
          exhausted: {
            anchor: { ...anchor, blockHash: ('0x' + OTHER.slice(2).toUpperCase()) as Hash },
            nonce: 5n,
          },
        },
      }],
    };
    const result = await t.run({ snapshot, anchor });
    expect(result.status).toBe(nonce === 5n ? 'resolution-available' : 'inconsistent-observations');
  });
});


describe('nonce-independent exhaustion confirmation', () => {
  it.each([
    {
      name: 'verified receipt with an unconsumed nonce',
      inclusionHeight: 102n,
      nonce: 4,
    },
    {
      name: 'above-durable receipt with a consumed nonce',
      inclusionHeight: 106n,
      nonce: 5,
    },
  ])(
    'refuses $name before confirming a contradicted fact',
    async ({ inclusionHeight, nonce }) => {
      const t = await setup();
      const anchor = {
        blockNumber: 105n,
        blockHash: OTHER,
      };
      const snapshot: TransactionJournalSnapshot = {
        ...t.snapshot,
        attempts: [{
          ...t.snapshot.attempts[0]!,
          replacementSearch: {
            lowerBound: t.snapshot.baseline,
            searchedThrough: null,
            exhausted: {
              anchor: anchorAt(105n),
              nonce: 5n,
            },
          },
        }],
      };
      const before = structuredClone(snapshot);
      const read = t.getBlock.getMockImplementation()!;

      t.getBlock.mockImplementation(async (request) => {
        const block = await read(request);

        if (request.blockNumber === anchor.blockNumber) {
          return {
            ...block,
            hash: anchor.blockHash,
          };
        }

        return block;
      });
      t.getTransactionReceipt.mockResolvedValue({
        transactionHash: t.hash,
        blockNumber: inclusionHeight,
        blockHash: anchorAt(inclusionHeight).blockHash,
        status: 'success',
      });
      t.getTransactionCount.mockResolvedValue(nonce);

      const result = await t.run({ snapshot, anchor });

      expect(result).toEqual({
        status: 'inconsistent-observations',
        observation: {
          anchor,
          nonce: BigInt(nonce),
        },
      });
      expect(result).not.toHaveProperty('reset');
      expect(result).not.toHaveProperty('observations');

      // Four anchor checks plus the receipt's inclusion-header verification;
      // no lower-bound read or exhaustion-confirmation bracket follows.
      expect(t.getBlock.mock.calls.map(([request]) => request))
        .toEqual([
          { blockNumber: 105n },
          { blockNumber: inclusionHeight },
          { blockNumber: 105n },
          { blockNumber: 105n },
          { blockNumber: 105n },
        ]);
      expect(snapshot).toEqual(before);
    },
  );

  it.each(['opening', 'lower', 'closing', 'closing-rpc'] as const)(
    'refuses confirmation when %s fails',
    async (failure) => {
      const t = await setup();
      const selected = { blockNumber: 105n, blockHash: OTHER };
      const snapshot: TransactionJournalSnapshot = {
        ...t.snapshot,
        attempts: [{
          ...t.snapshot.attempts[0]!,
          replacementSearch: {
            lowerBound: t.snapshot.baseline,
            searchedThrough: null,
            exhausted: { anchor: anchorAt(105n), nonce: 5n },
          },
        }],
      };
      t.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: t.hash }));
      t.getTransactionCount.mockResolvedValue(4);
      const read = t.getBlock.getMockImplementation()!;
      let selectedReads = 0;
      t.getBlock.mockImplementation(async (request) => {
        const block = await read(request);
        if (request.blockNumber === 105n) {
          selectedReads += 1;
          if (selectedReads === 6 && failure === 'closing-rpc') {
            throw new Error('Confirmation closing failed');
          }
          if ((selectedReads === 5 && failure === 'opening') ||
            (selectedReads === 6 && failure === 'closing')) {
            return block;
          }
          return { ...block, hash: OTHER };
        }
        if (request.blockNumber === 100n && failure === 'lower') {
          return { ...block, hash: OTHER };
        }
        return block;
      });

      if (failure === 'closing-rpc') {
        await expect(t.run({ snapshot, anchor: selected }))
          .rejects.toThrow('Confirmation closing failed');
      } else {
        const result = await t.run({ snapshot, anchor: selected });
        expect(result.status).toBe(failure === 'lower' ? 'inconsistent-observations' : 'anchor-changed');
        expect(result).not.toHaveProperty('reset');
        expect(result).not.toHaveProperty('observations');
      }
      expect(t.getBlock.mock.calls.every(([request]) => request.includeTransactions !== true))
        .toBe(true);
    },
  );

  it.each([false, true])('confirms an ancestor fact when the nonce is unconsumed; changed: %s', async (changed) => {
    const t = await setup();
    const fact = { anchor: anchorAt(105n), nonce: 5n };
    const snapshot: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...t.snapshot.attempts[0]!,
        replacementSearch: {
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
          exhausted: fact,
        },
      }],
    };
    t.getTransactionCount.mockResolvedValue(4);
    t.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: t.hash }));
    const read = t.getBlock.getMockImplementation()!;
    t.getBlock.mockImplementation(async (request) => {
      const block = await read(request);
      if (changed && request.blockNumber === 105n) return { ...block, hash: OTHER };
      return block;
    });

    const result = await t.run({ snapshot, anchor: anchorAt(110n) });

    expect(t.getBlock.mock.calls.map(([request]) => request.blockNumber))
      .toEqual([110n, 110n, 110n, 110n, 110n, 100n, 105n, 110n]);
    expect(t.getBlock.mock.calls.every(([request]) => request.includeTransactions !== true))
      .toBe(true);
    if (changed) {
      expect(result).toMatchObject({
        status: 'search-reset-required',
        reset: {
          reason: 'exhaustion-anchor-changed',
          expected: fact.anchor,
          observed: { blockNumber: 105n, blockHash: OTHER },
          lowerBound: snapshot.baseline,
        },
      });
    } else {
      expect(result).toEqual({
        status: 'inconsistent-observations',
        observation: { anchor: anchorAt(110n), nonce: 4n },
      });
    }
    expect(snapshot.attempts[0]!.replacementSearch?.exhausted).toEqual(fact);
  });
});
