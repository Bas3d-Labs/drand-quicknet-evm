import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import {
  processQuicknetRequests,
  processQuicknetRequestsWithOutcomes,
} from '../../src/consumers/request-processor.js';

import {
  runDaemonCycle,
} from '../../src/daemon/daemon-cycle.js';

import {
  runDaemonIteration,
} from '../../src/daemon/daemon-iteration.js';

import {
  createDaemonLogger,
} from '../../src/daemon/daemon-logging.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  RoundImporter,
} from '../../src/rounds/create-round-importer.js';

import {
  terminalRoundReason,
} from '../../src/rounds/terminal-round-reason.js';

const CONSUMER = '0x1111111111111111111111111111111111111111';

const REGISTRY = '0x2222222222222222222222222222222222222222';

const HASH = `0x${'ab'.repeat(32)}` as const;

function request(round = 0n, logIndex = 0) {
  return {
    consumer: CONSUMER,
    round,
    blockNumber: 10n,
    transactionHash: HASH,
    logIndex,
  } as const;
}

function fixture(rounds = [0n]) {
  let checkpoint = 10n;

  let durable = 10n;

  const getLogs = vi.fn(async (query: {
    fromBlock: bigint;
    toBlock: bigint;
  }) => {
    if (query.fromBlock > 10n || query.toBlock < 10n) {
      return [];
    }

    return rounds.map((round, logIndex) => ({
      address: CONSUMER,
      args: {
        round,
      },
      blockNumber: 10n,
      transactionHash: HASH,
      logIndex,
    }));
  });

  const getBlock = vi.fn(async ({ blockNumber }: {
    blockNumber: bigint;
  }) => ({
    number: blockNumber,
    hash: HASH,
  }));

  const readContract = vi.fn().mockResolvedValue(false);

  const importRound = vi.fn<RoundImporter>().mockImplementation(async (round) => ({
    status: 'already-stored',
    round,
    randomness: HASH,
  }));

  const onUnfulfillable = vi.fn();

  const save = vi.fn(async (_consumer: string, next: bigint) => {
    checkpoint = next;
  });

  const options = {
    publicClient: {
      getLogs,
      getBlock,
      readContract,
    } as unknown as PublicClient,
    deployment: {
      chainId: 46630,
      address: REGISTRY,
      runtimeCodehash: HASH,
      verifierAddress: REGISTRY,
      verifierRuntimeCodehash: HASH,
    },
    submitter: {} as BeaconSubmitter,
    bindRoundImporter: () => importRound,
    checkpointStore: {
      load: async () => checkpoint,
      save,
    },
    consumer: CONSUMER,
    startBlock: 10n,
    maxBlockRange: 2n,
    finality: {
      type: 'safe' as const,
    },
    readChainHeads: async () => ({
      latestBlock: 10n,
      durableBlock: durable,
    }),
    onUnfulfillable,
  } as const;

  return {
    options,
    importRound,
    getLogs,
    getBlock,
    readContract,
    save,
    onUnfulfillable,

    setDurable(value: bigint) {
      durable = value;
    },
  };
}

