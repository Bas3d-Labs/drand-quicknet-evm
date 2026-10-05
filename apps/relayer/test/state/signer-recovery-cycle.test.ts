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
  privateKeyToAccount,
} from 'viem/accounts';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  BroadcastRetrySchedule,
} from '../../src/state/broadcast-retry-schedule.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import {
  SignerRecoveryCycle,
} from '../../src/state/signer-recovery-cycle.js';

import type {
  TransactionJournalRead,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;

const ANCHOR = {
  blockNumber: 100n,
  blockHash: HASH,
};

const OBSERVATION = {
  anchor: ANCHOR,
  nonce: 4n,
};

async function setup(options: {
  empty?: boolean;
  missing?: boolean;
} = {}) {
  let visible: TransactionJournalRead = {
    kind: 'present',
    snapshot: {
      version: 1,
      identity: IDENTITY,
      baseline: OBSERVATION,
      lastObservation: OBSERVATION,
      nextNonce: 4n,
      attempt: null,
    },
  };

  if (options.missing) {
    visible = { kind: 'missing' };
  }

  const events: string[] = [];
  const load = vi.fn(async () => visible);

  const save = vi.fn<TransactionJournalStore['save']>(
    async (snapshot) => {
      events.push('save');
      visible = {
        kind: 'present',
        snapshot,
      };
    },
  );

  const create = () => SignerCoordinator.create({
    identity: IDENTITY,
    store: { load, save },
    log: createRelayerLog({
      chainId: 4663,
      destination: {
        write() {},
      },
    }),
    createErrorSummary: (secrets = []) => ({
      scrubText: createScrubber({
        privateKey: KEY,
        rpcUrls: [],
        secrets,
      }),
    }),
  });

  const coordinator = await create();
  const signTransaction = vi.fn(ACCOUNT.signTransaction);

  if (!options.missing) {
    coordinator.completeRecovery();

    if (!options.empty) {
      await coordinator.prepareAttempt({
        account: {
          ...ACCOUNT,
          signTransaction,
        },
        transaction: {
          type: 'eip1559',
          to: ACCOUNT.address,
          data: '0x1234',
          value: 0n,
          gas: 100_000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        },
      });
    }
  }

  save.mockClear();
  events.length = 0;

  const hash = coordinator.attempt?.transactionHash ?? HASH;

  const request = vi.fn<PublicClient['request']>()
    .mockImplementation(async () => {
      events.push('send');
      return hash;
    });

  const absent = new TransactionReceiptNotFoundError({ hash });

  const getTransactionReceipt =
    vi.fn<PublicClient['getTransactionReceipt']>()
      .mockImplementation(async () => {
        events.push('receipt');
        throw absent;
      });

  const getTransactionCount =
    vi.fn<PublicClient['getTransactionCount']>()
      .mockImplementation(async () => {
        events.push('nonce');
        return 4;
      });

  const getBlock = vi.fn<PublicClient['getBlock']>()
    .mockImplementation(async ({ blockNumber } = {}) => ({
      number: blockNumber,
      hash: HASH,
    }) as never);

  const publicClient = {
    request,
    getTransactionReceipt,
    getTransactionCount,
    getBlock,
  } as unknown as PublicClient;

  let now = 0;

  const schedule = new BroadcastRetrySchedule({
    initialDelayMs: 100,
    maxDelayMs: 400,
    now: () => now,
  });

  const cycle = new SignerRecoveryCycle({
    coordinator,
    schedule,
  });

  const recovery = {
    publicClient,
    anchor: { ...ANCHOR },
    maxBlockRange: 2n,
  };

  return {
    coordinator,
    schedule,
    cycle,
    recovery,
    create,
    save,
    load,
    events,
    request,
    getTransactionReceipt,
    getTransactionCount,
    getBlock,
    signTransaction,
    absent,
    at: (value: number) => {
      now = value;
    },
    visible: () => visible,
  };
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('signer recovery cycle', () => {
  it('inspects then persists the broadcast phase before sending once', async () => {
    const t = await setup();

    const result = await t.cycle.run(t.recovery, 7);

    expect(t.events).toEqual([
      'receipt',
      'nonce',
      'save',
      'save',
      'send',
    ]);

    expect(result).toMatchObject({
      inspection: { status: 'unresolved' },
      broadcast: {
        status: 'acknowledged',
        nonce: 4n,
      },
      retryDelayMs: 100,
    });

    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('continues receipt inspection during cooldown without resetting backoff', async () => {
    const t = await setup();

    await t.cycle.run(t.recovery);

    t.at(50);

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      broadcast: null,
      retryDelayMs: 50,
    });

    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(2);

    t.at(100);

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      broadcast: { status: 'acknowledged' },
      retryDelayMs: 200,
    });

    expect(t.request.mock.calls[1])
      .toEqual(t.request.mock.calls[0]);
  });

  it('delays an attempt restored after broadcast', async () => {
    const t = await setup();

    await t.coordinator.broadcastAttempt({
      publicClient: t.recovery.publicClient,
      attemptId: t.coordinator.attempt!.attemptId,
    });

    const restarted = await t.create();

    const cycle = new SignerRecoveryCycle({
      coordinator: restarted,
      schedule: t.schedule,
    });

    expect(await cycle.run(t.recovery)).toMatchObject({
      broadcast: null,
      retryDelayMs: 100,
    });

    expect(t.request).toHaveBeenCalledTimes(1);

    t.at(100);

    await cycle.run(t.recovery);

    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it('keeps backoff after an uncertain send and releases cycle ownership', async () => {
    const t = await setup();

    t.request.mockRejectedValueOnce(new Error(KEY));

    await expect(t.cycle.run(t.recovery))
      .rejects.toThrow('outcome is uncertain');

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      broadcast: null,
      retryDelayMs: 100,
    });

    expect(t.request).toHaveBeenCalledTimes(1);

    t.at(100);

    await t.cycle.run(t.recovery);

    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it('retries the exact phase write before fresh inspection and honors its original cooldown', async () => {
    const t = await setup();
    const save = t.save.getMockImplementation()!;

    t.save
      .mockImplementationOnce(save)
      .mockImplementationOnce(async () => {
        throw new Error('failed phase');
      });

    await expect(t.cycle.run(t.recovery))
      .rejects.toThrow('Journal persistence');

    const failed = t.save.mock.calls[1]![0];

    expect(t.coordinator.attempt?.phase).toBe('signed');
    expect(t.coordinator.canBroadcast).toBe(false);

    t.events.length = 0;

    t.save.mockRejectedValueOnce(new Error('failed retry'));

    await expect(t.cycle.run(t.recovery))
      .rejects.toThrow('Journal persistence');

    expect(t.events).toEqual([]);
    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);

    const result = await t.cycle.run(t.recovery);

    expect(t.save.mock.calls[2]![0]).toBe(failed);
    expect(t.save.mock.calls[3]![0]).toBe(failed);

    expect(t.events).toEqual([
      'save',
      'receipt',
      'nonce',
      'save',
    ]);

    expect(result).toMatchObject({
      broadcast: null,
      retryDelayMs: 100,
    });

    expect(t.request).not.toHaveBeenCalled();

    t.at(100);

    await t.cycle.run(t.recovery);

    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('finishes a failed clear before inspecting the empty journal', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: t.coordinator.attempt!.transactionHash,
      blockNumber: 100n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount.mockResolvedValue(5);
    t.save.mockRejectedValueOnce(new Error('clear failed'));

    await expect(t.cycle.run(t.recovery))
      .rejects.toThrow('Journal persistence');

    expect(t.coordinator.attempt).not.toBeNull();

    const result = await t.cycle.run(t.recovery);

    expect(result).toMatchObject({
      inspection: { status: 'no-attempt' },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.coordinator.attempt).toBeNull();
    expect(t.coordinator.status.open).toBe(true);
    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('does not spend a due retry when recovery detects an anchor change', async () => {
    const t = await setup();

    t.getBlock.mockResolvedValueOnce({
      number: 100n,
      hash: OTHER,
    } as never);

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      inspection: { status: 'anchor-changed' },
      broadcast: null,
      retryDelayMs: 0,
    });

    expect(t.request).not.toHaveBeenCalled();

    await t.cycle.run(t.recovery);

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('does not spend a due retry when the receipt is included but not durable', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: t.coordinator.attempt!.transactionHash,
      blockNumber: 101n,
      blockHash: HASH,
      status: 'success',
    } as never);

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      broadcast: null,
      retryDelayMs: 0,
    });

    expect(t.request).not.toHaveBeenCalled();
    expect(t.coordinator.canBroadcast).toBe(false);
  });

  it('keeps broadcasting blocked by unattributed activity', async () => {
    const t = await setup();

    t.coordinator.block('unattributed-signer-activity');

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      broadcast: null,
      retryDelayMs: 0,
    });

    expect(t.request).not.toHaveBeenCalled();
  });

  it('does not broadcast after an inspection RPC failure', async () => {
    const t = await setup();
    const failure = new Error('receipt lookup failed');

    t.getTransactionReceipt.mockRejectedValueOnce(failure);

    await expect(t.cycle.run(t.recovery)).rejects.toBe(failure);

    expect(t.request).not.toHaveBeenCalled();
    expect(t.schedule.delayMs).toBe(0);

    await t.cycle.run(t.recovery);

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping cycles for the same runner', async () => {
    const t = await setup();
    const entered = deferred();
    const finish = deferred();

    t.getTransactionReceipt.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      throw t.absent;
    });

    const pending = t.cycle.run(t.recovery);

    try {
      await Promise.race([entered.promise, pending]);

      await expect(t.cycle.run(t.recovery))
        .rejects.toThrow('cycle is already in progress');
    } finally {
      finish.resolve();
      await pending;
    }

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation before starting any work', async () => {
    const t = await setup();
    const controller = new AbortController();
    const reason = new Error('stop');

    controller.abort(reason);

    await expect(t.cycle.run({
      ...t.recovery,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.events).toEqual([]);
    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it('does not claim or send when cancellation arrives during inspection', async () => {
    const t = await setup();
    const controller = new AbortController();
    const reason = new Error('stop');

    t.getTransactionCount.mockImplementationOnce(async () => {
      controller.abort(reason);
      return 4;
    });

    await expect(t.cycle.run({
      ...t.recovery,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.request).not.toHaveBeenCalled();
    expect(t.schedule.delayMs).toBe(0);

    await t.cycle.run(t.recovery);

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('captures the requested anchor before awaiting a persistence retry', async () => {
    const t = await setup();

    t.save.mockRejectedValueOnce(new Error('failed observation'));

    await expect(
      t.coordinator.recordObservation(OBSERVATION),
    ).rejects.toThrow();

    const originalSave = t.save.getMockImplementation()!;

    t.save.mockImplementationOnce(async (snapshot) => {
      t.recovery.anchor.blockNumber = 999n;
      await originalSave(snapshot);
    });

    await t.cycle.run(t.recovery);

    expect(t.getBlock.mock.calls.every(
      ([options]) => options?.blockNumber === 100n,
    )).toBe(true);

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('recovers an empty journal without preparing or sending a transaction', async () => {
    const t = await setup({ empty: true });

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      inspection: { status: 'no-attempt' },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it('does not automatically bootstrap a missing journal', async () => {
    const t = await setup({ missing: true });

    await expect(t.cycle.run(t.recovery))
      .rejects.toThrow('explicit bootstrap authorization');

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it('passes explicit bootstrap authorization through without preparing a transaction', async () => {
    const t = await setup({ missing: true });

    expect(await t.cycle.run({
      ...t.recovery,
      bootstrap: {
        expectedNonce: 4n,
        confirmNoUntrackedTransactions: true,
      },
    })).toMatchObject({
      inspection: { status: 'no-attempt' },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.coordinator.status.open).toBe(true);
    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it('exposes a frozen attempt summary without signed bytes', async () => {
    const t = await setup();
    const before = t.coordinator.attempt!;

    expect(Object.keys(before).sort()).toEqual([
      'attemptId',
      'nonce',
      'phase',
      'transactionHash',
    ]);

    expect(Object.isFrozen(before)).toBe(true);
    expect(t.coordinator.canBroadcast).toBe(true);

    await t.cycle.run(t.recovery);

    expect(before.phase).toBe('signed');

    expect(t.coordinator.attempt?.phase)
      .toBe('broadcast-may-have-occurred');

    expect(t.coordinator.canBroadcast).toBe(false);
  });
});