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
  DurableRecoverySchedule,
} from '../../src/state/durable-recovery-schedule.js';

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
  maxRetainedAttempts?: number;
} = {}) {
  let visible: TransactionJournalRead = {
    kind: 'present',
    snapshot: {
      version: 1,
      identity: IDENTITY,
      baseline: OBSERVATION,
      lastObservation: OBSERVATION,
      nextNonce: 4n,
      durableNextNonce: 4n,
      repairs: [],
      attempts: [],
    },
  };

  if (options.missing) {
    visible = { kind: 'missing' };
  }

  const events: string[] = [];
  const lines: string[] = [];
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
    maxRetainedAttempts: options.maxRetainedAttempts ?? 3,
    store: { load, save },
    log: createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
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
    const startupClient = {
      getBlock: vi.fn().mockResolvedValue({
        number: ANCHOR.blockNumber,
        hash: ANCHOR.blockHash,
      }),
      getTransactionCount: vi.fn().mockResolvedValue(4),
    } as unknown as PublicClient;

    expect(await coordinator.recover({
      publicClient: startupClient,
      anchor: ANCHOR,
      maxBlockRange: 2n,
    })).toEqual({
      status: 'no-attempt',
      observation: OBSERVATION,
    });

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await coordinator.checkInclusions({
      publicClient: startupClient,
      head: ANCHOR,
    });

    expect(coordinator.status.open).toBe(true);

    if (!options.empty) {
      const prepared = await coordinator.prepareAttempt({
        workId: 'test-work:first',
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

      if (prepared.status !== 'prepared') {
        throw new Error('Expected the first recovery-cycle attempt.');
      }
    }
  }

  save.mockClear();
  events.length = 0;
  lines.length = 0;

  const hash =
    coordinator.attempts[0]?.transactionHashes[0] ?? HASH;

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
    lines,
    at: (value: number) => {
      now = value;
    },
    visible: () => visible,
  };
}

