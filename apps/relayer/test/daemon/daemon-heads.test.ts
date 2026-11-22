import { performance } from 'node:perf_hooks';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Account,
  Address,
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  runDaemon,
} from '../../src/daemon/daemon.js';

import type {
  RunDaemonCycleResult,
} from '../../src/daemon/daemon-cycle.js';

import {
  recoveryReport,
} from '../helpers/recovery-report.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  CheckpointStore,
} from '../../src/state/checkpoint.js';

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const REGISTRY: Address =
  '0x3333333333333333333333333333333333333333';

describe('daemon chain-head polling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains fixed durable targets without moving the soft heartbeat pair', async () => {
    let checkpoint = 1n;
    let reads = 0;

    const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
    const anchors: bigint[] = [];
    const controller = new AbortController();
    const health: unknown[] = [];
    const kinds: string[] = [];

    const client = {
      async getBlockNumber() {
        return 6_000n;
      },
      async getBlock({ blockNumber }: { blockNumber: bigint }) {
        anchors.push(blockNumber);
        return { number: blockNumber, hash: `0x${'aa'.repeat(32)}` };
      },
      async getLogs(args: { fromBlock: bigint; toBlock: bigint }) {
        ranges.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
        return [];
      },
    } as unknown as PublicClient;

    await runDaemon({
      publicClient: client,
      account: {} as Account,
      submitter: {
        findRetainedWork: () => null,
        recover: async () => recoveryReport(),
        submit: vi.fn(),
      },
      deployment: { chainId: 46630, address: REGISTRY } as RegistryDeployment,
      checkpointStore: {
        async load() {
          return checkpoint;
        },
        async save(_consumer, next) {
          checkpoint = next;
        },
      },
      consumers: [{ address: CONSUMER_A, registry: REGISTRY }],
      startBlock: 1n,
      maxBlockRange: 2_000n,
      finality: { type: 'safe' },
      pollIntervalMs: 15_000,
      now: () => 0,
      monotonicNow: () => 0,
      readSchedulingState: () => ({ open: true, blockers: [], retainedCount: 0 }),
      readChainHeads: async () => ({
        latestBlock: 6_000n,
        durableBlock: ++reads === 1 ? 4_000n : 5_000n,
      }),
      sleep: async () => {
        throw new Error('Backlog should continue immediately');
      },
      signal: controller.signal,
      onWork(result, context) {
        kinds.push(context.kind);
        health.push(result.consumers[0]);

        if (context.iteration === 4) {
          controller.abort();
        }
      },
    });

    expect(kinds).toEqual(['full', 'discovery', 'full', 'full']);
    expect(ranges).toEqual([
      { fromBlock: 1n, toBlock: 2_000n },
      { fromBlock: 4_001n, toBlock: 6_000n },
      { fromBlock: 2_001n, toBlock: 4_000n },
      { fromBlock: 4_001n, toBlock: 5_000n },
    ]);
    expect(anchors).toEqual([4_000n, 4_000n, 4_000n, 4_000n, 5_000n, 5_000n]);
    expect(checkpoint).toBe(5_001n);
    expect(health.slice(1)).toEqual([
      expect.objectContaining({ latestBlock: 6_000n, softNextBlock: 6_001n }),
      expect.objectContaining({ latestBlock: 6_000n, softNextBlock: 6_001n }),
      expect.objectContaining({ latestBlock: 6_000n, softNextBlock: 6_001n }),
    ]);
  });

  it('shares durable polling across consumers and cycles', async () => {
    let now = 0;

    vi.spyOn(performance, 'now').mockImplementation(() => now);

    const getBlock = vi.fn(async (
      request: {
        blockTag?: string;
        blockNumber?: bigint;
      },
    ) => {
      if (request.blockNumber !== undefined) {
        return {
          number: request.blockNumber,
          hash: `0x${'aa'.repeat(32)}`,
        };
      }

      if (request.blockTag === 'safe') {
        let number = 100n;

        if (now >= 30_000) {
          number = 110n;
        }

        return {
          number,
          hash: `0x${'aa'.repeat(32)}`,
        };
      }

      throw new Error('Unexpected block request in test.');
    });

    const getBlockNumber = vi.fn(async () => {
      if (now >= 30_000) {
        return 220n;
      }

      if (now > 0) {
        return 210n;
      }

      return 200n;
    });

    const getLogs = vi.fn().mockResolvedValue([]);

    const publicClient = {
      getBlock,
      getBlockNumber,
      getLogs,
    } as unknown as PublicClient;

    const checkpoints = new Map<Address, bigint>([
      [CONSUMER_A, 101n],
      [CONSUMER_B, 101n],
    ]);

    const checkpointStore: CheckpointStore = {
      async load(consumer) {
        return checkpoints.get(consumer);
      },

      async save(consumer, nextBlock) {
        checkpoints.set(consumer, nextBlock);
      },
    };

    const controller = new AbortController();
    const cycles: RunDaemonCycleResult[] = [];

    const sleep = vi.fn(async (delay: number) => {
      now += delay;
    });

    const submitter: BeaconSubmitter = {
      findRetainedWork: vi.fn<BeaconSubmitter['findRetainedWork']>()
        .mockReturnValue(null),
      recover: vi.fn<BeaconSubmitter['recover']>()
        .mockResolvedValue(recoveryReport()),
      submit: vi.fn<BeaconSubmitter['submit']>(),
    };

    await runDaemon({
      now: () => now,
      monotonicNow: () => now,
      readSchedulingState: () => ({ open: true, blockers: [], retainedCount: 0 }),
      publicClient,
      account: {} as Account,
      submitter,
      deployment: {} as RegistryDeployment,
      checkpointStore,
      consumers: [
        { address: CONSUMER_A, registry: REGISTRY },
        { address: CONSUMER_B, registry: REGISTRY },
      ],
      startBlock: 101n,
      maxBlockRange: 1_000n,
      finality: { type: 'safe' },
      pollIntervalMs: 15_000,
      signal: controller.signal,
      sleep,
      onWork(result) {
        if (result.cycle === undefined) {
          return;
        }

        cycles.push(result.cycle);

        if (cycles.length === 3) {
          controller.abort();
        }
      },
    });

    expect(vi.mocked(submitter.recover).mock.calls).toEqual([
      [1],
      [2],
      [3],
    ]);

    expect(submitter.submit).not.toHaveBeenCalled();

    const safeReads = getBlock.mock.calls.filter(
      ([request]) => request.blockTag === 'safe',
    );

    expect(safeReads).toEqual([
      [{ blockTag: 'safe' }],
      [{ blockTag: 'safe' }],
    ]);

    const anchorReads = getBlock.mock.calls.filter(
      ([request]) => request.blockNumber !== undefined,
    );

    // Only the third cycle has durable work. Each consumer brackets
    // its empty durable scan with two fresh reads of block 110.
    expect(anchorReads).toEqual([
      [{ blockNumber: 110n }],
      [{ blockNumber: 110n }],
      [{ blockNumber: 110n }],
      [{ blockNumber: 110n }],
    ]);

    // Latest-head reads still occur for each consumer iteration.
    expect(getBlockNumber).toHaveBeenCalledTimes(10);

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(
      15_000,
      controller.signal,
    );

    const observedHeads = cycles.map((cycle) =>
      cycle.consumers.map((result) => {
        if (result.status === 'failed') {
          throw result.error;
        }

        return {
          latestBlock: result.iteration.latestBlock,
          durableBlock: result.iteration.durableBlock,
        };
      }),
    );

    expect(observedHeads).toEqual([
      [
        { latestBlock: 200n, durableBlock: 100n },
        { latestBlock: 200n, durableBlock: 100n },
      ],
      [
        { latestBlock: 210n, durableBlock: 100n },
        { latestBlock: 210n, durableBlock: 100n },
      ],
      [
        { latestBlock: 220n, durableBlock: 110n },
        { latestBlock: 220n, durableBlock: 110n },
      ],
    ]);

    expect(checkpoints.get(CONSUMER_A)).toBe(111n);
    expect(checkpoints.get(CONSUMER_B)).toBe(111n);
  });
});
