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
  recheckAttemptInclusion,
} from '../../src/chain/recheck-attempt-inclusion.js';

import type {
  JournalInclusionObservation,
} from '../../src/state/transaction-journal.js';

const TRANSACTION = `0x${'11'.repeat(32)}` as const;
const EXTERNAL = `0x${'22'.repeat(32)}` as const;
const BLOCK = `0x${'aa'.repeat(32)}` as const;
const HEAD = `0x${'bb'.repeat(32)}` as const;
const FORK = `0x${'cc'.repeat(32)}` as const;

function setup() {
  const observation: JournalInclusionObservation = {
    outcome: 'success',
    transactionHash: TRANSACTION,
    inclusion: {
      blockNumber: 110n,
      blockHash: BLOCK,
    },
    observedAt: {
      blockNumber: 120n,
      blockHash: HEAD,
    },
  };

  const head = {
    blockNumber: 130n,
    blockHash: HEAD,
  };

  const getBlock = vi.fn(async (
    { blockNumber }: { blockNumber: bigint },
  ) => ({
    number: blockNumber,
    hash: blockNumber === 110n ? BLOCK : HEAD,
  }));

  const getTransactionReceipt = vi.fn(async () => ({
    transactionHash: TRANSACTION,
    blockNumber: 110n,
    blockHash: BLOCK,
    status: 'success' as 'success' | 'reverted',
  }));

  const publicClient = {
    getBlock,
    getTransactionReceipt,
  } as unknown as PublicClient;

  const run = (
    saved: JournalInclusionObservation = observation,
  ) => recheckAttemptInclusion({
    publicClient,
    observation: saved,
    head,
  });

  return {
    observation,
    head,
    publicClient,
    getBlock,
    getTransactionReceipt,
    run,
  };
}

describe('attempt inclusion recheck', () => {
  it.each(['success', 'reverted'] as const)(
    'verifies unchanged %s inclusion within the head bracket',
    async (outcome) => {
      const t = setup();

      t.getTransactionReceipt.mockResolvedValue({
        transactionHash: TRANSACTION,
        blockNumber: 110n,
        blockHash: BLOCK,
        status: outcome,
      });

      expect(await t.run({
        ...t.observation,
        outcome,
        transactionHash: TRANSACTION,
      })).toEqual({
        status: 'verified-unchanged',
        observedAt: t.head,
      });

      expect(t.getBlock.mock.calls.map(
        ([request]) => request.blockNumber,
      )).toEqual([130n, 110n, 130n]);

      expect(t.getTransactionReceipt)
        .toHaveBeenCalledExactlyOnceWith({ hash: TRANSACTION });
    },
  );

  it('reports a changed inclusion block without requiring a receipt', async () => {
    const t = setup();

    t.getBlock
      .mockResolvedValueOnce({ number: 130n, hash: HEAD })
      .mockResolvedValueOnce({ number: 110n, hash: FORK });

    expect(await t.run()).toEqual({
      status: 'inclusion-block-changed',
      inclusion: t.observation.inclusion,
      canonicalBlock: {
        blockNumber: 110n,
        blockHash: FORK,
      },
    });

    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
    expect(t.getBlock).toHaveBeenCalledTimes(3);
  });

  it('keeps receipt absence distinct from contradicted inclusion', async () => {
    const t = setup();

    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({
        hash: TRANSACTION,
      }),
    );

    expect(await t.run()).toEqual({
      status: 'receipt-unavailable',
    });

    expect(t.getBlock).toHaveBeenCalledTimes(3);
  });

  it('propagates receipt RPC failure without a conclusion', async () => {
    const t = setup();
    const failure = new Error('RPC unavailable');

    t.getTransactionReceipt.mockRejectedValueOnce(failure);

    await expect(t.run()).rejects.toBe(failure);
  });

  it('rejects a contradictory receipt without declaring the inclusion block changed', async () => {
    const t = setup();

    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: TRANSACTION,
      blockNumber: 111n,
      blockHash: BLOCK,
      status: 'success',
    });

    await expect(t.run())
      .rejects.toThrow('Inconsistent inclusion receipt response.');
  });

  it('discards an inclusion contradiction when the closing head changes', async () => {
    const t = setup();

    t.getBlock
      .mockResolvedValueOnce({ number: 130n, hash: HEAD })
      .mockResolvedValueOnce({ number: 110n, hash: FORK })
      .mockResolvedValueOnce({ number: 130n, hash: FORK });

    expect(await t.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 130n,
        blockHash: FORK,
      },
    });
  });

  it('stops before checking inclusion when the opening head changed', async () => {
    const t = setup();

    t.getBlock.mockResolvedValueOnce({
      number: 130n,
      hash: FORK,
    });

    expect(await t.run()).toMatchObject({
      status: 'anchor-changed',
    });

    expect(t.getBlock).toHaveBeenCalledTimes(1);
    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('defers when the selected head is below the saved inclusion', async () => {
    const t = setup();
    t.head.blockNumber = 109n;

    expect(await t.run()).toEqual({
      status: 'head-behind-inclusion',
    });

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('checks the external consuming transaction for a replaced observation', async () => {
    const t = setup();

    // Keep this fixture's inferred hash type broad enough for another hash.
    t.getTransactionReceipt.mockImplementationOnce(async () => ({
      transactionHash: EXTERNAL as typeof TRANSACTION,
      blockNumber: 110n,
      blockHash: BLOCK,
      status: 'reverted',
    }));

    expect(await t.run({
      outcome: 'replaced',
      replacementTransactionHash: EXTERNAL,
      nonceAtAnchor: 5n,
      inclusion: t.observation.inclusion,
      observedAt: t.observation.observedAt,
    })).toEqual({
      status: 'verified-unchanged',
      observedAt: t.head,
    });

    expect(t.getTransactionReceipt)
      .toHaveBeenCalledExactlyOnceWith({ hash: EXTERNAL });
  });

  it('captures the saved observation and head before awaiting', async () => {
    const t = setup();

    const saved: JournalInclusionObservation = {
      ...t.observation,
      inclusion: { ...t.observation.inclusion },
    };

    const pending = t.run(saved);

    Object.assign(saved.inclusion, {
      blockNumber: 999n,
      blockHash: FORK,
    });

    t.head.blockNumber = 999n;

    expect(await pending).toEqual({
      status: 'verified-unchanged',
      observedAt: {
        blockNumber: 130n,
        blockHash: HEAD,
      },
    });
  });
});