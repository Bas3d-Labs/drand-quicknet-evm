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

  const getBlock = vi.fn(async (
    request: { blockNumber: bigint },
  ) => ({
    number: request.blockNumber,
    hash: hashAt(request.blockNumber),
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
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    run: (input = snapshot) => inspectSignerInclusions({
      publicClient,
      snapshot: input,
      head: anchorAt(130n),
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
      attempts: [],
      observation: { nonce: 4n },
    });

    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
  });
});