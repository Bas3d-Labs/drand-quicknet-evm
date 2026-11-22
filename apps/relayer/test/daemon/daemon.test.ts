import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Account,
  PublicClient,
} from 'viem';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  runDaemonCycle,
} from '../../src/daemon/daemon-cycle.js';

import {
  runDaemon,
  type DaemonWorkContext,
  type DaemonWorkResult,
  type RunDaemonOptions,
} from '../../src/daemon/daemon.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  RoundImporter,
} from '../../src/rounds/create-round-importer.js';

import type {
  CheckpointStore,
} from '../../src/state/checkpoint.js';

vi.mock('../../src/daemon/daemon-cycle.js', () => ({
  runDaemonCycle: vi.fn(),
}));

const CONSUMER = `0x${'11'.repeat(20)}` as const;

const REGISTRY = `0x${'22'.repeat(20)}` as const;

const HASH = `0x${'33'.repeat(32)}` as const;

const ROUND = 100n;

const RELEASE = Number(roundScheduledTime(ROUND)) * 1000;

function fixture() {
  let time = 0;

  let wall = RELEASE;

  let latest = 10n;

  const controller = new AbortController();

  const calls: string[] = [];

  const work: { result: DaemonWorkResult; context: DaemonWorkContext; at: number }[] = [];

  const state = { open: true, blockers: [] as string[], retainedCount: 0 };

  const getLogs = vi.fn(async () => [] as {
    address: typeof CONSUMER;
    args: { round: bigint };
    blockNumber: bigint;
    transactionHash: typeof HASH;
    logIndex: number;
  }[]);

  const importer = vi.fn<RoundImporter>().mockResolvedValue({
    status: 'already-stored',
    round: ROUND,
  } as Awaited<ReturnType<RoundImporter>>);

  const full = vi.mocked(runDaemonCycle).mockImplementation(async (options) => {
    calls.push('recover');

    const scheduled = state.open
      ? await options.waiting!.dispatch(importer, options.signal)
      : undefined;

    return {
      ...(scheduled === undefined ? {} : { scheduled }),
      consumers: options.consumers.map((consumer) => ({
        status: 'success',
        consumer,
        iteration: {
          consumer: consumer.address,
          status: 'caught-up',
          latestBlock: 999n,
          durableBlock: 0n,
          durableNextBlock: 1n,
          durableHeadRegressed: false,
          softCursor: { nextBlock: 999n },
          durableScan: undefined,
          softScan: undefined,
          durableBlockObservedAt: new Date(RELEASE).toISOString(),
        },
      })),
    };
  });

  const options: RunDaemonOptions = {
    now: () => wall,
    monotonicNow: () => time,
    readSchedulingState: () => state,
    publicClient: {
      getBlockNumber: vi.fn(async () => {
        calls.push('eth_blockNumber');
        return latest;
      }),
      getLogs: vi.fn(async () => {
        calls.push('eth_getLogs');
        return getLogs();
      }),
    } as unknown as PublicClient,
    account: {} as Account,
    submitter: {
      findRetainedWork: () => null,
      recover: vi.fn(),
      submit: vi.fn(),
    } as BeaconSubmitter,
    deployment: { chainId: 46630, address: REGISTRY } as RegistryDeployment,
    checkpointStore: {} as CheckpointStore,
    consumers: [{ address: CONSUMER, registry: REGISTRY }],
    startBlock: 1n,
    maxBlockRange: 2_000n,
    finality: { type: 'safe' },
    pollIntervalMs: 15_000,
    signal: controller.signal,
    sleep: vi.fn(async (delay) => {
      time += delay;
      wall += delay;
      if (time > 200_000) {
        throw new Error('Unbounded fixture');
      }
    }),
    onWork: async (result, context) => {
      work.push({ result, context, at: time });
      if (work.length === 6) {
        controller.abort();
      }
    },
  };

  return {
    options, controller, calls, work, state, getLogs, importer, full,
    setLatest(value: bigint) {
      latest = value;
    },
    setWall(value: number) {
      wall = value;
    },
    advance(value: number) {
      time += value;

      wall += value;
    },
    request(count = 1) {
      getLogs.mockResolvedValueOnce(Array.from({ length: count }, (_, index) => ({
        address: CONSUMER,
        args: { round: ROUND + BigInt(index) },
        blockNumber: 1n,
        transactionHash: HASH,
        logIndex: index,
      })));
    },
  };
}