async function setupTwoAttempts() {
  const t = await setup();
  const first = t.coordinator.attempts[0]!;

  t.getTransactionReceipt.mockResolvedValueOnce({
    transactionHash: first.transactionHashes[0],
    blockNumber: 100n,
    blockHash: HASH,
    status: 'success',
  } as never);

  t.getTransactionCount.mockResolvedValueOnce(5);

  await t.coordinator.checkInclusions({
    publicClient: t.recovery.publicClient,
    head: ANCHOR,
  });

  const second = await t.coordinator.prepareAttempt({
    workId: 'test-work:second',
    account: {
      ...ACCOUNT,
      signTransaction: t.signTransaction,
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

  if (second.status !== 'prepared') {
    throw new Error('Expected the second recovery-cycle attempt.');
  }

  t.save.mockClear();
  t.getTransactionReceipt.mockClear();
  t.getTransactionCount.mockClear();
  t.events.length = 0;

  return {
    ...t,
    first,
    second,
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
      attemptId: t.coordinator.attempts[0]!.attemptId,
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

    const result = await t.cycle.run(t.recovery);

    expect(result.broadcast).toMatchObject({
      status: 'not-acknowledged',
      nonce: 4n,
    });
    expect(result.retryDelayMs).toBe(100);
    expect(t.coordinator.canBroadcast).toBe(false);

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

    expect(t.coordinator.attempts[0]?.phase).toBe('signed');
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
      transactionHash: t.coordinator.attempts[0]!.transactionHashes[0],
      blockNumber: 100n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount.mockResolvedValue(5);
    t.save.mockRejectedValueOnce(new Error('clear failed'));

    await expect(t.cycle.run(t.recovery))
      .rejects.toThrow('Journal persistence');

    expect(t.coordinator.attempts).toHaveLength(1);

    const result = await t.cycle.run(t.recovery);

    expect(result).toMatchObject({
      inspection: { status: 'no-attempt' },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.coordinator.attempts).toEqual([]);
    expect(t.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });
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
      transactionHash: t.coordinator.attempts[0]!.transactionHashes[0],
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

    const hashes = new Map<bigint, Hash>([
      [100n, HASH],
      [101n, OTHER],
      [102n, `0x${'cc'.repeat(32)}`],
      [103n, `0x${'dd'.repeat(32)}`],
    ]);

    t.getBlock.mockImplementation(async ({ blockNumber } = {}) => {
      if (blockNumber === undefined || !hashes.has(blockNumber)) {
        throw new Error('Unexpected block requested.');
      }

      return {
        number: blockNumber,
        hash: hashes.get(blockNumber),
        parentHash: hashes.get(blockNumber - 1n) ?? HASH,
        transactions: [],
      } as never;
    });

    // The retained attempt allocated nonce 4, so nextNonce is 5.
    // Observing 6 establishes activity beyond that recorded allocation.
    t.getTransactionCount.mockResolvedValue(6);

    expect(await t.coordinator.recover({
      publicClient: t.recovery.publicClient,
      anchor: {
        blockNumber: 102n,
        blockHash: hashes.get(102n)!,
      },
      maxBlockRange: 1n,
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 1n,
        remainingBlocks: 1n,
      },
    });

    expect(t.coordinator.status.blockers)
      .toContain('unattributed-signer-activity');
    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');

    t.save.mockClear();
    t.events.length = 0;

    // Advance the anchor so this pass also leaves search work remaining.
    expect(await t.cycle.run({
      ...t.recovery,
      anchor: {
        blockNumber: 103n,
        blockHash: hashes.get(103n)!,
      },
      maxBlockRange: 1n,
    })).toMatchObject({
      inspection: {
        status: 'unresolved',
        search: {
          status: 'not-found',
          scannedBlocks: 1n,
          remainingBlocks: 1n,
        },
      },
      broadcast: null,
      retryDelayMs: 0,
    });

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.coordinator.status.blockers)
      .toContain('unattributed-signer-activity');
    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');
    expect(t.coordinator.status.open).toBe(false);
    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.coordinator.attempts).toHaveLength(1);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.schedule.delayMs).toBe(0);
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
      t.coordinator.recover(t.recovery),
    ).rejects.toThrow('Journal persistence');

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      persistenceState: 'failed',
    });
    expect(t.request).not.toHaveBeenCalled();

    const failedSnapshot = t.save.mock.calls[0]![0];
    const originalSave = t.save.getMockImplementation()!;

    // Isolate the cycle's reads from the recovery that created the failure.
    t.getBlock.mockClear();

    t.save.mockImplementationOnce(async (snapshot) => {
      expect(snapshot).toBe(failedSnapshot);
      t.recovery.anchor.blockNumber = 999n;
      await originalSave(snapshot);
    });

    await t.cycle.run(t.recovery);

    expect(t.recovery.anchor.blockNumber).toBe(999n);
    expect(t.getBlock).toHaveBeenCalled();
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

    expect(t.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(t.events).toEqual([
      'nonce',
      'save',
      'nonce',
      'save',
    ]);

    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it('automatically initializes a missing journal and completes inclusion checks', async () => {
    const t = await setup({ missing: true });

    expect(await t.cycle.run(t.recovery)).toMatchObject({
      inspection: {
        status: 'no-attempt',
        observation: OBSERVATION,
      },
      inclusions: {
        status: 'inspected',
      },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(t.save).toHaveBeenCalledTimes(2);

    expect(t.save.mock.calls[0]![0]).toEqual({
      version: 1,
      identity: IDENTITY,
      baseline: OBSERVATION,
      lastObservation: OBSERVATION,
      nextNonce: 4n,
      durableNextNonce: 4n,
      repairs: [],
      attempts: [],
    });

    // Bootstrap reads all three counts before saving the baseline.
    // The separate inclusion pass then reads and persists its observation.
    expect(t.events).toEqual([
      'nonce',
      'nonce',
      'nonce',
      'save',
      'nonce',
      'save',
    ]);

    expect(t.coordinator.attempts).toEqual([]);
    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it.each(['latest', 'pending'] as const)(
    'defers a missing journal when %s disagrees and releases cycle ownership',
    async (tag) => {
      const t = await setup({ missing: true });

      t.getTransactionCount.mockResolvedValueOnce(4);

      if (tag === 'pending') {
        t.getTransactionCount.mockResolvedValueOnce(4);
      }

      t.getTransactionCount.mockResolvedValueOnce(5);

      expect(await t.cycle.run(t.recovery)).toEqual({
        inspection: {
          status: 'bootstrap-deferred',
          reason: 'nonce-count-mismatch',
          observation: OBSERVATION,
          latestNonce: tag === 'latest' ? 5n : 4n,
          pendingNonce: tag === 'pending' ? 5n : 4n,
        },
        inclusions: null,
        broadcast: null,
        retryDelayMs: null,
      });

      expect(t.visible()).toEqual({ kind: 'missing' });
      expect(t.save).not.toHaveBeenCalled();
      expect(t.getTransactionCount).toHaveBeenCalledTimes(3);

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: false,
        persistenceState: 'idle',
      });

      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.getTransactionReceipt).not.toHaveBeenCalled();
      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.request).not.toHaveBeenCalled();

      // The next cycle can retry initialization when the counts agree.
      expect(await t.cycle.run(t.recovery)).toMatchObject({
        inspection: {
          status: 'no-attempt',
          observation: OBSERVATION,
        },
        inclusions: {
          status: 'inspected',
        },
        broadcast: null,
        retryDelayMs: null,
      });

      expect(t.save).toHaveBeenCalledTimes(2);
      expect(t.coordinator.status).toMatchObject({
        open: true,
        recoveryComplete: true,
        inclusionChecksComplete: true,
      });

      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.request).not.toHaveBeenCalled();
    },
  );

  it('exposes frozen attempt summaries without signed bytes', async () => {
    const t = await setup();
    const attempts = t.coordinator.attempts;
    const before = attempts[0]!;

    expect(Object.keys(before).sort()).toEqual([
      'attemptId',
      'nonce',
      'phase',
      'transactionHashes',
      'workId',
    ]);

    expect(Object.isFrozen(attempts)).toBe(true);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.transactionHashes)).toBe(true);
    expect(before.transactionHashes).toHaveLength(1);
    expect(t.coordinator.canBroadcast).toBe(true);

    await t.cycle.run(t.recovery);

    expect(before.phase).toBe('signed');

    expect(t.coordinator.attempts[0]?.phase)
      .toBe('broadcast-may-have-occurred');

    expect(t.coordinator.canBroadcast).toBe(false);
  });

  it('keeps the empty signer closed when the inclusion pass fails', async () => {
    const t = await setup({ empty: true });
    const failure = new Error('Inclusion nonce lookup failed');

    t.getTransactionCount
      .mockResolvedValueOnce(4)
      .mockRejectedValueOnce(failure);

    await expect(t.cycle.run(t.recovery)).rejects.toBe(failure);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.signTransaction).not.toHaveBeenCalled();

    // A failed cycle must release ownership so recovery can run again.
    await t.cycle.run(t.recovery);

    expect(t.coordinator.status.open).toBe(true);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('checks the head before broadcasting an attempt unresolved at the durable anchor', async () => {
    const t = await setup();

    const result = await t.cycle.run({
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    });

    expect(t.events).toEqual([
      'receipt',
      'nonce',
      'save',
      'receipt',
      'nonce',
      'save',
      'save',
      'send',
    ]);

    expect(result).toMatchObject({
      inspection: { status: 'unresolved' },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: false,
      },
      broadcast: { status: 'acknowledged' },
    });

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('retains an inclusion above the durable anchor and does not rebroadcast it', async () => {
    const t = await setup();
    const transactionHash =
      t.coordinator.attempts[0]!.transactionHashes[0];

    t.getTransactionReceipt.mockResolvedValue({
      transactionHash,
      blockNumber: 105n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);

    const result = await t.cycle.run({
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    });

    expect(result).toMatchObject({
      inspection: {
        status: 'unresolved',
        receipt: { status: 'included-not-durable' },
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
        broadcastAttemptId: null,
      },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.visible()).toMatchObject({
      snapshot: {
        nextNonce: 5n,
        durableNextNonce: 4n,
        attempts: [{
          nonce: 4n,
          phase: 'included',
          inclusion: {
            outcome: 'success',
            transactionHash,
            inclusion: {
              blockNumber: 105n,
              blockHash: HASH,
            },
            observedAt: {
              blockNumber: 110n,
              blockHash: HASH,
            },
          },
        }],
      },
    });

    expect(t.coordinator.status.open).toBe(true);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast when head inspection fails after durable recovery', async () => {
    const t = await setup();
    const failure = new Error('Head receipt lookup failed');

    t.getTransactionReceipt
      .mockRejectedValueOnce(t.absent)
      .mockRejectedValueOnce(failure);

    await expect(t.cycle.run({
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    })).rejects.toBe(failure);

    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.coordinator.status.open).toBe(false);
    expect(t.schedule.delayMs).toBe(0);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('rejects a head behind the durable anchor before RPC or persistence', async () => {
    const t = await setup();

    await expect(t.cycle.run({
      ...t.recovery,
      head: {
        blockNumber: 99n,
        blockHash: HASH,
      },
    })).rejects.toThrow('Invalid signer recovery head');

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it('durably resolves consecutive attempts before checking the empty queue', async () => {
    const t = await setupTwoAttempts();

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => ({
      transactionHash: hash,
      blockNumber: 100n,
      blockHash: HASH,
      status: 'success',
    }) as never);

    t.getTransactionCount.mockResolvedValue(6);

    const result = await t.cycle.run({
      ...t.recovery,
      head: ANCHOR,
    });

    expect(result).toMatchObject({
      inspection: {
        status: 'resolution-available',
        evidence: {
          transactionHash: t.second.transactionHash,
        },
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
        attempts: [],
      },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.getTransactionReceipt)
      .toHaveBeenNthCalledWith(1, {
        hash: t.first.transactionHashes[0],
      });

    expect(t.getTransactionReceipt)
      .toHaveBeenNthCalledWith(2, {
        hash: t.second.transactionHash,
      });

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(2);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 6n,
      durableNextNonce: 5n,
      attempts: [{ attemptId: t.second.attemptId }],
    });

    expect(t.save.mock.calls[1]![0]).toMatchObject({
      nextNonce: 6n,
      durableNextNonce: 6n,
      attempts: [],
    });

    expect(t.save).toHaveBeenCalledTimes(3);
    expect(t.coordinator.status.open).toBe(true);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('preserves a committed prefix when inspection of the next attempt fails', async () => {
    const t = await setupTwoAttempts();
    const failure = new Error('Second receipt lookup failed');

    t.getTransactionReceipt
      .mockResolvedValueOnce({
        transactionHash: t.first.transactionHashes[0],
        blockNumber: 100n,
        blockHash: HASH,
        status: 'success',
      } as never)
      .mockRejectedValueOnce(failure);

    t.getTransactionCount.mockResolvedValue(6);

    await expect(t.cycle.run({
      ...t.recovery,
      head: ANCHOR,
    })).rejects.toBe(failure);

    expect(t.save).toHaveBeenCalledTimes(1);

    expect(t.visible()).toMatchObject({
      snapshot: {
        nextNonce: 6n,
        durableNextNonce: 5n,
        attempts: [{ attemptId: t.second.attemptId }],
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('preserves broadcast events and attributes the final gate change to reconciliation', async () => {
    const t = await setup();

    t.save.mockRejectedValueOnce(
      new Error('Observation persistence failed'),
    );

    await expect(
      t.coordinator.recover(t.recovery),
    ).rejects.toThrow('Journal persistence');

    expect(t.coordinator.status.primaryReason)
      .toBe('persistence-failure');

    t.lines.length = 0;

    const result = await t.coordinator.observeReconciliation(
      () => t.cycle.run(t.recovery, 30),
      30,
    );

    expect(result).toMatchObject({
      inspection: { status: 'unresolved' },
      broadcast: {
        status: 'acknowledged',
        nonce: 4n,
      },
      retryDelayMs: 100,
    });

    const records = t.lines.map((line) => JSON.parse(line));

    expect(records.map((record) => record.event)).toEqual([
      'attempt_broadcast_accepted',
      'signer_blocked',
    ]);

    expect(records[0]).toMatchObject({
      event: 'attempt_broadcast_accepted',
      operation: { name: 'broadcast-attempt' },
      cycle: 30,
      nonce: '4',
    });

    expect(records[1]).toMatchObject({
      event: 'signer_blocked',
      operation: { name: 'reconcile-attempt' },
      cycle: 30,
      reason: 'unresolved-attempt',
      blockers: t.coordinator.status.blockers,
    });

    expect(t.request).toHaveBeenCalledOnce();
    expect(t.signTransaction).toHaveBeenCalledOnce();
    expect(t.coordinator.canBroadcast).toBe(false);
  });

  it('does not add transient recovery blockers to the released episode', async () => {
    const t = await setup({
      empty: true,
      maxRetainedAttempts: 1,
    });

    // Establish a capacity-only episode. Coalesce fixture preparation
    // and inclusion checking so their temporary blockers do not become
    // part of the published episode.
    await t.coordinator.observeReconciliation(async () => {
      const prepared = await t.coordinator.prepareAttempt({
        workId: 'test-work:retained-inclusion',
        account: ACCOUNT,
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

      if (prepared.status !== 'prepared') {
        throw new Error('Expected a prepared attempt.');
      }

      t.getTransactionReceipt.mockResolvedValue({
        transactionHash: prepared.transactionHash,
        blockNumber: 100n,
        blockHash: HASH,
        status: 'success',
      } as never);

      t.getTransactionCount.mockResolvedValue(5);

      await t.coordinator.checkInclusions({
        publicClient: t.recovery.publicClient,
        head: ANCHOR,
      });
    }, 40);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: true,
      primaryReason: 'retention-capacity-reached',
      blockers: ['retention-capacity-reached'],
    });

    expect(t.coordinator.attempts).toHaveLength(1);
    expect(t.coordinator.attempts[0]!.phase).toBe('included');

    const initialRecords = t.lines.map((line) => JSON.parse(line));

    expect(initialRecords.map((record) => record.event)).toEqual([
      'signer_blocked',
    ]);

    expect(initialRecords[0]).toMatchObject({
      reason: 'retention-capacity-reached',
      blockers: ['retention-capacity-reached'],
      blockedSince: expect.any(String),
    });

    const blockedSince = initialRecords[0].blockedSince;

    t.lines.length = 0;

    // Exercise the real recovery cycle. Its intermediate recovery
    // blocker must not be added to the existing capacity episode.
    const result = await t.coordinator.observeReconciliation(
      () => t.cycle.run({
        ...t.recovery,
        head: ANCHOR,
      }, 41),
      41,
    );

    expect(result).toMatchObject({
      inspection: { status: 'resolution-available' },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
        attempts: [],
      },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(t.coordinator.attempts).toEqual([]);
    expect(t.coordinator.status.open).toBe(true);

    const records = t.lines.map((line) => JSON.parse(line));

    expect(records.map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_gate_released',
    ]);

    expect(records[1]).toMatchObject({
      event: 'signer_gate_released',
      operation: { name: 'reconcile-attempt' },
      cycle: 41,
      blockedSince,
      cleared: ['retention-capacity-reached'],
    });

    expect(t.request).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'admits B above safe and recovers both reorged inclusions; restart: %s',
    async (restart) => {
      const t = await setup();
      const first = t.coordinator.attempts[0]!;

      const firstHash = first.transactionHashes[0];

      // Broadcast A using the coordinator's existing preparation permit.
      expect(await t.coordinator.broadcastAttempt({
        publicClient: t.recovery.publicClient,
        attemptId: first.attemptId,
      }, 50)).toMatchObject({
        status: 'acknowledged',
        transactionHash: firstHash,
        nonce: 4n,
      });

      // A is included at 105, while the durable head remains at 100.
      t.getTransactionReceipt.mockResolvedValue({
        transactionHash: firstHash,
        blockNumber: 105n,
        blockHash: HASH,
        status: 'success',
      } as never);

      t.getTransactionCount.mockImplementation(
        async ({ blockNumber }) => {
          if (blockNumber === 100n) {
            return 4;
          }

          if (blockNumber === 110n) {
            return 5;
          }

          throw new Error('Unexpected nonce observation block.');
        },
      );

      const firstRecovery = await t.coordinator.observeReconciliation(
        () => t.cycle.run({
          ...t.recovery,
          head: {
            blockNumber: 110n,
            blockHash: HASH,
          },
        }, 51),
        51,
      );

      expect(firstRecovery).toMatchObject({
        inspection: {
          status: 'unresolved',
          receipt: { status: 'included-not-durable' },
        },
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: true,
        },
        broadcast: null,
      });

      expect(t.coordinator.status.open).toBe(true);
      expect(t.coordinator.status.blockers).toEqual([]);

      expect(t.visible()).toMatchObject({
        kind: 'present',
        snapshot: {
          nextNonce: 5n,
          durableNextNonce: 4n,
          attempts: [{
            attemptId: first.attemptId,
            nonce: 4n,
            phase: 'included',
            inclusion: {
              outcome: 'success',
              transactionHash: firstHash,
              inclusion: {
                blockNumber: 105n,
                blockHash: HASH,
              },
            },
          }],
        },
      });

      // This preparation must succeed without advancing the durable head.
      const second = await t.coordinator.prepareAttempt({
        workId: 'test-work:second-before-safe',
        account: {
          ...ACCOUNT,
          signTransaction: t.signTransaction,
        },
        transaction: {
          type: 'eip1559',
          to: ACCOUNT.address,
          data: '0x5678',
          value: 0n,
          gas: 100_000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        },
      }, 52);

      expect(second.status).toBe('prepared');

      if (second.status !== 'prepared') {
        throw new Error('Expected preparation before A becomes durable.');
      }

      expect(second.nonce).toBe(5n);
      expect(second.transactionHash).not.toBe(firstHash);

      // The fixture's default send response refers to A. Return B's hash
      // for this broadcast.
      t.request.mockResolvedValueOnce(second.transactionHash);

      expect(await t.coordinator.broadcastAttempt({
        publicClient: t.recovery.publicClient,
        attemptId: second.attemptId,
      }, 52)).toMatchObject({
        status: 'acknowledged',
        transactionHash: second.transactionHash,
        nonce: 5n,
      });

      expect(t.coordinator.status).toMatchObject({
        open: false,
        primaryReason: 'unresolved-attempt',
      });

      expect(t.coordinator.status.blockers)
        .toContain('unresolved-attempt');

      expect(t.coordinator.status.blockers)
        .not.toContain('retention-capacity-reached');

      expect(t.coordinator.attempts).toHaveLength(2);

      // B is now included too. Both inclusions remain above safe.
      t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
        let blockNumber: bigint;

        if (hash === firstHash) {
          blockNumber = 105n;
        } else if (hash === second.transactionHash) {
          blockNumber = 106n;
        } else {
          throw new Error('Unexpected transaction receipt lookup.');
        }

        return {
          transactionHash: hash,
          blockNumber,
          blockHash: HASH,
          status: 'success',
        } as never;
      });

      t.getTransactionCount.mockImplementation(
        async ({ blockNumber }) => {
          if (blockNumber === 100n) {
            return 4;
          }

          if (blockNumber === 110n) {
            return 6;
          }

          throw new Error('Unexpected nonce observation block.');
        },
      );

      const secondRecovery = await t.coordinator.observeReconciliation(
        () => t.cycle.run({
          ...t.recovery,
          head: {
            blockNumber: 110n,
            blockHash: HASH,
          },
        }, 53),
        53,
      );

      expect(secondRecovery).toMatchObject({
        inspection: {
          status: 'unresolved',
          receipt: { status: 'included-not-durable' },
        },
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: true,
        },
        broadcast: null,
      });

      expect(t.coordinator.status.open).toBe(true);
      expect(t.coordinator.status.blockers).toEqual([]);

      expect(t.visible()).toMatchObject({
        kind: 'present',
        snapshot: {
          nextNonce: 6n,
          durableNextNonce: 4n,
          attempts: [
            {
              attemptId: first.attemptId,
              nonce: 4n,
              phase: 'included',
            },
            {
              attemptId: second.attemptId,
              nonce: 5n,
              phase: 'included',
            },
          ],
        },
      });

      expect(t.coordinator.attempts).toHaveLength(2);
      expect(t.signTransaction).toHaveBeenCalledTimes(2);
      expect(t.request).toHaveBeenCalledTimes(2);

      const records = t.lines.map((line) => JSON.parse(line));

      expect(records.filter(
        (record) => record.event === 'attempt_resolved',
      )).toEqual([]);

      // Preserve the exact journaled transactions before the reorg.
      const beforeReorg = t.visible();

      if (beforeReorg.kind !== 'present') {
        throw new Error('Expected a persisted journal.');
      }

      const firstBytes =
        beforeReorg.snapshot.attempts[0]!
          .signedTransactions[0].signedTransaction;

      const secondBytes =
        beforeReorg.snapshot.attempts[1]!
          .signedTransactions[0].signedTransaction;

      expect(beforeReorg.snapshot.attempts.map(
        (attempt) => attempt.attemptId,
      )).toEqual([
        first.attemptId,
        second.attemptId,
      ]);

      t.request.mockClear();
      t.lines.length = 0;

      // Replace every block above the unchanged durable anchor.
      // Both old receipts disappear and the latest nonce returns to 4.
      t.getBlock.mockImplementation(async ({ blockNumber } = {}) => {
        if (blockNumber === undefined) {
          throw new Error('Expected a numbered block lookup.');
        }

        let hash: Hash = HASH;

        if (blockNumber > 100n) {
          hash = OTHER;
        }

        let parentHash: Hash = HASH;

        if (blockNumber > 101n) {
          parentHash = OTHER;
        }

        return {
          number: blockNumber,
          hash,
          parentHash,
          transactions: [],
        } as never;
      });

      t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
        throw new TransactionReceiptNotFoundError({ hash });
      });

      t.getTransactionCount.mockResolvedValue(4);

      const forkHead = {
        blockNumber: 110n,
        blockHash: OTHER,
      };

      const invalidated = await t.coordinator.observeReconciliation(
        () => t.cycle.run({
          ...t.recovery,
          head: forkHead,
        }, 54),
        54,
      );

      expect(invalidated).toMatchObject({
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: false,
          attempts: [
            {
              attemptId: first.attemptId,
              phase: 'broadcast-may-have-occurred',
              inclusion: null,
            },
            {
              attemptId: second.attemptId,
              phase: 'broadcast-may-have-occurred',
              inclusion: null,
            },
          ],
        },
        broadcast: null,
        retryDelayMs: 100,
      });

      expect(t.coordinator.status).toMatchObject({
        open: false,
        primaryReason: 'unresolved-attempt',
      });

      expect(t.request).not.toHaveBeenCalled();
      expect(t.signTransaction).toHaveBeenCalledTimes(2);

      expect(t.visible()).toMatchObject({
        kind: 'present',
        snapshot: {
          nextNonce: 6n,
          durableNextNonce: 4n,
          attempts: [
            {
              attemptId: first.attemptId,
              nonce: 4n,
              phase: 'broadcast-may-have-occurred',
              inclusion: null,
            },
            {
              attemptId: second.attemptId,
              nonce: 5n,
              phase: 'broadcast-may-have-occurred',
              inclusion: null,
            },
          ],
        },
      });

      let coordinator = t.coordinator;
      let recoveryCycle = t.cycle;
      let retryNow = 0;

      if (restart) {
        coordinator = await t.create();

        recoveryCycle = new SignerRecoveryCycle({
          coordinator,
          schedule: new BroadcastRetrySchedule({
            initialDelayMs: 100,
            maxDelayMs: 400,
            now: () => retryNow,
          }),
        });

        expect(coordinator.status).toMatchObject({
          open: false,
          recoveryComplete: false,
          inclusionChecksComplete: false,
        });

        expect(coordinator.attempts.map(
          (attempt) => attempt.attemptId,
        )).toEqual([
          first.attemptId,
          second.attemptId,
        ]);
      }

      const runForkRecovery = (cycle: number) =>
        coordinator.observeReconciliation(
          () => recoveryCycle.run({
            ...t.recovery,
            head: forkHead,
          }, cycle),
          cycle,
        );

      // A restored broadcast attempt must first establish fresh recovery
      // and its retry schedule. Neither path sends during the initial delay.
      expect(await runForkRecovery(55)).toMatchObject({
        broadcast: null,
        retryDelayMs: 100,
      });

      expect(coordinator.status.open).toBe(false);
      expect(t.request).not.toHaveBeenCalled();

      retryNow = 100;
      t.at(100);

      t.request.mockResolvedValueOnce(firstHash);

      expect(await runForkRecovery(56)).toMatchObject({
        broadcast: {
          status: 'acknowledged',
          attemptId: first.attemptId,
          transactionHash: firstHash,
          nonce: 4n,
        },
      });

      expect(t.request).toHaveBeenCalledExactlyOnceWith({
        method: 'eth_sendRawTransaction',
        params: [firstBytes],
      }, {
        retryCount: 0,
      });

      expect(coordinator.status.open).toBe(false);
      expect(t.signTransaction).toHaveBeenCalledTimes(2);

      // A lands on the replacement chain. B is still absent.
      t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
        if (hash === firstHash) {
          return {
            transactionHash: firstHash,
            blockNumber: 107n,
            blockHash: OTHER,
            status: 'success',
          } as never;
        }

        throw new TransactionReceiptNotFoundError({ hash });
      });

      t.getTransactionCount.mockImplementation(
        async ({ blockNumber }) => {
          if (blockNumber === 100n) {
            return 4;
          }

          if (blockNumber === 110n) {
            return 5;
          }

          throw new Error('Unexpected nonce observation block.');
        },
      );

      // Revalidate A before B becomes the oldest eligible retry.
      // Switching the tracked attempt starts B's initial retry delay.
      expect(await runForkRecovery(57)).toMatchObject({
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: false,
          attempts: [
            {
              attemptId: first.attemptId,
              phase: 'included',
              inclusion: {
                transactionHash: firstHash,
                inclusion: {
                  blockNumber: 107n,
                  blockHash: OTHER,
                },
              },
            },
            {
              attemptId: second.attemptId,
              phase: 'broadcast-may-have-occurred',
              inclusion: null,
            },
          ],
        },
        broadcast: null,
        retryDelayMs: 100,
      });

      expect(coordinator.status).toMatchObject({
        open: false,
        primaryReason: 'unresolved-attempt',
      });

      expect(t.request).toHaveBeenCalledTimes(1);

      retryNow = 200;
      t.at(200);

      t.request.mockResolvedValueOnce(second.transactionHash);

      expect(await runForkRecovery(58)).toMatchObject({
        broadcast: {
          status: 'acknowledged',
          attemptId: second.attemptId,
          transactionHash: second.transactionHash,
          nonce: 5n,
        },
      });

      expect(t.request).toHaveBeenNthCalledWith(2, {
        method: 'eth_sendRawTransaction',
        params: [secondBytes],
      }, {
        retryCount: 0,
      });

      expect(t.request).toHaveBeenCalledTimes(2);
      expect(t.signTransaction).toHaveBeenCalledTimes(2);
      expect(coordinator.status.open).toBe(false);

      // B lands after A on the replacement chain.
      t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
        let blockNumber: bigint;

        if (hash === firstHash) {
          blockNumber = 107n;
        } else if (hash === second.transactionHash) {
          blockNumber = 108n;
        } else {
          throw new Error('Unexpected transaction receipt lookup.');
        }

        return {
          transactionHash: hash,
          blockNumber,
          blockHash: OTHER,
          status: 'success',
        } as never;
      });

      t.getTransactionCount.mockImplementation(
        async ({ blockNumber }) => {
          if (blockNumber === 100n) {
            return 4;
          }

          if (blockNumber === 110n) {
            return 6;
          }

          throw new Error('Unexpected nonce observation block.');
        },
      );

      expect(await runForkRecovery(59)).toMatchObject({
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: true,
        },
        broadcast: null,
      });

      expect(coordinator.status).toMatchObject({
        open: true,
        blockers: [],
      });

      const recovered = t.visible();

      if (recovered.kind !== 'present') {
        throw new Error('Expected the recovered journal.');
      }

      expect(recovered.snapshot).toMatchObject({
        nextNonce: 6n,
        durableNextNonce: 4n,
        attempts: [
          {
            attemptId: first.attemptId,
            nonce: 4n,
            phase: 'included',
            inclusion: {
              inclusion: {
                blockNumber: 107n,
                blockHash: OTHER,
              },
            },
          },
          {
            attemptId: second.attemptId,
            nonce: 5n,
            phase: 'included',
            inclusion: {
              inclusion: {
                blockNumber: 108n,
                blockHash: OTHER,
              },
            },
          },
        ],
      });

      expect(recovered.snapshot.attempts).toHaveLength(2);

      expect(recovered.snapshot.attempts.map(
        (attempt) => attempt.signedTransactions,
      )).toEqual(
        beforeReorg.snapshot.attempts.map(
          (attempt) => attempt.signedTransactions,
        ),
      );

      expect(t.lines.map((line) => JSON.parse(line).event))
        .not.toContain('attempt_resolved');

      // Only now advance safe past both replacement-chain inclusions.
      t.lines.length = 0;

      await coordinator.observeReconciliation(
        () => recoveryCycle.run({
          ...t.recovery,
          anchor: forkHead,
          head: forkHead,
        }, 60),
        60,
      );

      expect(t.visible()).toMatchObject({
        kind: 'present',
        snapshot: {
          nextNonce: 6n,
          durableNextNonce: 6n,
          attempts: [],
        },
      });

      expect(coordinator.status).toMatchObject({
        open: true,
        blockers: [],
      });

      const resolutions = t.lines
        .map((line) => JSON.parse(line))
        .filter((record) => record.event === 'attempt_resolved');

      expect(resolutions.map((record) => record.attemptId)).toEqual([
        first.attemptId,
        second.attemptId,
      ]);

      expect(t.request).toHaveBeenCalledTimes(2);
      expect(t.signTransaction).toHaveBeenCalledTimes(2);
    },
  );

  it('skips unchanged durable recovery while checking the latest head', async () => {
    const t = await setup({ empty: true });
    let now = 0;

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => now,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');
    const checkInclusions = vi.spyOn(t.coordinator, 'checkInclusions');

    const options = {
      ...t.recovery,
      head: ANCHOR,
    };

    await cycle.run(options);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(checkInclusions).toHaveBeenCalledTimes(1);

    now = 999;

    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
    });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(checkInclusions).toHaveBeenCalledTimes(2);

    now = 1_000;

    expect(await cycle.run(options)).toMatchObject({
      inspection: { status: 'no-attempt' },
    });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(checkInclusions).toHaveBeenCalledTimes(3);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('requires durable recovery after the anchor advances', async () => {
    const t = await setup({ empty: true });

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');

    await cycle.run({
      ...t.recovery,
      head: ANCHOR,
    });

    const advanced = {
      blockNumber: 101n,
      blockHash: HASH,
    };

    expect(await cycle.run({
      ...t.recovery,
      anchor: advanced,
      head: advanced,
    })).toMatchObject({
      inspection: { status: 'no-attempt' },
    });

    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('invalidates reuse when latest-head inspection fails', async () => {
    const t = await setup({ empty: true });

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');
    const options = {
      ...t.recovery,
      head: ANCHOR,
    };

    await cycle.run(options);

    const failure = new Error('Latest nonce lookup failed');

    t.getTransactionCount.mockRejectedValueOnce(failure);

    // Durable recovery is skipped; the mandatory latest check fails.
    await expect(cycle.run(options)).rejects.toBe(failure);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(t.coordinator.status.open).toBe(false);

    expect(await cycle.run(options)).toMatchObject({
      inspection: { status: 'no-attempt' },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
    });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(t.coordinator.status.open).toBe(true);
  });

  it('rechecks durable recovery after discovering inclusion then skips stable evidence', async () => {
    const t = await setup();
    const transactionHash =
      t.coordinator.attempts[0]!.transactionHashes[0];

    // Supply inclusion evidence directly to isolate scheduling behavior.
    // Broadcast sequencing is covered by the existing recovery tests.
    t.getTransactionReceipt.mockResolvedValue({
      transactionHash,
      blockNumber: 105n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
      if (blockNumber === 100n) {
        return 4;
      }

      if (blockNumber === 110n) {
        return 5;
      }

      throw new Error('Unexpected nonce observation block.');
    });

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');
    const checkInclusions = vi.spyOn(t.coordinator, 'checkInclusions');

    const options = {
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    };

    // Latest inspection discovers inclusion after durable completion
    // was recorded, so that completion's revision is now outdated.
    await cycle.run(options);

    expect(t.coordinator.attempts[0]!.phase).toBe('included');

    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'unresolved',
        receipt: { status: 'included-not-durable' },
      },
    });

    expect(recover).toHaveBeenCalledTimes(2);

    // Stable evidence and the same durable anchor now permit reuse.
    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
    });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(checkInclusions).toHaveBeenCalledTimes(3);
    expect(t.coordinator.status.open).toBe(true);
    expect(t.coordinator.attempts).toHaveLength(1);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('does not reuse durable recovery without an explicit latest head', async () => {
    const t = await setup({ empty: true });

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');

    for (let pass = 0; pass < 3; pass += 1) {
      expect(await cycle.run(t.recovery)).toMatchObject({
        inspection: { status: 'no-attempt' },
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: true,
        },
        broadcast: null,
      });
    }

    expect(recover).toHaveBeenCalledTimes(3);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('detects a reorg during a skipped durable pass and requires full recovery before retry', async () => {
    const t = await setup();
    const first = t.coordinator.attempts[0]!;
    const transactionHash = first.transactionHashes[0];

    const initial = t.visible();

    if (initial.kind !== 'present') {
      throw new Error('Expected a persisted journal.');
    }

    const signedTransaction =
      initial.snapshot.attempts[0]!
        .signedTransactions[0].signedTransaction;

    // Supply inclusion evidence directly to isolate scheduling and reorg
    // handling. The attempt remains retained above the durable anchor.
    t.getTransactionReceipt.mockResolvedValue({
      transactionHash,
      blockNumber: 105n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
      if (blockNumber === 100n) {
        return 4;
      }

      if (blockNumber === 110n) {
        return 5;
      }

      throw new Error('Unexpected nonce observation block.');
    });

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        // Keep durable refresh time fixed. The fixture clock controls
        // broadcast backoff independently.
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');
    const checkInclusions = vi.spyOn(t.coordinator, 'checkInclusions');

    const options = {
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    };

    // First discover inclusion, then complete durable recovery against
    // the newly committed inclusion evidence.
    await cycle.run(options);
    await cycle.run(options);

    expect(recover).toHaveBeenCalledTimes(2);
    expect(t.coordinator.status.open).toBe(true);

    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
    });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(t.request).not.toHaveBeenCalled();

    // Reorg above the unchanged durable anchor. The saved inclusion
    // block is contradicted, its receipt disappears, and nonce 4 is free.
    t.getBlock.mockImplementation(async ({ blockNumber } = {}) => {
      if (blockNumber === undefined) {
        throw new Error('Expected a numbered block lookup.');
      }

      let hash = HASH;

      if (blockNumber > 100n) {
        hash = OTHER;
      }

      return {
        number: blockNumber,
        hash,
      } as never;
    });

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    });

    t.getTransactionCount.mockResolvedValue(4);

    const forkOptions = {
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: OTHER,
      },
    };

    const invalidated = await cycle.run(forkOptions);

    expect(invalidated).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: false,
        broadcastAttemptId: null,
        attempts: [{
          attemptId: first.attemptId,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
        }],
      },
      broadcast: null,
      retryDelayMs: 100,
    });

    // The latest check detected the reorg even though durable recovery
    // was skipped. Contradiction does not authorize immediate rebroadcast.
    expect(recover).toHaveBeenCalledTimes(2);
    expect(checkInclusions).toHaveBeenCalledTimes(4);
    expect(t.request).not.toHaveBeenCalled();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unresolved-attempt',
      inclusionChecksComplete: false,
    });

    expect(t.visible()).toMatchObject({
      kind: 'present',
      snapshot: {
        nextNonce: 5n,
        durableNextNonce: 4n,
        attempts: [{
          attemptId: first.attemptId,
          nonce: 4n,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
          signedTransactions: [{
            transactionHash,
            signedTransaction,
          }],
        }],
      },
    });

    // The invalidated completion cannot be reused, even though the
    // durable anchor and durable refresh clock have not changed.
    expect(await cycle.run(forkOptions)).toMatchObject({
      inspection: {
        status: 'unresolved',
        observation: {
          anchor: ANCHOR,
          nonce: 4n,
        },
      },
      broadcast: null,
      retryDelayMs: 100,
    });

    expect(recover).toHaveBeenCalledTimes(3);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.coordinator.status.open).toBe(false);

    t.at(100);

    expect(await cycle.run(forkOptions)).toMatchObject({
      inspection: { status: 'unresolved' },
      broadcast: {
        status: 'acknowledged',
        attemptId: first.attemptId,
        transactionHash,
        nonce: 4n,
      },
    });

    expect(recover).toHaveBeenCalledTimes(4);

    expect(t.request).toHaveBeenCalledExactlyOnceWith({
      method: 'eth_sendRawTransaction',
      params: [signedTransaction],
    }, {
      retryCount: 0,
    });

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
    expect(t.coordinator.status.open).toBe(false);

    expect(t.lines.map((line) => JSON.parse(line).event))
      .not.toContain('attempt_resolved');
  });

  it.each([false, true])(
    'invalidates skipped recovery after uncertain persistence; visible write: %s',
    async (visibleWrite) => {
      const t = await setup({ empty: true });

      const cycle = new SignerRecoveryCycle({
        coordinator: t.coordinator,
        schedule: t.schedule,
        durableSchedule: new DurableRecoverySchedule({
          refreshIntervalMs: 1_000,
          now: () => 0,
        }),
      });

      const recover = vi.spyOn(t.coordinator, 'recover');

      const options = {
        ...t.recovery,
        head: ANCHOR,
      };

      await cycle.run(options);

      expect(await cycle.run(options)).toMatchObject({
        inspection: {
          status: 'skipped',
          reason: 'unchanged-durable-state',
        },
      });

      expect(recover).toHaveBeenCalledTimes(1);

      const committedRevision = t.coordinator.durableRecoveryRevision;
      const originalSave = t.save.getMockImplementation()!;

      t.save.mockClear();

      t.save.mockImplementationOnce(async (snapshot) => {
        if (visibleWrite) {
          await originalSave(snapshot);
        }

        throw new Error('Observation durability uncertain');
      });

      // Durable recovery is skipped, but latest-head inspection must
      // still persist its observation. That write fails.
      await expect(cycle.run(options))
        .rejects.toThrow('Journal persistence');

      expect(recover).toHaveBeenCalledTimes(1);
      expect(t.save).toHaveBeenCalledOnce();

      const pending = t.save.mock.calls[0]![0];

      if (visibleWrite) {
        const visible = t.visible();

        if (visible.kind !== 'present') {
          throw new Error('Expected a visible journal.');
        }

        expect(visible.snapshot).toBe(pending);
      }

      expect(t.coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
        persistenceState: 'failed',
      });

      expect(t.coordinator.durableRecoveryRevision)
        .toBe(committedRevision);

      t.getBlock.mockClear();
      t.getTransactionCount.mockClear();
      t.getTransactionReceipt.mockClear();
      t.events.length = 0;

      // Persistence must be retried before any fresh chain inspection.
      t.save.mockRejectedValueOnce(new Error('Retry durability uncertain'));

      await expect(cycle.run(options))
        .rejects.toThrow('Journal persistence');

      expect(t.save.mock.calls[1]![0]).toBe(pending);
      expect(recover).toHaveBeenCalledTimes(1);

      expect(t.getBlock).not.toHaveBeenCalled();
      expect(t.getTransactionCount).not.toHaveBeenCalled();
      expect(t.getTransactionReceipt).not.toHaveBeenCalled();
      expect(t.request).not.toHaveBeenCalled();

      expect(t.coordinator.status.persistenceState).toBe('failed');

      expect(t.coordinator.durableRecoveryRevision)
        .toBe(committedRevision);

      // A successful retry commits the exact pending snapshot. Even
      // though its recovery revision is unchanged, the failed cycle
      // invalidated reuse: fresh durable recovery is required.
      const result = await cycle.run(options);

      expect(t.save.mock.calls[2]![0]).toBe(pending);

      expect(result).toMatchObject({
        inspection: { status: 'no-attempt' },
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: true,
        },
        broadcast: null,
        retryDelayMs: null,
      });

      expect(t.events).toEqual([
        'save',
        'nonce',
        'save',
        'nonce',
        'save',
      ]);

      expect(recover).toHaveBeenCalledTimes(2);

      expect(t.coordinator.status).toMatchObject({
        open: true,
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
      });

      expect(t.coordinator.durableRecoveryRevision)
        .toBe(committedRevision);

      // Reuse becomes available again only after that successful pass.
      expect(await cycle.run(options)).toMatchObject({
        inspection: {
          status: 'skipped',
          reason: 'unchanged-durable-state',
        },
      });

      expect(recover).toHaveBeenCalledTimes(2);
      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'empty journal', retained: false },
    { name: 'retained inclusion above safe', retained: true },
  ])('requires fresh recovery after restart with $name', async ({ retained }) => {
    const t = await setup({ empty: !retained });

    if (retained) {
      const transactionHash =
        t.coordinator.attempts[0]!.transactionHashes[0];

      t.getTransactionReceipt.mockResolvedValue({
        transactionHash,
        blockNumber: 105n,
        blockHash: HASH,
        status: 'success',
      } as never);
    }

    t.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
      if (blockNumber === 100n) {
        return 4;
      }

      if (blockNumber === 110n) {
        if (retained) {
          return 5;
        }

        return 4;
      }

      throw new Error('Unexpected nonce observation block.');
    });

    const options = {
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    };

    const originalCycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    // For the retained case, first discover inclusion, then establish
    // durable completion for that committed evidence.
    await originalCycle.run(options);
    await originalCycle.run(options);

    expect(await originalCycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
    });

    const committedRevision = t.coordinator.durableRecoveryRevision;
    const retainedAttempts = t.coordinator.attempts;

    // Reload the same persisted journal, with fresh in-memory ownership,
    // recovery flags, and schedules.
    const restarted = await t.create();

    expect(restarted.durableRecoveryRevision).toBe(committedRevision);
    expect(restarted.attempts).toEqual(retainedAttempts);

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    const restartedCycle = new SignerRecoveryCycle({
      coordinator: restarted,
      schedule: new BroadcastRetrySchedule({
        initialDelayMs: 100,
        maxDelayMs: 400,
        now: () => 0,
      }),
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(restarted, 'recover');
    const checkInclusions = vi.spyOn(restarted, 'checkInclusions');

    const first = await restartedCycle.run(options);

    if (retained) {
      expect(first.inspection).toMatchObject({
        status: 'unresolved',
        receipt: { status: 'included-not-durable' },
      });
    } else {
      expect(first.inspection).toMatchObject({
        status: 'no-attempt',
      });
    }

    expect(first).toMatchObject({
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(checkInclusions).toHaveBeenCalledTimes(1);

    expect(restarted.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(restarted.durableRecoveryRevision).toBe(committedRevision);
    expect(restarted.attempts).toEqual(retainedAttempts);

    // Only the fresh successful pass permits reuse in this process.
    expect(await restartedCycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
    });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(checkInclusions).toHaveBeenCalledTimes(2);

    expect(t.request).not.toHaveBeenCalled();

    if (retained) {
      expect(t.signTransaction).toHaveBeenCalledTimes(1);
    } else {
      expect(t.signTransaction).not.toHaveBeenCalled();
    }

    expect(t.lines.map((line) => JSON.parse(line).event))
      .not.toContain('attempt_resolved');
  });

  it('requires full recovery after receipt uncertainty without changing the revision', async () => {
    const t = await setup();
    const first = t.coordinator.attempts[0]!;
    const transactionHash = first.transactionHashes[0];

    const receipt = {
      transactionHash,
      blockNumber: 105n,
      blockHash: HASH,
      status: 'success',
    } as const;

    t.getTransactionReceipt.mockResolvedValue(receipt as never);

    t.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
      if (blockNumber === 100n) {
        return 4;
      }

      if (blockNumber === 110n) {
        return 5;
      }

      throw new Error('Unexpected nonce observation block.');
    });

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');
    const checkInclusions = vi.spyOn(t.coordinator, 'checkInclusions');

    const options = {
      ...t.recovery,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    };

    // Discover inclusion, then establish durable completion for the
    // committed evidence. Neither pass makes the attempt durable.
    await cycle.run(options);
    await cycle.run(options);

    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
    });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(checkInclusions).toHaveBeenCalledTimes(3);

    const committedRevision = t.coordinator.durableRecoveryRevision;
    const before = t.visible();

    if (before.kind !== 'present') {
      throw new Error('Expected a persisted journal.');
    }

    const savedAttempt = before.snapshot.attempts[0]!;

    // Canonical block hashes and nonce observations remain unchanged.
    // Only the receipt becomes temporarily unavailable.
    t.getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: transactionHash }),
    );

    const uncertain = await cycle.run(options);

    expect(uncertain).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: false,
        broadcastAttemptId: null,
      },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(checkInclusions).toHaveBeenCalledTimes(4);

    const after = t.visible();

    if (after.kind !== 'present') {
      throw new Error('Expected the retained journal.');
    }

    // Receipt absence is uncertainty, not evidence of a reorg.
    expect(after.snapshot.attempts[0]).toEqual(savedAttempt);
    expect(t.coordinator.durableRecoveryRevision).toBe(committedRevision);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });

    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.request).not.toHaveBeenCalled();

    // The one-shot rejection is exhausted, so receipts are available
    // again. Despite unchanged content, anchor, and time, recovery must
    // take the full path after incomplete latest-head validation.
    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'unresolved',
        receipt: { status: 'included-not-durable' },
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(recover).toHaveBeenCalledTimes(3);
    expect(checkInclusions).toHaveBeenCalledTimes(5);

    expect(t.coordinator.durableRecoveryRevision).toBe(committedRevision);
    expect(t.coordinator.status.open).toBe(true);

    // Reuse resumes only after the successful full recovery.
    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
      },
      broadcast: null,
    });

    expect(recover).toHaveBeenCalledTimes(3);
    expect(checkInclusions).toHaveBeenCalledTimes(6);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.signTransaction).toHaveBeenCalledTimes(1);

    expect(t.lines.map((line) => JSON.parse(line).event))
      .not.toContain('attempt_resolved');
  });

  it('keeps durable recovery active after unattributed activity is observed', async () => {
    const t = await setup({ empty: true });

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule: new DurableRecoverySchedule({
        refreshIntervalMs: 1_000,
        now: () => 0,
      }),
    });

    const recover = vi.spyOn(t.coordinator, 'recover');

    const options = {
      ...t.recovery,
      head: ANCHOR,
    };

    await cycle.run(options);

    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
    });

    expect(recover).toHaveBeenCalledTimes(1);

    const beforeActivity = t.coordinator.durableRecoveryRevision;

    // Simulate a provider observation inconsistent with the previously
    // observed nonce at this anchor. The coordinator must latch the
    // unaccounted consumption rather than preserve signing permission.
    t.getTransactionCount.mockResolvedValue(8);

    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'skipped',
        reason: 'unchanged-durable-state',
      },
      inclusions: {
        status: 'inspected',
        inclusionChecksComplete: true,
        attempts: [],
      },
      broadcast: null,
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.coordinator.status.blockers)
      .toContain('unattributed-signer-activity');

    const blockedRevision = t.coordinator.durableRecoveryRevision;

    expect(blockedRevision).not.toBe(beforeActivity);

    // The first full pass reacts to changed recovery state. Subsequent
    // passes must remain full even after that state stops changing.
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await cycle.run(options)).toMatchObject({
        inspection: {
          status: 'no-attempt',
          observation: {
            anchor: ANCHOR,
            nonce: 8n,
          },
        },
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: true,
          attempts: [],
        },
        broadcast: null,
      });

      expect(t.coordinator.durableRecoveryRevision).toBe(blockedRevision);
      expect(t.coordinator.status.open).toBe(false);

      expect(t.coordinator.status.blockers)
        .toContain('unattributed-signer-activity');
    }

    expect(recover).toHaveBeenCalledTimes(4);
    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it('keeps consumed unidentified nonce recovery due through search exhaustion', async () => {
    const t = await setup();
    const first = t.coordinator.attempts[0]!;

    const hashes = new Map<bigint, Hash>([
      [100n, HASH],
      [101n, OTHER],
      [102n, `0x${'cc'.repeat(32)}`],
      [103n, `0x${'dd'.repeat(32)}`],
    ]);

    t.getBlock.mockImplementation(async ({ blockNumber } = {}) => {
      if (blockNumber === undefined) {
        throw new Error('Expected a numbered block lookup.');
      }

      const hash = hashes.get(blockNumber);

      if (hash === undefined) {
        throw new Error('Unexpected block requested.');
      }

      return {
        number: blockNumber,
        hash,
        parentHash: hashes.get(blockNumber - 1n) ?? HASH,
        transactions: [],
      } as never;
    });

    // Nonce 4 was consumed, but neither a receipt nor the consuming
    // transaction is available. This is not consumption beyond nextNonce.
    t.getTransactionCount.mockResolvedValue(5);

    const durableSchedule = new DurableRecoverySchedule({
      refreshIntervalMs: 1_000,
      now: () => 0,
    });

    const recordCompleted = vi.spyOn(durableSchedule, 'recordCompleted');

    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: t.schedule,
      durableSchedule,
    });

    const recover = vi.spyOn(t.coordinator, 'recover');

    const anchor = {
      blockNumber: 103n,
      blockHash: hashes.get(103n)!,
    };

    const options = {
      ...t.recovery,
      anchor,
      head: anchor,
      maxBlockRange: 1n,
    };

    // Only durable recovery advances the persisted search cursor.
    // Latest-head searching may inspect further blocks but must not
    // advance that durable cursor.
    for (const [index, searchedThrough] of [101n, 102n, 103n].entries()) {
      const remainingBlocks = 103n - searchedThrough;

      expect(await cycle.run(options)).toMatchObject({
        inspection: {
          status: 'unresolved',
          observation: {
            anchor,
            nonce: 5n,
          },
          search: {
            status: 'not-found',
            scannedBlocks: 1n,
            remainingBlocks,
          },
        },
        inclusions: {
          status: 'inspected',
          inclusionChecksComplete: false,
          broadcastAttemptId: null,
        },
        broadcast: null,
      });

      expect(recover).toHaveBeenCalledTimes(index + 1);

      expect(t.visible()).toMatchObject({
        kind: 'present',
        snapshot: {
          nextNonce: 5n,
          durableNextNonce: 4n,
          attempts: [{
            attemptId: first.attemptId,
            replacementSearch: {
              searchedThrough: {
                blockNumber: searchedThrough,
                blockHash: hashes.get(searchedThrough),
              },
            },
          }],
        },
      });

      expect(t.coordinator.status.open).toBe(false);

      expect(t.coordinator.status.blockers)
        .not.toContain('unattributed-signer-activity');

      if (remainingBlocks === 0n) {
        expect(t.coordinator.status.blockers)
          .toContain('conflict-search-exhausted');
      } else {
        expect(t.coordinator.status.blockers)
          .not.toContain('conflict-search-exhausted');
      }
    }

    const exhaustedRevision = t.coordinator.durableRecoveryRevision;

    // Exhaustion is not an established outcome. With the same anchor,
    // revision, and clock, durable inspection must still run again.
    expect(await cycle.run(options)).toMatchObject({
      inspection: {
        status: 'unresolved',
        search: {
          status: 'not-found',
          scannedBlocks: 0n,
          remainingBlocks: 0n,
        },
      },
      broadcast: null,
    });

    expect(recover).toHaveBeenCalledTimes(4);
    expect(recordCompleted).not.toHaveBeenCalled();

    expect(t.coordinator.durableRecoveryRevision).toBe(exhaustedRevision);
    expect(t.coordinator.status.open).toBe(false);

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    expect(t.coordinator.attempts).toHaveLength(1);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.signTransaction).toHaveBeenCalledTimes(1);

    expect(t.lines.map((line) => JSON.parse(line).event))
      .not.toContain('attempt_resolved');
  });
});