describe('round-zero terminal requests', () => {
  it.each([1n, 100n, (1n << 64n) - 1n, -1n])(
    'does not classify %s as terminal',
    (round) => {
      expect(terminalRoundReason(round)).toBeUndefined();
    },
  );

  it('classifies only zero', () => {
    expect(terminalRoundReason(0n)).toBe('round-zero');
  });

  it('advances the soft cursor without moving the durable checkpoint early', async () => {
    const f = fixture();

    f.setDurable(9n);

    const result = await runDaemonIteration(f.options);

    expect(result.softCursor.nextBlock).toBe(11n);
    expect(result.durableNextBlock).toBe(10n);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.importRound).not.toHaveBeenCalled();
    expect(f.onUnfulfillable).toHaveBeenCalledWith('soft', request(), 'round-zero');
  });

  it('reports before saving and advances without registry reads', async () => {
    const f = fixture();

    f.onUnfulfillable.mockImplementation(() => {
      throw new Error('log destination failed');
    });

    const result = await runDaemonIteration(f.options);

    expect(result.durableNextBlock).toBe(11n);
    expect(f.importRound).not.toHaveBeenCalled();
    expect(f.readContract).not.toHaveBeenCalled();
    expect(f.getBlock).toHaveBeenCalledTimes(2);
    expect(f.onUnfulfillable).toHaveBeenCalledTimes(1);
    expect(f.onUnfulfillable.mock.invocationCallOrder[0]!)
      .toBeLessThan(f.save.mock.invocationCallOrder[0]!);
  });

  it('preserves a same-block valid pending request and imports it normally', async () => {
    const f = fixture([0n, 100n]);

    const first = await runDaemonIteration(f.options);

    expect(first.durableNextBlock).toBe(10n);
    expect(f.importRound).toHaveBeenCalledExactlyOnceWith(100n);
    expect(f.readContract).toHaveBeenCalledTimes(1);

    f.readContract.mockResolvedValue(true);

    expect((await runDaemonIteration(f.options)).durableNextBlock).toBe(11n);
  });

  it('refuses checkpoint advancement when the closing anchor moves', async () => {
    const f = fixture();

    f.getBlock.mockResolvedValueOnce({
      number: 10n,
      hash: HASH,
    });
    f.getBlock.mockResolvedValueOnce({
      number: 10n,
      hash: `0x${'cd'.repeat(32)}`,
    });

    expect((await runDaemonIteration(f.options)).durableNextBlock).toBe(10n);
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each(['blockNumber', 'transactionHash', 'logIndex'] as const)(
    'refuses checkpoint advancement with missing %s metadata',
    async (field) => {
      const f = fixture();

      f.getLogs.mockResolvedValueOnce([{
        address: CONSUMER,
        args: {
          round: 0n,
        },
        blockNumber: 10n,
        transactionHash: HASH,
        logIndex: 0,
        [field]: null,
      }] as never);

      await expect(runDaemonIteration(f.options)).rejects.toThrow(
        'Quicknet randomness request log is missing canonical log metadata.',
      );

      expect(f.save).not.toHaveBeenCalled();
      expect(f.importRound).not.toHaveBeenCalled();
      expect(f.onUnfulfillable).not.toHaveBeenCalled();
    },
  );

  it('rediscovers after a failed save and skips after a successful save', async () => {
    const f = fixture();

    f.save.mockRejectedValueOnce(new Error('save failed'));

    await expect(runDaemonIteration(f.options)).rejects.toThrow('save failed');

    expect(f.onUnfulfillable).toHaveBeenCalledTimes(1);

    await runDaemonIteration(f.options);

    expect(f.onUnfulfillable).toHaveBeenCalledTimes(2);

    await runDaemonIteration(f.options);

    expect(f.onUnfulfillable).toHaveBeenCalledTimes(2);
  });

  it('classifies zero after failure without releasing later valid work', async () => {
    const importRound = vi.fn<RoundImporter>()
      .mockRejectedValue(new Error('fetch failed'));

    const options = {
      importRound,
      requests: [request(1n), request(), request(2n)],
    };

    const outcomes = await processQuicknetRequestsWithOutcomes(options);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'failed',
      'unfulfillable',
      'deferred',
    ]);
    expect(outcomes[2]).toMatchObject({
      reason: 'earlier-import-failed',
    });
    expect(importRound).toHaveBeenCalledExactlyOnceWith(1n);

    await expect(processQuicknetRequests(options)).rejects.toThrow('fetch failed');

    await expect(processQuicknetRequests({
      ...options,
      requests: [request()],
    }))
      .resolves.toEqual({
        rounds: [],
      });
  });

  it('completes a healthy cycle and lets another consumer import valid work', async () => {
    const f = fixture();

    const other = '0x3333333333333333333333333333333333333333';

    f.getLogs.mockResolvedValueOnce([{
      address: CONSUMER,
      args: {
        round: 0n,
      },
      blockNumber: 10n,
      transactionHash: HASH,
      logIndex: 0,
    }]);
    f.getLogs.mockResolvedValueOnce([{
      address: other,
      args: {
        round: 100n,
      },
      blockNumber: 10n,
      transactionHash: HASH,
      logIndex: 0,
    }]);

    const softCursors = new Map();

    const result = await runDaemonCycle({
      ...f.options,
      submitter: {
        recover: vi.fn(),
      } as unknown as BeaconSubmitter,
      checkpointStore: {
        load: async () => 10n,
        save: vi.fn(),
      },
      consumers: [
        {
          address: CONSUMER,
          registry: REGISTRY,
        },
        {
          address: other,
          registry: REGISTRY,
        },
      ],
      softCursors,
    });

    expect(result.consumers.map((x) => x.status)).toEqual(['success', 'success']);
    expect(f.importRound).toHaveBeenCalledExactlyOnceWith(100n);
    expect(softCursors.get(CONSUMER).nextBlock).toBe(11n);
  });

  it('revisits only the first bounded range when the checkpoint is pinned', async () => {
    const f = fixture([100n]);

    const options = {
      ...f.options,
      readChainHeads: async () => ({
        latestBlock: 1000n,
        durableBlock: 1000n,
      }),
      softCursor: {
        nextBlock: 1001n,
      },
    };

    await runDaemonIteration(options);
    await runDaemonIteration(options);

    expect(f.getLogs.mock.calls.map(([q]) => [q.fromBlock, q.toBlock]))
      .toEqual([[10n, 11n], [10n, 11n]]);
  });

  it('suppresses repeats after a throwing emission attempt until restart', () => {
    const baseLogger = createRelayerLog({
      chainId: 46630,
      errorSummary: {
        scrubText: createScrubber({
          rpcUrls: [],
          secrets: [],
        }),
      },
      destination: {
        write: () => undefined,
      },
    });

    const emit = vi.fn(() => {
      throw new Error('destination failed');
    });

    const logger = {
      ...baseLogger,
      requestUnfulfillable: emit,
    };

    const reporter = createDaemonLogger({
      logger,
    });

    reporter.onUnfulfillable('soft', request(), 'round-zero');
    reporter.onUnfulfillable('durable', request(), 'round-zero');

    expect(emit).toHaveBeenCalledTimes(1);

    createDaemonLogger({
      logger,
    }).onUnfulfillable('durable', request(), 'round-zero');

    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('suppresses repeated identities with a bounded FIFO', () => {
    const lines: string[] = [];

    const logger = createRelayerLog({
      chainId: 46630,
      errorSummary: {
        scrubText: createScrubber({
          rpcUrls: [],
          secrets: [],
        }),
      },
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });

    const reporter = createDaemonLogger({
      logger,
    });

    reporter.onUnfulfillable('soft', request(), 'round-zero');
    reporter.onUnfulfillable('durable', request(), 'round-zero');
    reporter.onUnfulfillable('durable', {
      ...request(),
      transactionHash: HASH.toUpperCase().replace('0X', '0x') as typeof HASH,
    }, 'round-zero');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'request_unfulfillable',
      level: 30,
      chainId: 46630,
      consumer: CONSUMER,
      transactionHash: HASH,
      logIndex: '0',
      round: '0',
      reason: 'round-zero',
      scanType: 'soft',
    });

    for (let i = 1; i <= 1024; i += 1) {
      reporter.onUnfulfillable('durable', request(0n, i), 'round-zero');
    }

    reporter.onUnfulfillable('durable', request(), 'round-zero');

    expect(lines).toHaveLength(1026);

    createDaemonLogger({
      logger,
    }).onUnfulfillable('durable', request(), 'round-zero');

    expect(lines).toHaveLength(1027);
  });
});
