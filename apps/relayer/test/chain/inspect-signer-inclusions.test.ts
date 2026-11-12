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
      workId: `test-work:${nonce}`,
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
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
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

  it.each([
    {
      name: 'A before B is verified',
      contradictedIndex: 0,
      preservedIndex: 1,
      contradictedBlock: 110n,
    },
    {
      name: 'B after A is verified',
      contradictedIndex: 1,
      preservedIndex: 0,
      contradictedBlock: 111n,
    },
  ])(
    'withholds complete-pass authorization when $name is contradicted',
    async ({
      contradictedIndex,
      preservedIndex,
      contradictedBlock,
    }) => {
      const t = await setup();
      const read = t.getBlock.getMockImplementation()!;

      const contradicted = t.snapshot.attempts[contradictedIndex]!;
      const preserved = t.snapshot.attempts[preservedIndex]!;

      // Model contradictory provider observations while the selected
      // head remains unchanged. These responses do not establish
      // shared ancestry between the two inclusion blocks.
      t.getBlock.mockImplementation(async (request) => {
        const block = await read(request);

        if (request.blockNumber === contradictedBlock) {
          return {
            ...block,
            hash: FORK,
          };
        }

        return block;
      });

      const result = await t.run();

      expect(result.status).toBe('inspected');

      if (result.status !== 'inspected') {
        throw new Error('Expected inspected result.');
      }

      expect(result).toMatchObject({
        observation: {
          anchor: anchorAt(130n),
          nonce: 6n,
        },
        inclusionChecksComplete: false,
        broadcastAttemptId: null,
      });

      expect(result.attempts).toHaveLength(2);

      expect(result.attempts[contradictedIndex]).toEqual({
        ...contradicted,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      });

      expect(result.attempts[preservedIndex]).toEqual({
        ...preserved,
        inclusion: {
          ...preserved.inclusion!,
          observedAt: anchorAt(130n),
        },
      });

      // Each record is checked independently, regardless of whether
      // the contradiction occurs before or after the other verification.
      // Preserving one verified inclusion cannot make the pass complete.
      expect(t.getBlock).toHaveBeenCalledWith({
        blockNumber: 110n,
      });

      expect(t.getBlock).toHaveBeenCalledWith({
        blockNumber: 111n,
      });

      // A contradicted block invalidates its saved inclusion without
      // requiring its receipt. The other inclusion is checked freshly.
      expect(t.getTransactionReceipt)
        .toHaveBeenCalledExactlyOnceWith({
          hash: preserved.signedTransactions[0].transactionHash,
        });

      // Neither attempt's signed bytes are discarded or replaced.
      expect(result.attempts.map(
        (attempt) => attempt.signedTransactions,
      )).toEqual(
        t.snapshot.attempts.map(
          (attempt) => attempt.signedTransactions,
        ),
      );

      // Inspection must not mutate the input journal.
      expect(t.snapshot.attempts.map(
        (attempt) => attempt.phase,
      )).toEqual(['included', 'included']);

      expect(t.snapshot.attempts.map(
        (attempt) => attempt.inclusion?.observedAt,
      )).toEqual([
        anchorAt(120n),
        anchorAt(120n),
      ]);

      expect(t.snapshot.nextNonce).toBe(6n);
      expect(t.snapshot.durableNextNonce).toBe(4n);
    },
  );

  it('preserves exhaustion when latest evidence resets the search cursor', async () => {
    const t = await setup();
    const read = t.getBlock.getMockImplementation()!;
    const exhausted = { anchor: anchorAt(108n), nonce: 6n };
    const search = {
      lowerBound: t.snapshot.baseline,
      searchedThrough: anchorAt(105n),
      exhausted,
    };
    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...t.snapshot.attempts[0]!,
        replacementSearch: search,
      }, t.snapshot.attempts[1]!],
    };

    t.getBlock.mockImplementation(async (request) => {
      const block = await read(request);
      if (request.blockNumber === 110n) {
        return { ...block, hash: FORK };
      }
      return block;
    });

    const result = await t.run(input);
    if (result.status !== 'inspected') {
      throw new Error('Expected inspected result.');
    }

    expect(result.attempts[0]!.phase).toBe('broadcast-may-have-occurred');
    expect(result.attempts[0]!.inclusion).toBeNull();
    expect(result.attempts[0]!.replacementSearch).toEqual({
      ...search,
      searchedThrough: null,
    });
    expect(input.attempts[0]!.replacementSearch).toEqual(search);
    expect(input.attempts[0]!.replacementSearch!.searchedThrough)
      .toEqual(anchorAt(105n));
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

  it('checks an empty queue with only the two anchored nonce block reads', async () => {
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
      observation: {
        anchor: anchorAt(130n),
        nonce: 4n,
      },
    });

    expect(t.getTransactionReceipt).not.toHaveBeenCalled();

    expect(t.getTransactionCount).toHaveBeenCalledExactlyOnceWith({
      address: ACCOUNT.address,
      blockNumber: 130n,
    });

    expect(t.getBlock).toHaveBeenCalledTimes(2);
    expect(
      t.getBlock.mock.calls.map(([request]) => request.blockNumber),
    ).toEqual([130n, 130n]);

    const blockCalls = t.getBlock.mock.invocationCallOrder;
    const nonceCall = t.getTransactionCount.mock.invocationCallOrder[0]!;

    expect(blockCalls[0]!).toBeLessThan(nonceCall);
    expect(nonceCall).toBeLessThan(blockCalls[1]!);
  });

  it('rejects a changed opening anchor for an empty queue before reading the nonce', async () => {
    const t = await setup();

    t.getBlock.mockResolvedValueOnce({
      number: 130n,
      hash: FORK,
      parentHash: hashAt(129n),
      transactions: [],
    });

    expect(await t.run({
      ...t.snapshot,
      nextNonce: 4n,
      lastObservation: t.snapshot.baseline,
      attempts: [],
    })).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 130n,
        blockHash: FORK,
      },
    });

    expect(t.getBlock).toHaveBeenCalledOnce();
    expect(t.getTransactionCount).not.toHaveBeenCalled();
    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('rejects a changed closing anchor for an empty queue after reading the nonce', async () => {
    const t = await setup();

    t.getTransactionCount.mockImplementationOnce(async () => {
      t.getBlock.mockResolvedValueOnce({
        number: 130n,
        hash: FORK,
        parentHash: hashAt(129n),
        transactions: [],
      });

      return 4;
    });

    expect(await t.run({
      ...t.snapshot,
      nextNonce: 4n,
      lastObservation: t.snapshot.baseline,
      attempts: [],
    })).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 130n,
        blockHash: FORK,
      },
    });

    expect(t.getBlock).toHaveBeenCalledTimes(2);
    expect(t.getTransactionCount).toHaveBeenCalledOnce();
    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('rejects a nonce behind the durable journal for an empty queue', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(3);

    expect(await t.run({
      ...t.snapshot,
      nextNonce: 4n,
      lastObservation: t.snapshot.baseline,
      attempts: [],
    })).toEqual({
      status: 'nonce-behind-journal',
      observation: {
        anchor: anchorAt(130n),
        nonce: 3n,
      },
    });

    expect(t.getBlock).toHaveBeenCalledTimes(2);
    expect(t.getTransactionCount).toHaveBeenCalledOnce();
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
          exhausted: null,
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
          exhausted: null,
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
          exhausted: null,
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
      exhausted: null,
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

  it.each(['included', 'unresolved'] as const)(
    'retains %s attempts when nonces are consumed but receipts and replacement evidence are unavailable',
    async (state) => {
      const t = await setup();

      const input: TransactionJournalSnapshot = {
        ...t.snapshot,
        attempts: t.snapshot.attempts.map((attempt) => {
          if (state === 'included') {
            return attempt;
          }

          return {
            ...attempt,
            phase: 'broadcast-may-have-occurred',
            inclusion: null,
            replacementSearch: {
              exhausted: null,
              lowerBound: t.snapshot.baseline,
              searchedThrough: null,
            },
          };
        }),
      };

      t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
        throw new TransactionReceiptNotFoundError({ hash });
      });

      // Unlike the single missing-receipt case, neither retained attempt
      // can be verified here. Even nonce == nextNonce must not turn
      // the whole population into verified inclusions.
      t.getTransactionCount.mockResolvedValue(6);

      const result = await t.run(input, 2n);

      expect(result.status).toBe('inspected');

      if (result.status !== 'inspected') {
        throw new Error('Expected inspected result.');
      }

      expect(result).toMatchObject({
        observation: {
          anchor: anchorAt(130n),
          nonce: 6n,
        },
        inclusionChecksComplete: false,
        broadcastAttemptId: null,
      });

      expect(result.attempts).toHaveLength(2);
      expect(result.attempts).toEqual(input.attempts);

      expect(result.attempts.map(
        (attempt) => attempt.signedTransactions,
      )).toEqual(
        t.snapshot.attempts.map(
          (attempt) => attempt.signedTransactions,
        ),
      );

      expect(t.getTransactionReceipt).toHaveBeenCalledTimes(2);

      if (state === 'included') {
        // Receipt absence does not contradict the saved block hashes.
        // Preserve the evidence, but do not refresh its authorization.
        expect(result.attempts.map(
          (attempt) => attempt.inclusion?.observedAt,
        )).toEqual([
          anchorAt(120n),
          anchorAt(120n),
        ]);
      } else {
        expect(result.attempts.map(
          (attempt) => attempt.inclusion,
        )).toEqual([null, null]);

        // Latest-head searching must not advance durable search cursors.
        expect(result.attempts.map(
          (attempt) => attempt.replacementSearch?.searchedThrough,
        )).toEqual([null, null]);

        expect(
          t.getBlock.mock.calls
            .filter(([request]) => request.includeTransactions)
            .map(([request]) => request.blockNumber),
        ).toEqual([
          101n,
          102n,
          101n,
          102n,
        ]);
      }

      expect(input.nextNonce).toBe(6n);
      expect(input.durableNextNonce).toBe(4n);
    },
  );

  it('identifies an external replacement of A before making unresolved B eligible for rebroadcast', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const second = t.snapshot.attempts[1]!;

    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: t.snapshot.attempts.map((attempt) => ({
        ...attempt,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch: {
          exhausted: null,
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
        },
      })),
    };

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    });

    // Nonce 4 is consumed; nonce 5 remains available.
    t.getTransactionCount.mockResolvedValue(5);

    // Identify the consuming transaction, rather than inferring a
    // replacement from the advanced nonce alone.
    t.transactions.set(101n, [{
      hash: FORK,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    const result = await t.run(input, 2n);

    expect(result.status).toBe('inspected');

    if (result.status !== 'inspected') {
      throw new Error('Expected inspected result.');
    }

    expect(result).toMatchObject({
      observation: {
        anchor: anchorAt(130n),
        nonce: 5n,
      },
      inclusionChecksComplete: false,
      broadcastAttemptId: second.attemptId,
      attempts: [
        {
          attemptId: first.attemptId,
          nonce: 4n,
          phase: 'included',
          inclusion: {
            outcome: 'replaced',
            replacementTransactionHash: FORK,
            nonceAtAnchor: 5n,
            inclusion: anchorAt(101n),
            observedAt: anchorAt(130n),
          },
          replacementSearch: {
            exhausted: null,
            lowerBound: t.snapshot.baseline,
            searchedThrough: null,
          },
        },
        {
          attemptId: second.attemptId,
          nonce: 5n,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
          replacementSearch: {
            exhausted: null,
            lowerBound: t.snapshot.baseline,
            searchedThrough: null,
          },
        },
      ],
    });

    expect(result.attempts).toHaveLength(2);

    expect(result.attempts.map(
      (attempt) => attempt.signedTransactions,
    )).toEqual(
      input.attempts.map(
        (attempt) => attempt.signedTransactions,
      ),
    );

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(2);

    expect(
      t.getBlock.mock.calls
        .filter(([request]) => request.includeTransactions)
        .map(([request]) => request.blockNumber),
    ).toEqual([101n]);

    // Inspection returns evidence; it neither mutates the input journal
    // nor advances durable resolution.
    expect(input.attempts.map(
      (attempt) => attempt.phase,
    )).toEqual([
      'broadcast-may-have-occurred',
      'broadcast-may-have-occurred',
    ]);

    expect(input.attempts.map(
      (attempt) => attempt.inclusion,
    )).toEqual([null, null]);

    expect(input.nextNonce).toBe(6n);
    expect(input.durableNextNonce).toBe(4n);
  });

  it('uses 35 RPC calls to inspect 16 retained inclusions before block deduplication', async () => {
    const t = await setup();
    const attempts: JournalAttempt[] = [];

    for (let index = 0; index < 16; index += 1) {
      const nonce = 4 + index;

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

      attempts.push({
        attemptId:
          '00000000-0000-4000-8000-'
          + (index + 1).toString(16).padStart(12, '0'),
        workId: `rpc-budget:${nonce}`,
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
          inclusion: anchorAt(110n),
          observedAt: anchorAt(120n),
        },
      });
    }

    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      lastObservation: {
        anchor: anchorAt(120n),
        nonce: 20n,
      },
      nextNonce: 20n,
      attempts,
    };

    const before = structuredClone(input);

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => ({
      transactionHash: hash,
      blockNumber: 110n,
      blockHash: hashAt(110n),
      status: 'success',
    }));

    t.getTransactionCount.mockResolvedValue(20);

    const result = await t.run(input);

    expect(result.status).toBe('inspected');

    if (result.status !== 'inspected') {
      throw new Error('Expected inspected result.');
    }

    expect(result).toMatchObject({
      inclusionChecksComplete: true,
      broadcastAttemptId: null,
      observation: {
        anchor: anchorAt(130n),
        nonce: 20n,
      },
    });

    expect(result.attempts).toEqual(attempts.map((attempt) => ({
      ...attempt,
      inclusion: {
        ...attempt.inclusion!,
        observedAt: anchorAt(130n),
      },
    })));

    const headReads = t.getBlock.mock.calls.filter(
      ([request]) => request.blockNumber === 130n,
    );

    const inclusionReads = t.getBlock.mock.calls.filter(
      ([request]) => request.blockNumber === 110n,
    );

    // The owner supplies the latest-block checks before and after inspection.
    // The inspector retains 16 inclusion reads, 16 receipts, and 3 nonce-reader
    // calls (block check, signer nonce, block check): 35 calls.
    // Block deduplication remains a separate optimization.
    expect(headReads).toHaveLength(2);
    expect(inclusionReads).toHaveLength(16);
    expect(t.getBlock).toHaveBeenCalledTimes(18);
    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(16);

    expect(t.getTransactionCount).toHaveBeenCalledExactlyOnceWith({
      address: ACCOUNT.address,
      blockNumber: 130n,
    });

    expect(
      t.getBlock.mock.calls.length
      + t.getTransactionReceipt.mock.calls.length
      + t.getTransactionCount.mock.calls.length,
    ).toBe(35);

    expect(t.getTransactionReceipt.mock.calls.map(
      ([request]) => request.hash,
    )).toEqual(attempts.map(
      (attempt) => attempt.signedTransactions[0].transactionHash,
    ));

    expect(input).toEqual(before);

    function rpcTrace(): string[] {
      const calls = [
        ...t.getBlock.mock.calls.map(([request], index) => ({
          order: t.getBlock.mock.invocationCallOrder[index]!,
          label: `block:${request.blockNumber}`,
        })),

        ...t.getTransactionReceipt.mock.calls.map(([request], index) => ({
          order: t.getTransactionReceipt.mock.invocationCallOrder[index]!,
          label: `receipt:${request.hash}`,
        })),

        ...t.getTransactionCount.mock.invocationCallOrder.map((order) => ({
          order,
          label: 'nonce',
        })),
      ];

      return calls
        .sort((first, second) => first.order - second.order)
        .map(({ label }) => label);
    }

    const standaloneTrace = rpcTrace();

    expect(standaloneTrace).toHaveLength(35);
    expect(standaloneTrace[0]).toBe('block:110');
    expect(standaloneTrace.at(-1)).toBe('block:130');
  });

  it('discards refreshed inclusions when the head changes during the last receipt read', async () => {
    const t = await setup();
    const before = structuredClone(t.snapshot);
    const readBlock = t.getBlock.getMockImplementation()!;
    const readReceipt = t.getTransactionReceipt.getMockImplementation()!;
    const lastHash = t.snapshot.attempts[1]!
      .signedTransactions[0].transactionHash;

    let headChanged = false;

    t.getTransactionReceipt.mockImplementation(async (request) => {
      const receipt = await readReceipt(request);

      if (request.hash === lastHash) {
        headChanged = true;
      }

      return receipt;
    });

    t.getBlock.mockImplementation(async (request) => {
      const block = await readBlock(request);

      if (headChanged && request.blockNumber === 130n) {
        return {
          ...block,
          hash: FORK,
        };
      }

      return block;
    });

    expect(await t.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 130n,
        blockHash: FORK,
      },
    });

    expect(t.getTransactionReceipt.mock.calls.map(
      ([request]) => request.hash,
    )).toEqual(t.snapshot.attempts.map(
      (attempt) => attempt.signedTransactions[0].transactionHash,
    ));

    // The anchored nonce opening check detects the changed head
    // before reading the nonce or returning any refreshed queue.
    expect(t.getTransactionCount).not.toHaveBeenCalled();
    expect(t.snapshot).toEqual(before);
  });

  it('checks an empty queue using only the anchored nonce bracket', async () => {
    const t = await setup();

    const snapshot: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [],
      nextNonce: 4n,
      lastObservation: t.snapshot.baseline,
    };

    const before = structuredClone(snapshot);
    const trace: string[] = [];

    const publicClient = {
      getBlock: vi.fn(async (
        { blockNumber }: { blockNumber: bigint },
      ) => {
        trace.push(`block:${blockNumber}`);

        return {
          number: blockNumber,
          hash: hashAt(blockNumber),
        };
      }),

      getTransactionCount: vi.fn(async () => {
        trace.push('nonce');
        return 4;
      }),

      getTransactionReceipt: vi.fn(),
    };

    const result = await inspectSignerInclusions({
      publicClient: publicClient as unknown as PublicClient,
      snapshot,
      head: anchorAt(130n),
    });

    expect(result).toMatchObject({
      status: 'inspected',
      inclusionChecksComplete: true,
      attempts: [],
      broadcastAttemptId: null,
      observation: {
        anchor: anchorAt(130n),
        nonce: 4n,
      },
    });

    expect(trace).toEqual([
      'block:130',
      'nonce',
      'block:130',
    ]);

    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(snapshot).toEqual(before);
  });
});
describe('latest inspection block observations', () => {
  it.each(['included', 'broadcast-may-have-occurred'] as const)(
    'forwards the by-number headers from %s attempts',
    async (phase) => {
      const t = await setup();
      const input: TransactionJournalSnapshot = {
        ...t.snapshot,
        attempts: t.snapshot.attempts.map((attempt) => {
          if (phase === 'included') {
            return attempt;
          }

          return {
            ...attempt,
            phase,
            inclusion: null,
          };
        }),
      };

      const result = await t.run(input);

      expect(result).toMatchObject({
        status: 'inspected',
        observations: [anchorAt(110n), anchorAt(111n)],
      });

      if (result.status !== 'inspected') {
        throw new Error('Expected inspected result.');
      }

      expect(Object.isFrozen(result.observations)).toBe(true);
    },
  );

  it('forwards replacement-search headers after the receipt and recheck reads', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      attempts: [{
        ...first,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch: {
          exhausted: null,
          lowerBound: t.snapshot.baseline,
          searchedThrough: null,
        },
      }, t.snapshot.attempts[1]!],
    };

    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({
        hash: first.signedTransactions[0].transactionHash,
      }),
    );
    t.transactions.set(101n, [{
      hash: FORK,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    expect(await t.run(input, 2n)).toMatchObject({
      status: 'inspected',
      observations: [anchorAt(111n), anchorAt(100n), anchorAt(101n)],
    });
  });
});

describe('latest observation height limit', () => {
  it('excludes above-head receipt headers from latest evidence', async () => {
    const t = await setup();
    const first = t.snapshot.attempts[0]!;
    const input: TransactionJournalSnapshot = {
      ...t.snapshot,
      nextNonce: 5n,
      lastObservation: t.snapshot.baseline,
      attempts: [{
        ...first,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      }],
    };

    t.getTransactionReceipt.mockResolvedValue({
      transactionHash: first.signedTransactions[0].transactionHash,
      blockNumber: 131n,
      blockHash: hashAt(131n),
      status: 'success',
    });
    t.getTransactionCount.mockResolvedValue(4);

    expect(await t.run(input)).toMatchObject({
      status: 'inspected',
      observations: [],
      inclusionChecksComplete: false,
      broadcastAttemptId: null,
    });
    expect(t.getBlock).toHaveBeenCalledWith({ blockNumber: 131n });
  });
});
