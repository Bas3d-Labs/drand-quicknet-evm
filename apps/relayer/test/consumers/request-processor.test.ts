import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Address,
  Hex,
} from 'viem';

import type {
  QuicknetRandomnessRequest,
} from '../../src/consumers/request-events.js';

import {
  processQuicknetRequests,
  processQuicknetRequestsWithOutcomes,
} from '../../src/consumers/request-processor.js';

import type {
  RoundImporter,
} from '../../src/rounds/create-round-importer.js';

import type {
  ImportQuicknetRoundResult,
  PendingImportResult,
} from '../../src/rounds/import-round.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';

const RANDOMNESS_A: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const RANDOMNESS_B: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const RANDOMNESS_C: Hex =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const TRANSACTION_HASH_A: Hex =
  '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

const TRANSACTION_HASH_B: Hex =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const REQUEST_TRANSACTION_HASH: Hex =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

function createRequest(
  round: bigint,
  consumer: Address = CONSUMER_A,
  blockNumber: bigint = 1_000n,
  logIndex: number = 0,
): QuicknetRandomnessRequest {
  return {
    consumer,
    round,
    blockNumber,
    transactionHash: REQUEST_TRANSACTION_HASH,
    logIndex,
  };
}

function importedResult(
  round: bigint,
  randomness: Hex,
  transactionHash: Hex,
): ImportQuicknetRoundResult {
  return {
    status: 'imported',
    submission: 'witness',
    round,
    randomness,
    transactionHash,
  };
}

function alreadyStoredResult(
  round: bigint,
  randomness: Hex,
): ImportQuicknetRoundResult {
  return {
    status: 'already-stored',
    round,
    randomness,
  };
}

