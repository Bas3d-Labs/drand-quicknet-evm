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
  inspectSignerInclusions,
} from '../../src/chain/inspect-signer-inclusions.js';

import type {
  JournalAttempt,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const FORK = `0x${'ff'.repeat(32)}` as const;

const hashAt = (number: bigint) =>
  `0x${number.toString(16).padStart(64, '0')}` as Hash;

const anchorAt = (number: bigint) => ({
  blockNumber: number,
  blockHash: hashAt(number),
});

async function setup() {
  async function attempt(
    nonce: number,
    attemptId: string,
  ): Promise<JournalAttempt> {
    const signedTransaction = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: 4663,
      nonce,
      gas: 21_000n,
      to: ACCOUNT.address,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    const transactionHash = keccak256(signedTransaction);

    return {
      attemptId,
      nonce: BigInt(nonce),
      createdAt: '2026-10-04T00:00:00.000Z',
      signedTransactions: [{
        transactionHash,
        signedTransaction,
      }],
      replacementSearch: null,
      phase: 'included',
      inclusion: {
        outcome: 'success',
        transactionHash,
        inclusion: anchorAt(110n + BigInt(nonce - 4)),
        observedAt: anchorAt(120n),
      },
    };
  }

  const first = await attempt(
    4,
    '11111111-1111-4111-8111-111111111111',
  );

  const second = await attempt(
    5,
    '22222222-2222-4222-8222-222222222222',
  );

  const baseline = {
    anchor: anchorAt(100n),
    nonce: 4n,
  };

  const snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: {
      chainId: 4663,
      signer: ACCOUNT.address,
    },
    baseline,
    lastObservation: {
      anchor: anchorAt(120n),
      nonce: 6n,
    },
    nextNonce: 6n,
    durableNextNonce: 4n,
    attempts: [first, second],
  };

  const transactions = new Map<bigint, unknown[]>();

  const getBlock = vi.fn(async (
    request: {
      blockNumber: bigint;
      includeTransactions?: boolean;
    },
  ) => ({
    number: request.blockNumber,
    hash: hashAt(request.blockNumber),
    parentHash: hashAt(request.blockNumber - 1n),
    transactions: transactions.get(request.blockNumber) ?? [],
  }));

  const getTransactionReceipt = vi.fn(async (
    request: { hash: Hash },
  ) => {
    const index = snapshot.attempts.findIndex((candidate) =>
      candidate.signedTransactions.some(
        (transaction) => transaction.transactionHash === request.hash,
      ),
    );

    if (index < 0) {
      throw new TransactionReceiptNotFoundError({
        hash: request.hash,
      });
    }

    const blockNumber = 110n + BigInt(index);

    return {
      transactionHash: request.hash,
      blockNumber,
      blockHash: hashAt(blockNumber),
      status: 'success' as const,
    };
  });

  const getTransactionCount = vi.fn(async () => 6);

  const publicClient = {
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
  } as unknown as PublicClient;

  return {
    snapshot,
    transactions,
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    run: (
      input = snapshot,
      maxReplacementBlockRange?: bigint,
    ) => inspectSignerInclusions({
      publicClient,
      snapshot: input,
      head: anchorAt(130n),
      ...(maxReplacementBlockRange === undefined
        ? {}
        : { maxReplacementBlockRange }),
    }),
  };
}

