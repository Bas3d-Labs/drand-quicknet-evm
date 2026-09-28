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
  WalletClient,
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

  it('shares durable polling across consumers and cycles', async () => {
    let now = 0;

    vi.spyOn(performance, 'now').mockImplementation(() => now);

    const getBlock = vi.fn()
      .mockResolvedValueOnce({ number: 100n })
      .mockResolvedValue({ number: 110n });

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

    const sleep = vi.fn(async () => {
      if (cycles.length === 1) {
        now = 29_999;
      } else {
        now = 30_000;
      }
    });

    await runDaemon({
      publicClient,
      walletClient: {} as WalletClient,
      account: {} as Account,
      deployment: {} as RegistryDeployment,
      checkpointStore,
      consumers: [
        { address: CONSUMER_A, registry: REGISTRY },
        { address: CONSUMER_B, registry: REGISTRY },
      ],
      startBlock: 101n,
      maxBlockRange: 1_000n,
      finality: { type: 'safe' },
      pollIntervalMs: 2_000,
      signal: controller.signal,
      sleep,
      onCycle(result) {
        cycles.push(result);

        if (cycles.length === 3) {
          controller.abort();
        }
      },
    });

    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(getBlock).toHaveBeenCalledWith({
      blockTag: 'safe',
    });

    // Latest-head reads still occur for each consumer iteration.
    expect(getBlockNumber).toHaveBeenCalledTimes(6);

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(
      2_000,
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