describe('processQuicknetRequests', () => {
  let importRound: ReturnType<typeof vi.fn<RoundImporter>>;

  beforeEach(() => {
    importRound = vi.fn<RoundImporter>();
  });

  it('returns no processed rounds for an empty request list', async () => {
    const result = await processQuicknetRequests({
      importRound,
      requests: [],
    });

    expect(result).toEqual({
      rounds: [],
    });

    expect(
      importRound,
    ).not.toHaveBeenCalled();
  });

  it('processes one requested round', async () => {
    const importResult = importedResult(
      100n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    importRound.mockResolvedValue(importResult);

    const result = await processQuicknetRequests({
      importRound,
      requests: [
        createRequest(100n),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 100n,
          result: importResult,
        },
      ],
    });

    expect(importRound).toHaveBeenCalledOnce();
    expect(importRound).toHaveBeenCalledWith(100n);
  });

  it('deduplicates repeated requests for the same round', async () => {
    const importResult = importedResult(
      200n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    importRound.mockResolvedValue(importResult);

    const result = await processQuicknetRequests({
      importRound,
      requests: [
        createRequest(200n, CONSUMER_A, 1_000n, 0),
        createRequest(200n, CONSUMER_A, 1_001n, 1),
        createRequest(200n, CONSUMER_A, 1_002n, 2),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 200n,
          result: importResult,
        },
      ],
    });

    expect(
      importRound,
    ).toHaveBeenCalledOnce();
  });

  it('deduplicates the same round requested by different consumers', async () => {
    const importResult = importedResult(
      300n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    importRound.mockResolvedValue(importResult);

    await processQuicknetRequests({
      importRound,
      requests: [
        createRequest(300n, CONSUMER_A, 1_000n, 0),
        createRequest(300n, CONSUMER_B, 1_001n, 0),
      ],
    });

    expect(importRound).toHaveBeenCalledOnce();
    expect(importRound).toHaveBeenCalledWith(300n);
  });

  it('processes multiple unique rounds in first-seen order', async () => {
    const result500 = importedResult(
      500n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    const result502 = importedResult(
      502n,
      RANDOMNESS_B,
      TRANSACTION_HASH_B,
    );

    const result501 = alreadyStoredResult(
      501n,
      RANDOMNESS_C,
    );

    importRound
      .mockResolvedValueOnce(result500)
      .mockResolvedValueOnce(result502)
      .mockResolvedValueOnce(result501);

    const result = await processQuicknetRequests({
      importRound,
      requests: [
        createRequest(500n, CONSUMER_A, 1_000n, 0),
        createRequest(502n, CONSUMER_A, 1_001n, 0),
        createRequest(500n, CONSUMER_B, 1_002n, 0),
        createRequest(501n, CONSUMER_A, 1_003n, 0),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 500n,
          result: result500,
        },
        {
          round: 502n,
          result: result502,
        },
        {
          round: 501n,
          result: result501,
        },
      ],
    });

    expect(importRound.mock.calls).toEqual([
      [500n],
      [502n],
      [501n],
    ]);
  });

  it('treats an already-stored round as successful', async () => {
    const importResult = alreadyStoredResult(
      600n,
      RANDOMNESS_A,
    );

    importRound.mockResolvedValue(importResult);

    const result = await processQuicknetRequests({
      importRound,
      requests: [
        createRequest(600n),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 600n,
          result: importResult,
        },
      ],
    });
  });

  it('processes unique rounds sequentially', async () => {
    let resolveFirst:
      | ((value: ImportQuicknetRoundResult) => void)
      | undefined;

    const firstResult = importedResult(
      700n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    const secondResult = importedResult(
      701n,
      RANDOMNESS_B,
      TRANSACTION_HASH_B,
    );

    const firstPromise =
      new Promise<ImportQuicknetRoundResult>((resolve) => {
        resolveFirst = resolve;
      });

    importRound
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(secondResult);

    const processing = processQuicknetRequests({
      importRound,
      requests: [
        createRequest(700n),
        createRequest(701n),
      ],
    });

    await Promise.resolve();

    expect(importRound).toHaveBeenCalledTimes(1);

    if (resolveFirst === undefined) {
      throw new Error('Expected first round resolver to be initialized.');
    }

    resolveFirst(firstResult);

    const result = await processing;

    expect(importRound).toHaveBeenCalledTimes(2);

    expect(result).toEqual({
      rounds: [
        {
          round: 700n,
          result: firstResult,
        },
        {
          round: 701n,
          result: secondResult,
        },
      ],
    });
  });

  it('propagates a round processing failure', async () => {
    const failure = new Error('Quicknet round import failed.');

    importRound.mockRejectedValue(failure);

    await expect(
      processQuicknetRequests({
        importRound,
        requests: [
          createRequest(800n),
        ],
      }),
    ).rejects.toBe(failure);
  });

  it('stops processing after the first failed round', async () => {
    const firstResult = importedResult(
      900n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    const failure = new Error('Failed to import round 901.');

    importRound
      .mockResolvedValueOnce(firstResult)
      .mockRejectedValueOnce(failure);

    await expect(
      processQuicknetRequests({
        importRound,
        requests: [
          createRequest(900n),
          createRequest(901n),
          createRequest(902n),
        ],
      }),
    ).rejects.toBe(failure);

    expect(importRound).toHaveBeenCalledTimes(2);
    expect(importRound).toHaveBeenNthCalledWith(1, 900n);
    expect(importRound).toHaveBeenNthCalledWith(2, 901n);
    expect(importRound).not.toHaveBeenCalledWith(902n);
  });

  it('retains a pending outcome and continues to the next round', async () => {
    const onCompleted = vi.fn();

    const pending = {
      status: 'pending',
      round: 1_000n,
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: TRANSACTION_HASH_A,
      reason: 'broadcast-not-acknowledged',
    } as const;

    const completed = alreadyStoredResult(1_001n, RANDOMNESS_B);

    importRound
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(completed);

    const outcomes = await processQuicknetRequestsWithOutcomes({
      importRound,
      requests: [
        createRequest(1_000n, CONSUMER_A, 2_000n),
        createRequest(1_001n, CONSUMER_A, 2_001n),
      ],
      onCompleted,
    });

    expect(outcomes).toEqual([
      {
        round: 1_000n,
        firstRequestBlock: 2_000n,
        status: 'pending',
        result: pending,
      },
      {
        round: 1_001n,
        firstRequestBlock: 2_001n,
        status: 'completed',
        result: completed,
      },
    ]);

    expect(importRound).toHaveBeenCalledTimes(2);
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith({
      round: 1_001n,
      result: completed,
    });
  });

  it('defers the remaining batch after signer unavailability without failure', async () => {
    const onCompleted = vi.fn();

    const pending = {
      status: 'pending',
      round: 1_100n,
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: TRANSACTION_HASH_A,
      reason: 'receipt-timeout',
    } as const;

    importRound
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({
        status: 'deferred',
        round: 1_101n,
        reason: 'signer-unavailable',
        blocker: 'journal-capacity-reached',
      });

    const outcomes = await processQuicknetRequestsWithOutcomes({
      importRound,
      requests: [
        createRequest(1_100n, CONSUMER_A, 2_100n),
        createRequest(1_101n, CONSUMER_A, 2_101n),
        createRequest(1_102n, CONSUMER_A, 2_102n),
      ],
      onCompleted,
    });

    expect(outcomes).toEqual([
      {
        round: 1_100n,
        firstRequestBlock: 2_100n,
        status: 'pending',
        result: pending,
      },
      {
        round: 1_101n,
        firstRequestBlock: 2_101n,
        status: 'deferred',
        reason: 'signer-unavailable',
        blocker: 'journal-capacity-reached',
      },
      {
        round: 1_102n,
        firstRequestBlock: 2_102n,
        status: 'deferred',
        reason: 'signer-unavailable',
        blocker: 'journal-capacity-reached',
      },
    ]);

    expect(importRound).toHaveBeenCalledTimes(2);
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'continues after retained work (incomplete observer throws: %s)',
    async (callbackThrows) => {
      const attemptId = '11111111-1111-4111-8111-111111111111';
      const workId =
        'quicknet-round:v1:12345:' +
        '0x3333333333333333333333333333333333333333:1000';

      const completed = importedResult(
        1_001n,
        RANDOMNESS_B,
        TRANSACTION_HASH_B,
      );

      importRound
        .mockResolvedValueOnce({
          status: 'deferred',
          round: 1_000n,
          reason: 'already-retained',
          attemptId,
          workId,
        })
        .mockResolvedValueOnce(completed);

      const reported: string[] = [];

      const onIncomplete = vi.fn(() => {
        reported.push('incomplete');

        if (callbackThrows) {
          throw new Error('Reporting failed.');
        }
      });

      const onCompleted = vi.fn(() => {
        reported.push('completed');
      });

      const outcomes = await processQuicknetRequestsWithOutcomes({
        importRound,
        requests: [
          createRequest(1_000n, CONSUMER_A, 2_000n),
          createRequest(1_001n, CONSUMER_A, 2_001n),
        ],
        onIncomplete,
        onCompleted,
      });

      expect(outcomes).toEqual([
        {
          round: 1_000n,
          firstRequestBlock: 2_000n,
          status: 'deferred',
          reason: 'already-retained',
          attemptId,
          workId,
        },
        {
          round: 1_001n,
          firstRequestBlock: 2_001n,
          status: 'completed',
          result: completed,
        },
      ]);

      expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(outcomes[0]);
      expect(onCompleted).toHaveBeenCalledExactlyOnceWith({
        round: 1_001n,
        result: completed,
      });
      expect(reported).toEqual(['incomplete', 'completed']);

      expect(importRound.mock.calls).toEqual([
        [1_000n],
        [1_001n],
      ]);
    },
  );

  it('excludes pending and deferred work from the completed-round collection', async () => {
    const onCompleted = vi.fn();
    const completed = alreadyStoredResult(1_200n, RANDOMNESS_A);

    importRound
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce({
        status: 'pending',
        round: 1_201n,
        attemptId: '11111111-1111-4111-8111-111111111111',
        transactionHash: TRANSACTION_HASH_A,
        reason: 'receipt-timeout',
      })
      .mockResolvedValueOnce({
        status: 'deferred',
        round: 1_202n,
        reason: 'signer-unavailable',
        blocker: 'unresolved-attempt',
      });

    const result = await processQuicknetRequests({
      importRound,
      requests: [
        createRequest(1_200n),
        createRequest(1_201n),
        createRequest(1_202n),
        createRequest(1_203n),
      ],
      onCompleted,
    });

    expect(result).toEqual({
      rounds: [{ round: 1_200n, result: completed }],
    });

    expect(importRound).toHaveBeenCalledTimes(3);
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith({
      round: 1_200n,
      result: completed,
    });
  });

  it.each([false, true])(
    'reports pending and continues to completion (callback throws: %s)',
    async (callbackThrows) => {
      const pending: PendingImportResult = {
        status: 'pending',
        round: 100n,
        attemptId: 'attempt-100',
        transactionHash: TRANSACTION_HASH_A,
        reason: 'broadcast-not-acknowledged',
      };
      const stored = alreadyStoredResult(101n, RANDOMNESS_B);
      const reported: string[] = [];
      const onIncomplete = vi.fn(() => {
        reported.push('pending');

        if (callbackThrows) {
          throw new Error('Reporting failed.');
        }
      });
      const onCompleted = vi.fn(() => {
        reported.push('completed');
      });

      importRound
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(stored);

      const outcomes = await processQuicknetRequestsWithOutcomes({
        importRound,
        requests: [createRequest(100n), createRequest(101n)],
        onIncomplete,
        onCompleted,
      });

      expect(outcomes).toEqual([
        {
          round: 100n,
          firstRequestBlock: 1_000n,
          status: 'pending',
          result: pending,
        },
        {
          round: 101n,
          firstRequestBlock: 1_000n,
          status: 'completed',
          result: stored,
        },
      ]);
      expect(onIncomplete.mock.calls).toEqual([[outcomes[0]]]);
      expect(onCompleted.mock.calls).toEqual([
        [{ round: 101n, result: stored }],
      ]);
      expect(reported).toEqual(['pending', 'completed']);
      expect(importRound).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    'reports every signer deferral in order (callback throws: %s)',
    async (callbackThrows) => {
      const onIncomplete = vi.fn(() => {
        if (callbackThrows) {
          throw new Error('Reporting failed.');
        }
      });
      const onCompleted = vi.fn();

      importRound.mockResolvedValueOnce({
        status: 'deferred',
        round: 200n,
        reason: 'signer-unavailable',
        blocker: 'journal-capacity-reached',
      });

      const outcomes = await processQuicknetRequestsWithOutcomes({
        importRound,
        requests: [
          createRequest(200n, CONSUMER_A, 1_000n),
          createRequest(201n, CONSUMER_A, 1_001n),
          createRequest(202n, CONSUMER_A, 1_002n),
        ],
        onIncomplete,
        onCompleted,
      });

      expect(outcomes).toEqual([
        {
          round: 200n,
          firstRequestBlock: 1_000n,
          status: 'deferred',
          reason: 'signer-unavailable',
          blocker: 'journal-capacity-reached',
        },
        {
          round: 201n,
          firstRequestBlock: 1_001n,
          status: 'deferred',
          reason: 'signer-unavailable',
          blocker: 'journal-capacity-reached',
        },
        {
          round: 202n,
          firstRequestBlock: 1_002n,
          status: 'deferred',
          reason: 'signer-unavailable',
          blocker: 'journal-capacity-reached',
        },
      ]);
      expect(onIncomplete.mock.calls).toEqual(
        outcomes.map((outcome) => [outcome]),
      );
      expect(onCompleted).not.toHaveBeenCalled();
      expect(importRound).toHaveBeenCalledOnce();
    },
  );

  it('reports pending before the wrapper propagates a later import failure', async () => {
    const pending: PendingImportResult = {
      status: 'pending',
      round: 300n,
      attemptId: 'attempt-300',
      transactionHash: TRANSACTION_HASH_A,
      reason: 'receipt-timeout',
    };
    const failure = new Error('Import failed.');
    const onIncomplete = vi.fn();
    const onCompleted = vi.fn();

    importRound
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(failure);

    await expect(
      processQuicknetRequests({
        importRound,
        requests: [
          createRequest(300n),
          createRequest(301n),
          createRequest(302n),
        ],
        onIncomplete,
        onCompleted,
      }),
    ).rejects.toBe(failure);

    expect(onIncomplete.mock.calls).toEqual([
      [{
        round: 300n,
        firstRequestBlock: 1_000n,
        status: 'pending',
        result: pending,
      }],
    ]);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(importRound).toHaveBeenCalledTimes(2);
  });

  it('rejects cancellation before processing requests', async () => {
    const controller = new AbortController();
    const reason = new Error('Shutdown requested.');

    controller.abort(reason);

    await expect(processQuicknetRequestsWithOutcomes({
      importRound,
      requests: [createRequest(100n)],
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(importRound).not.toHaveBeenCalled();
  });

  it('propagates cancellation without processing another round', async () => {
    const controller = new AbortController();
    const reason = new Error('Shutdown requested.');

    importRound
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw reason;
      });

    await expect(processQuicknetRequestsWithOutcomes({
      importRound,
      requests: [
        createRequest(100n),
        createRequest(101n),
      ],
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(importRound).toHaveBeenCalledOnce();
  });

  it('preserves an unrelated import failure after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('Shutdown requested.');
    const failure = new Error('RPC failed.');

    importRound
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw failure;
      });

    const outcomes = await processQuicknetRequestsWithOutcomes({
      importRound,
      requests: [createRequest(100n)],
      signal: controller.signal,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      round: 100n,
      status: 'failed',
    });
    expect(outcomes[0]).toHaveProperty('error', failure);
  });

  it('passes only the round to the bound importer', async () => {
    const controller = new AbortController();

    importRound.mockResolvedValueOnce(
      alreadyStoredResult(100n, RANDOMNESS_A),
    );

    await processQuicknetRequests({
      importRound,
      requests: [createRequest(100n)],
      signal: controller.signal,
    });

    expect(importRound).toHaveBeenCalledExactlyOnceWith(100n);
  });
});