describe('signer inclusion inspection', () => {
  it('refreshes every inclusion without changing the input queue', async () => {
    const t = await setup();
    const result = await t.run();

    expect(result.status).toBe('inspected');
    if (result.status !== 'inspected') {
      throw new Error('Expected inspected result.');
    }

    expect(result.inclusionChecksComplete).toBe(true);
    expect(result.observation.nonce).toBe(6n);
    expect(result.attempts.map((attempt) => attempt.nonce))
      .toEqual([4n, 5n]);

    for (const attempt of result.attempts) {
      expect(attempt.inclusion?.observedAt).toEqual(anchorAt(130n));
    }

    expect(t.snapshot.attempts[0]!.inclusion?.observedAt)
      .toEqual(anchorAt(120n));

    expect(Object.isFrozen(result.attempts)).toBe(true);
    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it('discovers inclusion for an unresolved attempt', async () => {
    const t = await setup();

    const result = await t.run({
      ...t.snapshot,
      attempts: t.snapshot.attempts.map((attempt) => ({
        ...attempt,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      })),
    });

    expect(result).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: true,
      attempts: [
        { nonce: 4n, phase: 'included' },
        { nonce: 5n, phase: 'included' },
      ],
    });
  });

  it('invalidates only the record with a contradicted inclusion block', async () => {
    const t = await setup();
    const read = t.getBlock.getMockImplementation()!;

    t.getBlock.mockImplementation(async (request) => {
      const block = await read(request);

      return request.blockNumber === 110n
        ? { ...block, hash: FORK }
        : block;
    });

    expect(await t.run()).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: false,
      broadcastAttemptId: null,
      attempts: [
        {
          nonce: 4n,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
        },
        {
          nonce: 5n,
          phase: 'included',
          inclusion: {
            observedAt: anchorAt(130n),
          },
        },
      ],
    });

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('preserves an included record when its receipt is unavailable', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({
        hash: t.snapshot.attempts[0]!
          .signedTransactions[0].transactionHash,
      }),
    );

    const result = await t.run();

    expect(result.status).toBe('inspected');
    if (result.status !== 'inspected') {
      throw new Error('Expected inspected result.');
    }

    expect(result.inclusionChecksComplete).toBe(false);
    expect(result.attempts[0]).toEqual(t.snapshot.attempts[0]);
    expect(result.attempts[1]!.inclusion?.observedAt)
      .toEqual(anchorAt(130n));
  });

  it('rejects a verified inclusion paired with an unconsumed nonce', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(5);

    expect(await t.run()).toMatchObject({
      status: 'inconsistent-observations',
      observation: { nonce: 5n },
    });
  });

  it('propagates an RPC failure without returning a partial queue', async () => {
    const t = await setup();
    const error = new Error('RPC unavailable');

    t.getTransactionReceipt.mockRejectedValueOnce(error);

    await expect(t.run()).rejects.toBe(error);

    expect(t.getTransactionCount).not.toHaveBeenCalled();
    expect(t.snapshot.attempts[0]!.phase).toBe('included');
  });

  it('discards the pass when the head changes during the nonce read', async () => {
    const t = await setup();

    t.getTransactionCount.mockImplementationOnce(async () => {
      t.getBlock.mockResolvedValueOnce({
        number: 130n,
        hash: FORK,
        parentHash: hashAt(129n),
        transactions: [],
      });

      return 6;
    });

    expect(await t.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 130n,
        blockHash: FORK,
      },
    });
  });

  it('checks the nonce for an empty queue', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(4);

    expect(await t.run({
      ...t.snapshot,
      nextNonce: 4n,
      lastObservation: t.snapshot.baseline,
      attempts: [],
    })).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: true,
      broadcastAttemptId: null,
      attempts: [],
      observation: { nonce: 4n },
    });

    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('discovers an external replacement without advancing durable search progress', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const ownHash = first.signedTransactions[0].transactionHash;

    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: ownHash }),
    );

    t.transactions.set(101n, [{
      hash: FORK,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...first,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch: {
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
        },
      }, t.snapshot.attempts[1]!],
    };

    const result = await t.run(input, 2n);

    expect(result).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: true,
      broadcastAttemptId: null,
      attempts: [{
        nonce: 4n,
        phase: 'included',
        inclusion: {
          outcome: 'replaced',
          replacementTransactionHash: FORK,
          nonceAtAnchor: 6n,
          inclusion: anchorAt(101n),
          observedAt: anchorAt(130n),
        },
        replacementSearch: {
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
        },
      }, {
        nonce: 5n,
        phase: 'included',
      }],
    });

    expect(input.attempts[0]!.phase)
      .toBe('broadcast-may-have-occurred');
    expect(input.nextNonce).toBe(6n);
    expect(input.durableNextNonce).toBe(4n);
  });

  it('keeps a scanned recorded transaction unresolved without its receipt', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const ownHash = first.signedTransactions[0].transactionHash;

    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: ownHash }),
    );

    t.transactions.set(101n, [{
      hash: ownHash,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    expect(await t.run({
      ...t.snapshot,
      attempts: [{
        ...first,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch: {
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
        },
      }, t.snapshot.attempts[1]!],
    }, 2n)).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: false,
      broadcastAttemptId: null,
      attempts: [{
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      }, {
        phase: 'included',
      }],
    });
  });

  it('rejects an invalid replacement budget before RPC', async () => {
    const t = await setup();

    await expect(t.run(t.snapshot, 0n)).rejects.toThrow(
      'Invalid signer inclusion input',
    );

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
    expect(t.getTransactionCount).not.toHaveBeenCalled();
  });

  it('bounds head searches without advancing the durable cursor', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const ownHash = first.signedTransactions[0].transactionHash;

    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: ownHash }),
    );

    const replacementSearch = {
      lowerBound: t.snapshot.baseline,
      searchedThrough: anchorAt(105n),
    };

    const result = await t.run({
      ...t.snapshot,
      attempts: [{
        ...first,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch,
      }, t.snapshot.attempts[1]!],
    }, 2n);

    expect(result).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: false,
      attempts: [{
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch,
      }, {
        phase: 'included',
      }],
    });

    expect(
      t.getBlock.mock.calls
        .filter(([request]) => request.includeTransactions)
        .map(([request]) => request.blockNumber),
    ).toEqual([106n, 107n]);

    expect(replacementSearch.searchedThrough).toEqual(anchorAt(105n));
  });

  it('discards replacement discovery when the final pass head check changes', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const ownHash = first.signedTransactions[0].transactionHash;

    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: ownHash }),
    );

    t.transactions.set(101n, [{
      hash: FORK,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    const read = t.getBlock.getMockImplementation()!;
    let scanned = false;
    let headChecksAfterScan = 0;

    t.getBlock.mockImplementation(async (request) => {
      const block = await read(request);

      if (request.includeTransactions) {
        scanned = true;
      } else if (scanned && request.blockNumber === 130n) {
        headChecksAfterScan += 1;

        // The search's own closing check succeeds. The enclosing
        // inclusion pass must still perform its final head check.
        if (headChecksAfterScan === 2) {
          return {
            ...block,
            hash: FORK,
          };
        }
      }

      return block;
    });

    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...first,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch: {
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
        },
      }, t.snapshot.attempts[1]!],
    };

    expect(await t.run(input, 2n)).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 130n,
        blockHash: FORK,
      },
    });

    expect(headChecksAfterScan).toBe(2);
    expect(input.attempts[0]!.phase)
      .toBe('broadcast-may-have-occurred');
    expect(input.attempts[0]!.inclusion).toBeNull();
  });

  it('identifies only the oldest unresolved attempt for rebroadcast at an unconsumed nonce', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    });

    t.getTransactionCount.mockResolvedValue(4);

    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: t.snapshot.attempts.map((attempt) => ({
        ...attempt,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      })),
    };

    expect(await t.run(input, 2n)).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: false,
      broadcastAttemptId: input.attempts[0]!.attemptId,
    });

    expect(
      t.getBlock.mock.calls.filter(
        ([request]) => request.includeTransactions,
      ),
    ).toEqual([]);
  });

  it('identifies a later unresolved attempt only after verifying earlier inclusions', async () => {
    const t = await setup();
    const second = t.snapshot.attempts[1]!;
    const secondHash = second.signedTransactions[0].transactionHash;
    const readReceipt = t.getTransactionReceipt.getMockImplementation()!;

    t.getTransactionReceipt.mockImplementation(async (request) => {
      if (request.hash === secondHash) {
        throw new TransactionReceiptNotFoundError({
          hash: request.hash,
        });
      }

      return readReceipt(request);
    });

    t.getTransactionCount.mockResolvedValue(5);

    expect(await t.run({
      ...t.snapshot,
      attempts: [
        t.snapshot.attempts[0]!,
        {
          ...second,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
        },
      ],
    })).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: false,
      broadcastAttemptId: second.attemptId,
    });
  });

  it('withholds rebroadcast eligibility when an earlier saved inclusion is uncertain', async () => {
    const t = await setup();
    const second = t.snapshot.attempts[1]!;

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    });

    t.getTransactionCount.mockResolvedValue(5);

    expect(await t.run({
      ...t.snapshot,
      attempts: [
        t.snapshot.attempts[0]!,
        {
          ...second,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
        },
      ],
    })).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: false,
      broadcastAttemptId: null,
    });
  });
});