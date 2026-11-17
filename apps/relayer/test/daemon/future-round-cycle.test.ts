import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  FutureRoundScheduler,
} from '../../src/daemon/future-round-scheduler.js';

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
  processQuicknetRequestsWithOutcomes,
} from '../../src/consumers/request-processor.js';

import {
  runDaemonCycle,
} from '../../src/daemon/daemon-cycle.js';

import {
  runDaemonIteration,
} from '../../src/daemon/daemon-iteration.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  RoundImporter,
} from '../../src/rounds/create-round-importer.js';

import {
  BLOCKER_PRECEDENCE,
} from '../../src/state/signer-gate.js';

import {
  recoveryReport,
} from '../helpers/recovery-report.js';

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

function fixture(rounds = [100n]) {
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

function scheduling() {
  let now = Number(roundScheduledTime(100n) * 1000n) - 1000;

  const makeQueue = () => new FutureRoundScheduler({
    chainId: 46630,
    registry: REGISTRY,
    now: () => now,
  });

  return {
    makeQueue,
    release: () => {
      now += 1000;
    },
  };
}

describe('future-round scans and cycle wiring', () => {
  it.each(BLOCKER_PRECEDENCE)(
    'keeps queued work and normal sleep when recovery reports %s',
    async (blocker) => {
      const f = fixture();

      const waiting = scheduling().makeQueue();

      waiting.offer(request(99n), roundScheduledTime(99n));
      waiting.offer(request(100n), roundScheduledTime(100n));

      const bindRoundImporter = vi.fn(() => f.importRound);

      const recover = vi.fn().mockResolvedValue(recoveryReport(blocker));

      const result = await runDaemonCycle({
        ...f.options,
        waiting,
        bindRoundImporter,
        submitter: {
          recover,
        } as unknown as BeaconSubmitter,
        consumers: [],
        softCursors: new Map(),
      });

      expect(recover).toHaveBeenCalledTimes(1);
      expect(bindRoundImporter).not.toHaveBeenCalled();
      expect(f.importRound).not.toHaveBeenCalled();
      expect(result.scheduled).toBeUndefined();
      expect(waiting.size).toBe(2);
      expect(waiting.sleepMilliseconds(5000, result.scheduled)).toBe(5000);
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it('uses each recovery result and dispatches in the cycle that reopens the gate', async () => {
    const f = fixture();

    const waiting = scheduling().makeQueue();

    waiting.offer(request(99n), roundScheduledTime(99n));

    const recover = vi.fn()
      .mockResolvedValueOnce(recoveryReport('retention-capacity-reached'))
      .mockResolvedValueOnce(recoveryReport())
      .mockResolvedValueOnce(recoveryReport('retention-capacity-reached'));

    const options = {
      ...f.options,
      waiting,
      submitter: {
        recover,
      } as unknown as BeaconSubmitter,
      consumers: [],
      softCursors: new Map(),
    };

    const blocked = await runDaemonCycle(options);

    expect(blocked.scheduled).toBeUndefined();
    expect(f.importRound).not.toHaveBeenCalled();
    expect(waiting.size).toBe(1);

    const reopened = await runDaemonCycle(options);

    expect(reopened.scheduled?.handedOff).toBe(1);
    expect(f.importRound).toHaveBeenCalledExactlyOnceWith(99n);
    expect(recover.mock.invocationCallOrder[1]!)
      .toBeLessThan(f.importRound.mock.invocationCallOrder[0]!);
    expect(waiting.size).toBe(0);

    waiting.offer(request(98n), roundScheduledTime(98n));

    const closedAgain = await runDaemonCycle(options);

    expect(closedAgain.scheduled).toBeUndefined();
    expect(f.importRound).toHaveBeenCalledTimes(1);
    expect(waiting.size).toBe(1);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('continues soft discovery while scheduled dispatch is skipped', async () => {
    const f = fixture([99n]);

    f.setDurable(9n);

    const waiting = scheduling().makeQueue();

    waiting.offer(request(98n), roundScheduledTime(98n));

    f.importRound.mockResolvedValue({
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'retention-capacity-reached',
      round: 99n,
    });

    const softCursors = new Map();

    const result = await runDaemonCycle({
      ...f.options,
      waiting,
      softCursors,
      submitter: {
        recover: vi.fn().mockResolvedValue(recoveryReport('retention-capacity-reached')),
      } as unknown as BeaconSubmitter,
      consumers: [{
        address: CONSUMER,
        registry: REGISTRY,
      }] as const,
    });

    expect(result.scheduled).toBeUndefined();
    expect(result.consumers[0]?.status).toBe('success');
    expect(f.getLogs).toHaveBeenCalledTimes(1);
    expect(f.importRound).toHaveBeenCalledExactlyOnceWith(99n);
    expect(softCursors.get(CONSUMER)?.nextBlock).toBe(11n);
    expect(waiting.size).toBe(2);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('still honors importer refusal after recovery reports an open gate', async () => {
    const f = fixture();

    const waiting = scheduling().makeQueue();

    waiting.offer(request(98n), roundScheduledTime(98n));
    waiting.offer(request(99n), roundScheduledTime(99n));

    f.importRound.mockResolvedValue({
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'retention-capacity-reached',
      round: 98n,
    });

    const result = await runDaemonCycle({
      ...f.options,
      waiting,
      submitter: {
        recover: vi.fn().mockResolvedValue(recoveryReport()),
      } as unknown as BeaconSubmitter,
      consumers: [],
      softCursors: new Map(),
    });

    expect(f.importRound).toHaveBeenCalledExactlyOnceWith(98n);
    expect(result.scheduled?.blocked).toBe(true);
    expect(result.scheduled?.handedOff).toBe(0);
    expect(waiting.size).toBe(2);
    expect(waiting.sleepMilliseconds(1000, result.scheduled)).toBe(1000);
  });

  it('retries a scheduled throw before safe after soft discovery advances', async () => {
    const f = fixture();

    const time = scheduling();

    const waiting = time.makeQueue();

    f.setDurable(9n);

    const discovered = await runDaemonIteration({
      ...f.options,
      waiting,
    });

    expect(discovered.softCursor.nextBlock).toBe(11n);
    expect(discovered.durableNextBlock).toBe(10n);
    expect(f.importRound).not.toHaveBeenCalled();
    expect(waiting.size).toBe(1);

    time.release();
    f.importRound.mockRejectedValueOnce(new Error('beacon endpoint late'));

    const cycleOptions = {
      ...f.options,
      waiting,
      submitter: {
        recover: vi.fn().mockResolvedValue(recoveryReport()),
      } as unknown as BeaconSubmitter,
      consumers: [{
        address: CONSUMER,
        registry: REGISTRY,
      }] as const,
      softCursors: new Map([[CONSUMER, discovered.softCursor] as const]),
    };

    const first = await runDaemonCycle(cycleOptions);

    expect(first.scheduled?.failed).toBe(true);
    expect(first.consumers[0]?.status).toBe('success');
    expect(waiting.size).toBe(1);
    expect(f.save).not.toHaveBeenCalled();

    const second = await runDaemonCycle(cycleOptions);

    expect(second.scheduled?.handedOff).toBe(1);
    expect(waiting.size).toBe(0);
    expect(f.importRound).toHaveBeenCalledTimes(2);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('retries clean soft deferral from memory before durable rediscovery', async () => {
    const f = fixture([98n, 99n]);

    f.setDurable(9n);

    const waiting = scheduling().makeQueue();

    f.importRound.mockResolvedValueOnce({
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'retention-capacity-reached',
      round: 98n,
    });

    const discovered = await runDaemonIteration({
      ...f.options,
      waiting,
      onIncomplete: () => {
        throw new Error('observer failed');
      },
    });

    expect(discovered.softCursor.nextBlock).toBe(11n);
    expect(waiting.size).toBe(2);
    expect(f.importRound).toHaveBeenCalledTimes(1);

    const recover = vi.fn().mockResolvedValue(recoveryReport());

    const result = await runDaemonCycle({
      ...f.options,
      waiting,
      submitter: {
        recover,
      } as unknown as BeaconSubmitter,
      consumers: [{
        address: CONSUMER,
        registry: REGISTRY,
      }] as const,
      softCursors: new Map([[CONSUMER, discovered.softCursor]]),
    });

    expect(result.scheduled?.handedOff).toBe(2);
    expect(f.importRound.mock.calls.map(([round]) => round)).toEqual([98n, 98n, 99n]);
    expect(recover.mock.invocationCallOrder[0]!)
      .toBeLessThan(f.importRound.mock.invocationCallOrder[1]!);
    expect(f.getLogs).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(waiting.size).toBe(0);
  });

  it('offers durable clean deferrals without advancing the checkpoint', async () => {
    const f = fixture([98n, 99n]);

    const waiting = scheduling().makeQueue();

    f.importRound.mockResolvedValue({
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'retention-capacity-reached',
      round: 98n,
    });

    const result = await runDaemonIteration({
      ...f.options,
      waiting,
    });

    expect(result.durableNextBlock).toBe(10n);
    expect(f.save).not.toHaveBeenCalled();
    expect(waiting.size).toBe(2);
    expect(f.importRound).toHaveBeenCalledTimes(1);
  });

  it('rescans earlier-import-failed work without queuing it or advancing the cursor', async () => {
    const f = fixture([98n, 99n]);

    f.setDurable(9n);

    const waiting = scheduling().makeQueue();

    const softCursors = new Map([[CONSUMER, {
      nextBlock: 10n,
    }] as const]);

    const options = {
      ...f.options,
      waiting,
      softCursors,
      submitter: {
        recover: vi.fn().mockResolvedValue(recoveryReport()),
      } as unknown as BeaconSubmitter,
      consumers: [{
        address: CONSUMER,
        registry: REGISTRY,
      }] as const,
    };

    f.importRound.mockRejectedValueOnce(new Error('fetch failed'));

    const failed = await runDaemonCycle(options);

    expect(failed.consumers[0]?.status).toBe('failed');
    expect(softCursors.get(CONSUMER)?.nextBlock).toBe(10n);
    expect(waiting.size).toBe(0);

    await runDaemonCycle(options);

    expect(f.importRound.mock.calls.map(([round]) => round)).toEqual([98n, 98n, 99n]);
    expect(softCursors.get(CONSUMER)?.nextBlock).toBe(11n);
  });

  it('recovers, dispatches due work, then scans even after the dispatch throws', async () => {
    const f = fixture([99n]);

    const time = scheduling();

    const waiting = time.makeQueue();

    waiting.offer(request(98n), roundScheduledTime(98n));
    waiting.offer(request(97n), roundScheduledTime(97n));

    const recover = vi.fn().mockResolvedValue(recoveryReport());

    f.importRound.mockRejectedValueOnce(new Error('unavailable'));

    const options = {
      ...f.options,
      waiting,
      submitter: {
        recover,
      } as unknown as BeaconSubmitter,
      consumers: [{
        address: CONSUMER,
        registry: REGISTRY,
      }] as const,
      softCursors: new Map(),
    };

    const result = await runDaemonCycle(options);

    expect(result.scheduled?.attempted).toBe(1);
    expect(result.consumers[0]?.status).toBe('success');
    expect(f.importRound.mock.calls.map(([round]) => round)).toEqual([97n, 99n]);
    expect(recover.mock.invocationCallOrder[0]!)
      .toBeLessThan(f.importRound.mock.invocationCallOrder[0]!);
    expect(f.importRound.mock.invocationCallOrder[0]!)
      .toBeLessThan(f.getLogs.mock.invocationCallOrder[0]!);

    await runDaemonCycle(options);

    expect(f.importRound.mock.calls[2]![0]).toBe(98n);
  });

  it('does not dispatch or scan after failed recovery', async () => {
    const f = fixture();

    const waiting = scheduling().makeQueue();

    waiting.offer(request(99n), roundScheduledTime(99n));

    const result = await runDaemonCycle({
      ...f.options,
      waiting,
      submitter: {
        recover: vi.fn().mockRejectedValue(new Error('recovery failed')),
      } as unknown as BeaconSubmitter,
      consumers: [{
        address: CONSUMER,
        registry: REGISTRY,
      }] as const,
      softCursors: new Map(),
    });

    expect(result.scheduled).toBeUndefined();
    expect(waiting.sleepMilliseconds(1000, result.scheduled)).toBe(1000);
    expect(f.importRound).not.toHaveBeenCalled();
    expect(f.getLogs).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rediscovers from the checkpoint after restart (released: %s)',
    async (released) => {
      const f = fixture();

      const time = scheduling();

      const firstQueue = time.makeQueue();

      const first = await runDaemonIteration({
        ...f.options,
        waiting: firstQueue,
      });

      expect(first.softCursor.nextBlock).toBe(11n);
      expect(first.durableNextBlock).toBe(10n);
      expect(firstQueue.size).toBe(1);
      expect(f.save).not.toHaveBeenCalled();

      if (released) {
        time.release();
      }

      const restarted = time.makeQueue();

      await runDaemonIteration({
        ...f.options,
        waiting: restarted,
      });

      if (released) {
        expect(f.importRound).toHaveBeenCalledExactlyOnceWith(100n);
        expect(restarted.size).toBe(0);
      } else {
        expect(f.importRound).not.toHaveBeenCalled();
        expect(restarted.size).toBe(1);
      }

      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it('classifies waiting after a real failure and keeps later valid work deferred', async () => {
    const waiting = scheduling().makeQueue();

    const run = vi.fn<RoundImporter>().mockRejectedValue(new Error('fetch failed'));

    const outcomes = await processQuicknetRequestsWithOutcomes({
      waiting,
      importRound: run,
      requests: [request(98n), request(100n), request(99n)],
    });

    expect(outcomes.map((outcome) => outcome.status))
      .toEqual(['failed', 'waiting', 'deferred']);
    expect(run).toHaveBeenCalledExactlyOnceWith(98n);
    expect(waiting.size).toBe(1);
  });

  it('does not advance past a same-block waiting request or a moved closing anchor', async () => {
    const f = fixture([100n, 99n]);

    const waiting = scheduling().makeQueue();

    const first = await runDaemonIteration({
      ...f.options,
      waiting,
    });

    expect(first.durableNextBlock).toBe(10n);
    expect(f.importRound).toHaveBeenCalledExactlyOnceWith(99n);
    expect(f.readContract).toHaveBeenCalledTimes(2);

    f.readContract.mockResolvedValue(true);
    f.getBlock.mockResolvedValueOnce({
      number: 10n,
      hash: HASH,
    });
    f.getBlock.mockResolvedValueOnce({
      number: 10n,
      hash: `0x${'cd'.repeat(32)}`,
    });

    const second = await runDaemonIteration({
      ...f.options,
      waiting,
    });

    expect(second.durableNextBlock).toBe(10n);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('queues future work despite an earlier signer-unavailable result', async () => {
    const waiting = scheduling().makeQueue();

    const run = vi.fn<RoundImporter>().mockResolvedValue({
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'recovery-incomplete',
      round: 98n,
    });

    const outcomes = await processQuicknetRequestsWithOutcomes({
      waiting,
      importRound: run,
      requests: [request(98n), request(100n), request(99n)],
    });

    expect(outcomes.map((outcome) => outcome.status))
      .toEqual(['deferred', 'waiting', 'deferred']);
    expect(run).toHaveBeenCalledExactlyOnceWith(98n);
    expect(waiting.size).toBe(3);
  });

});