beforeEach(() => {
  vi.mocked(runDaemonCycle).mockReset();
});

describe('separate daemon work', () => {
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects poll interval %s', async (poll) => {
    const f = fixture();

    await expect(runDaemon({ ...f.options, pollIntervalMs: poll }))
      .rejects.toThrow('pollIntervalMs');
    expect(f.full).not.toHaveBeenCalled();
  });

  it('does no work when already aborted', async () => {
    const f = fixture();

    f.controller.abort();

    await runDaemon(f.options);

    expect(f.calls).toEqual([]);
  });

  it.each([1_000, 5_000, 15_000])('uses the configured %s ms full cadence', async (poll) => {
    const f = fixture();

    f.state.retainedCount = 2;
    f.options.pollIntervalMs = poll;

    await runDaemon(f.options);

    expect(f.work.map(({ context }) => context.kind)).toEqual([
      'full', 'discovery', 'full', 'discovery', 'full', 'discovery',
    ]);
    expect(f.work.filter((row) => row.context.kind === 'full').map((row) => row.at))
      .toEqual([0, poll, poll * 2]);
    expect(f.work.map(({ context }) => context.iteration)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(f.work[3]!.context).toEqual({ kind: 'discovery', iteration: 4 });
    expect(f.full.mock.calls.every(([options]) => options.scanSoft === false)).toBe(true);
  });

  it.each(['recovery', 'durable-scan'] as const)(
    'does not discover from startBlock after startup %s failure',
    async (stage) => {
      const f = fixture();

      const normal = f.full.getMockImplementation()!;

      f.full.mockImplementationOnce(async (options) => ({
        ...(stage === 'recovery' ? { recoveryFailed: true } : {}),
        consumers: [{
          status: 'failed',
          consumer: options.consumers[0]!,
          error: new Error('Startup failure'),
        }],
      }));
      f.options.startBlock = 0n;
      f.setLatest(5_000_000n);
      f.options.onWork = async (result, context) => {
        f.work.push({ result, context, at: f.options.monotonicNow!() });

        if (context.iteration === 2) {
          expect(f.options.publicClient.getBlockNumber).not.toHaveBeenCalled();
          expect(f.getLogs).not.toHaveBeenCalled();
          expect(result.discoveryCompleted).toBe(false);
          expect(f.importer).not.toHaveBeenCalled();
        }

        if (context.iteration === 4) {
          f.controller.abort();
        }
      };
      f.full.mockImplementation(async (options) => {
        const result = await normal(options);

        for (const outcome of result.consumers) {
          if (outcome.status === 'success') {
            outcome.iteration.durableBlock = 4_999_999n;
            outcome.iteration.durableNextBlock = 5_000_000n;
          }
        }

        return result;
      });

      await runDaemon(f.options);

      expect(f.work.map(({ context }) => context.kind))
        .toEqual(['full', 'discovery', 'full', 'discovery']);
      expect(f.options.sleep).toHaveBeenCalledExactlyOnceWith(15_000, f.controller.signal);
      expect(f.options.publicClient.getLogs).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ fromBlock: 5_000_000n, toBlock: 5_000_000n }),
      );
      expect(f.work[3]!.result.discoveryCompleted).toBe(true);
    },
  );

  it('keeps two healthy consumers in one ordinary discovery pass per interval', async () => {
    const f = fixture();

    const other = `0x${'44'.repeat(20)}` as const;

    f.options.consumers = [...f.options.consumers, { address: other, registry: REGISTRY }];

    vi.mocked(f.options.publicClient.getBlockNumber).mockImplementation(async () => {
      f.advance(100);
      return 10n + BigInt(Math.floor(f.options.monotonicNow!() / 15_000));
    });
    f.getLogs.mockImplementation(async () => {
      f.advance(200);
      return [];
    });

    await runDaemon(f.options);

    const discovery = f.work.filter(({ context }) => context.kind === 'discovery');

    expect(f.work.map(({ context }) => context.kind))
      .toEqual(['full', 'discovery', 'full', 'discovery', 'full', 'discovery']);
    expect(discovery.map(({ at }) => at)).toEqual([600, 16_200, 31_800]);
    expect(discovery.map(({ result }) => result.discoveryCompleted)).toEqual([true, true, true]);
    expect(f.options.publicClient.getBlockNumber).toHaveBeenCalledTimes(6);
    expect(vi.mocked(f.options.publicClient.getLogs).mock.calls.map(([args]) => args!.address))
      .toEqual([[CONSUMER], [other], [CONSUMER], [other], [CONSUMER], [other]]);
  });

  it('stops at its own moving head and performs no third head read before poll', async () => {
    const f = fixture();

    let head = 10n;

    vi.mocked(f.options.publicClient.getBlockNumber).mockImplementation(async () => {
      f.calls.push('eth_blockNumber');
      return head++;
    });
    f.options.onWork = async (result, context) => {
      f.work.push({ result, context, at: 0 });
      if (context.iteration === 4) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    expect(f.calls).toEqual([
      'recover', 'eth_blockNumber', 'eth_getLogs',
      'recover', 'eth_blockNumber', 'eth_getLogs',
    ]);
    expect(f.options.sleep).toHaveBeenCalledExactlyOnceWith(15_000, f.controller.signal);
  });

  it('runs exactly two capped ranges, then waits before a third head read', async () => {
    const f = fixture();

    f.setLatest(4_000n);
    f.options.onWork = async (result, context) => {
      f.work.push({ result, context, at: 0 });
      if (context.iteration === 4) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    expect(f.calls).toEqual([
      'recover',
      'eth_blockNumber', 'eth_getLogs',
      'eth_blockNumber', 'eth_getLogs',
      'recover',
    ]);
    expect(f.options.sleep).toHaveBeenCalledExactlyOnceWith(15_000, f.controller.signal);
    expect(vi.mocked(f.options.publicClient.getLogs).mock.calls.map(([args]) => ({
      from: args!.fromBlock,
      to: args!.toBlock,
      address: args!.address,
    }))).toEqual([
      { from: 1n, to: 2_000n, address: [CONSUMER] },
      { from: 2_001n, to: 4_000n, address: [CONSUMER] },
    ]);
    expect(f.work[2]!.result.consumers[0]).toMatchObject({
      latestBlock: 4_000n,
      softNextBlock: 4_001n,
    });
  });

  it('makes one head-only call when discovery is caught up', async () => {
    const f = fixture();

    await runDaemon(f.options);

    expect(f.calls).toEqual([
      'recover', 'eth_blockNumber', 'eth_getLogs',
      'recover', 'eth_blockNumber',
      'recover', 'eth_blockNumber',
    ]);
  });

  it('queues a released request and runs recovery before dispatch without sleeping', async () => {
    const f = fixture();

    f.request();
    f.options.onWork = async (result, context) => {
      f.work.push({ result, context, at: 0 });
      if (context.iteration === 3) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    expect(f.calls).toEqual(['recover', 'eth_blockNumber', 'eth_getLogs', 'recover']);
    expect(f.importer).toHaveBeenCalledExactlyOnceWith(ROUND);
    expect(f.options.sleep).not.toHaveBeenCalled();
    expect(f.work[2]!.result.consumers[0]).toMatchObject({ latestBlock: 10n, softNextBlock: 11n });
  });

  it.each(['unattributed-signer-activity', 'conflict-search-exhausted', 'future-unknown'])(
    'does not accelerate released duplicates behind %s', async (blocker) => {
      const f = fixture();

      f.state.open = false;
      f.state.blockers = [blocker];
      f.request();
      f.request();

      await runDaemon(f.options);

      expect(f.work.filter((row) => row.context.kind === 'full').map((row) => row.at))
        .toEqual([0, 15_000, 30_000]);
      expect(f.importer).not.toHaveBeenCalled();
    },
  );

  it('rechecks a backward wall step and wakes at release without dispatching early', async () => {
    const f = fixture();

    f.setWall(RELEASE - 1_000);
    f.request();
    f.options.sleep = vi.fn(async (delay) => {
      f.advance(delay);
    });
    f.options.onWork = async (result, context) => {
      f.work.push({ result, context, at: 0 });
      if (context.iteration === 2) {
        f.setWall(RELEASE - 2_000);
      }
      if (context.iteration === 3) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    expect(f.options.sleep).toHaveBeenCalledExactlyOnceWith(2_000, f.controller.signal);
    expect(f.importer).toHaveBeenCalledExactlyOnceWith(ROUND);
  });

  it('bounds wall-clock rechecks by polling and notices a forward step', async () => {
    const f = fixture();

    f.setWall(RELEASE - 60_000);
    f.request();
    f.options.sleep = vi.fn(async (delay) => {
      f.advance(delay);
      f.setWall(RELEASE + 1_000);
    });
    f.options.onWork = async (_result, context) => {
      if (context.iteration === 3) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    expect(f.options.sleep).toHaveBeenCalledExactlyOnceWith(15_000, f.controller.signal);
    expect(f.importer).toHaveBeenCalledExactlyOnceWith(ROUND);
  });

  it('yields sustained soft backlog to due full work', async () => {
    const f = fixture();

    vi.mocked(f.options.publicClient.getBlockNumber).mockImplementation(async () => {
      f.advance(15_000);
      return 100_000n;
    });

    await runDaemon(f.options);

    expect(f.work.map(({ context }) => context.kind)).toEqual([
      'full', 'discovery', 'full', 'discovery', 'full', 'discovery',
    ]);
    expect(f.options.sleep).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'failed'] as const)(
    'delays %s and unattempted released work without a busy loop',
    async (outcome) => {
      const f = fixture();

      f.setWall(RELEASE + 60_000);
      f.request(17);

      if (outcome === 'failed') {
        f.importer.mockRejectedValue(new Error('Import unavailable'));
      } else {
        f.importer.mockImplementation(async (round) => ({
          status: 'waiting',
          reason: 'round-not-released',
          round,
          releaseTime: roundScheduledTime(round),
        }));
      }

      f.options.onWork = async (result, context) => {
        f.work.push({ result, context, at: f.options.monotonicNow!() });

        if (context.iteration === 7) {
          f.controller.abort();
        }
      };

      await runDaemon(f.options);

      const fullTimes = f.work.filter(({ context }) => context.kind === 'full').map(({ at }) => at);

      expect(fullTimes).toEqual([0, 0, 15_000, 30_000]);
      expect(f.options.sleep).toHaveBeenCalledTimes(2);
    },
  );

  it('continues an explicit dispatch remainder immediately after sixteen handoffs', async () => {
    const f = fixture();

    f.setWall(RELEASE + 60_000);
    f.request(17);
    f.options.onWork = async (result, context) => {
      f.work.push({ result, context, at: 0 });

      if (context.iteration === 4) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    expect(f.work.map(({ context }) => context.kind))
      .toEqual(['full', 'discovery', 'full', 'full']);
    expect(f.importer).toHaveBeenCalledTimes(17);
    expect(f.options.sleep).not.toHaveBeenCalled();
  });

  it('binds transaction lifecycle calls to full cycle, not work iteration', async () => {
    const f = fixture();

    const normal = f.full.getMockImplementation()!;

    f.full.mockImplementation(async (options) => {
      await options.submitter.recover();
      return normal(options);
    });

    await runDaemon(f.options);

    expect(vi.mocked(f.options.submitter.recover).mock.calls).toEqual([[1], [2], [3]]);
  });

  it('does not publish an interrupted discovery or start another work item', async () => {
    const f = fixture();

    f.getLogs.mockImplementationOnce(async () => {
      f.controller.abort(new Error('Stopped during query'));
      return [];
    });

    await expect(runDaemon(f.options)).rejects.toThrow('Stopped during query');
    expect(f.work.map(({ context }) => context.kind)).toEqual(['full']);
    expect(f.full).toHaveBeenCalledOnce();
  });

  it('preserves a prior durable view when recovery fails before scanning', async () => {
    const f = fixture();

    const normal = f.full.getMockImplementation()!;

    let count = 0;

    f.full.mockImplementation(async (options) => {
      if (++count === 2) {
        return { recoveryFailed: true, consumers: [{
          status: 'failed', consumer: options.consumers[0]!, error: new Error('recovery failed'),
        }] };
      }
      return normal(options);
    });

    await runDaemon(f.options);

    expect(f.work[2]!.result.consumers).toEqual(f.work[1]!.result.consumers);
  });

  it('invalidates only the durable side when its consumer scan fails', async () => {
    const f = fixture();

    const normal = f.full.getMockImplementation()!;

    let calls = 0;

    f.full.mockImplementation(async (options) => {
      if (++calls === 2) {
        return { consumers: [{
          status: 'failed',
          consumer: options.consumers[0]!,
          error: new Error('Durable scan failed'),
        }] };
      }

      return normal(options);
    });

    await runDaemon(f.options);

    expect(f.work[1]!.result.consumers[0]?.status).toBe('healthy');
    expect(f.work[2]!.result.consumers[0]?.status).toBe('failed');
    expect(f.work[3]!.result.consumers[0]?.status).toBe('failed');
    expect(f.work[4]!.result.consumers[0]?.status).toBe('healthy');
  });

  it('keeps failed-consumer backoff during another consumer’s continuation', async () => {
    const f = fixture();

    const other = `0x${'44'.repeat(20)}` as const;

    f.options.consumers = [...f.options.consumers, { address: other, registry: REGISTRY }];
    f.setLatest(4_000n);
    f.getLogs.mockRejectedValueOnce(new Error('First consumer unavailable'));
    f.options.onWork = async (result, context) => {
      f.work.push({ result, context, at: f.options.monotonicNow!() });

      if (context.iteration === 4) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    expect(f.work.map(({ context }) => context.kind))
      .toEqual(['full', 'discovery', 'discovery', 'full']);
    expect(f.work[1]!.result.discoveryCompleted).toBe(false);
    expect(f.work[2]!.result.discoveryCompleted).toBe(false);
    expect(f.work[2]!.result.consumers).toEqual([
      { consumer: CONSUMER, status: 'failed' },
      expect.objectContaining({ consumer: other, status: 'healthy', softNextBlock: 4_001n }),
    ]);
    expect(f.options.publicClient.getBlockNumber).toHaveBeenCalledTimes(3);
    expect(f.options.sleep).toHaveBeenCalledExactlyOnceWith(15_000, f.controller.signal);
  });

  it('evicts future work in favor of an urgent discovered round', async () => {
    const f = fixture();

    const transitions = vi.fn();

    f.getLogs.mockResolvedValueOnce(Array.from({ length: 1_025 }, (_, index) => ({
      address: CONSUMER,
      args: { round: ROUND + BigInt(1_024 - index) },
      blockNumber: 1n,
      transactionHash: HASH,
      logIndex: index,
    })));
    f.options.onWaitTransition = transitions;
    f.options.onWork = async (_result, context) => {
      if (context.iteration === 3) {
        f.controller.abort();
      }
    };

    await runDaemon(f.options);

    const evictions = transitions.mock.calls.filter(([event]) => event.kind === 'evicted');

    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toEqual([
      expect.objectContaining({
        kind: 'evicted',
        entry: expect.objectContaining({
          request: expect.objectContaining({ round: ROUND + 1_024n }),
        }),
      }),
      { iteration: 2, kind: 'discovery' },
    ]);
    expect(f.importer).toHaveBeenCalledExactlyOnceWith(ROUND);
    expect(f.options.sleep).not.toHaveBeenCalled();
  });

  it('keeps a discovery failure visible through full work until discovery succeeds', async () => {
    const f = fixture();

    f.getLogs.mockRejectedValueOnce(new Error('soft unavailable'));

    await runDaemon(f.options);

    expect(f.work[1]!.result.discoveryCompleted).toBe(false);
    expect(f.work[1]!.result.consumers[0]?.status).toBe('failed');
    expect(f.work[2]!.result.consumers[0]?.status).toBe('failed');
    expect(f.work[3]!.result.consumers[0]?.status).toBe('healthy');
  });

  it('forwards full-work options without soft-scan ownership', async () => {
    const f = fixture();

    await runDaemon(f.options);

    const first = f.full.mock.calls[0]![0];

    const second = f.full.mock.calls[1]![0];

    expect(first).toMatchObject({
      publicClient: f.options.publicClient,
      checkpointStore: f.options.checkpointStore,
      deployment: f.options.deployment,
      consumers: f.options.consumers,
      startBlock: 1n,
      maxBlockRange: 2_000n,
      finality: { type: 'safe' },
      scanSoft: false,
      signal: f.controller.signal,
    });
    expect(second.softCursors).toBe(first.softCursors);
    expect(first.softCursors.get(CONSUMER)).toEqual({ nextBlock: 11n });
  });

  it('reports discovery immediately in its own iteration without a cycle', async () => {
    const f = fixture();

    const discovered = vi.fn();

    f.request();
    f.options.onRequestDiscovered = discovered;

    await runDaemon(f.options);

    expect(discovered).toHaveBeenCalledWith(
      'soft',
      expect.objectContaining({ consumer: CONSUMER, round: ROUND }),
      { iteration: 2, kind: 'discovery' },
    );
  });

  it('rejects an invalid receipt timeout before starting work', async () => {
    const f = fixture();

    await expect(runDaemon({ ...f.options, receiptTimeoutMs: 0 })).rejects.toThrow();
    expect(f.full).not.toHaveBeenCalled();
  });

  it.each(['publication', 'sleep'] as const)('propagates %s failure', async (kind) => {
    const f = fixture();

    const error = new Error(kind);

    if (kind === 'publication') {
      f.options.onWork = async () => {
        throw error;
      };
    } else {
      f.options.sleep = async () => {
        throw error;
      };
    }

    await expect(runDaemon(f.options)).rejects.toBe(error);
    expect(f.full).toHaveBeenCalledOnce();
  });

  it('propagates unexpected action and publication errors without another work item', async () => {
    const f = fixture();

    const error = new Error('unexpected');

    f.full.mockRejectedValueOnce(error);

    await expect(runDaemon(f.options)).rejects.toBe(error);
    expect(f.work).toEqual([]);
    expect(f.options.sleep).not.toHaveBeenCalled();
  });

  it('keeps publication inside serial ownership and honors abort after it completes', async () => {
    const f = fixture();

    const held = Promise.withResolvers<void>();

    f.options.onWork = vi.fn(async () => held.promise);

    const running = runDaemon(f.options);

    await vi.waitFor(() => expect(f.options.onWork).toHaveBeenCalledOnce());

    f.controller.abort();

    expect(f.full).toHaveBeenCalledOnce();

    held.resolve();

    await running;

    expect(f.options.sleep).not.toHaveBeenCalled();
  });
});
