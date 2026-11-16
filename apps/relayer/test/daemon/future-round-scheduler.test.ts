import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  FutureRoundScheduler,
  MAX_WAITING_ROUNDS,
  type ScheduledPass,
  type WaitTransition,
} from '../../src/daemon/future-round-scheduler.js';

import type {
  RoundImporter,
} from '../../src/rounds/create-round-importer.js';

import {
  waitingRound,
} from '../../src/rounds/round-release.js';

const CONSUMER = `0x${'11'.repeat(20)}` as const;

const REGISTRY = `0x${'22'.repeat(20)}` as const;

const HASH = `0x${'ab'.repeat(32)}` as const;

function request(round: bigint) {
  return {
    consumer: CONSUMER,
    round,
    blockNumber: 10n,
    transactionHash: HASH,
    logIndex: 0,
  };
}

function clock(round = 100n) {
  let now = Number(roundScheduledTime(round) * 1000n);

  const events: WaitTransition[] = [];

  const queue = new FutureRoundScheduler({
    chainId: 46630,
    registry: REGISTRY,
    now: () => now,
    onTransition: (event) => {
      events.push(event);
    },
  });

  return {
    queue,
    events,
    setNow: (value: number) => {
      now = value;
    },
    offer: (value: bigint) => queue.offer(request(value), roundScheduledTime(value)),
  };
}

function importer() {
  return vi.fn<RoundImporter>().mockImplementation(async (round) => ({
    status: 'already-stored',
    round,
    randomness: HASH,
  }));
}

function emptyPass(): ScheduledPass {
  return {
    attempted: 0,
    handedOff: 0,
    failed: false,
    outcomes: [],
  };
}

describe('future-round scheduler', () => {
  it('uses the exact release boundary and bigint for distant rounds', () => {
    const release = Number(roundScheduledTime(100n) * 1000n);

    expect(waitingRound(100n, () => release - 1)?.status).toBe('waiting');
    expect(waitingRound(100n, () => release)).toBeUndefined();
    expect(waitingRound(0n, () => release)).toBeUndefined();
    expect(waitingRound(-1n, () => release)).toBeUndefined();
    expect(waitingRound((1n << 64n) - 1n, () => release)?.releaseTime)
      .toBe(roundScheduledTime((1n << 64n) - 1n));
  });

  it('dispatches earliest releases first and leaves future work alone', async () => {
    const f = clock();

    f.offer(100n);
    f.offer(98n);
    f.offer(101n);

    const run = importer();

    await f.queue.dispatch(run);

    expect(run.mock.calls.map(([round]) => round)).toEqual([98n, 100n]);
    expect(f.queue.size).toBe(1);
    expect(f.events.map((event) => event.kind)).toEqual([
      'started',
      'started',
      'started',
      'released',
      'released',
    ]);
  });

  it('limits a pass to sixteen unique identities', async () => {
    const f = clock();

    for (let round = 1n; round <= 20n; round += 1n) {
      f.offer(round);
      f.offer(round);
    }

    const run = importer();

    const pass = await f.queue.dispatch(run);

    expect(pass.handedOff).toBe(16);
    expect(run).toHaveBeenCalledTimes(16);
    expect(f.queue.size).toBe(4);
    expect(f.queue.sleepMilliseconds(1000, pass)).toBe(0);
    expect(f.events.filter((event) => event.kind === 'started')).toHaveLength(20);
  });

  it('stops on the first throw, retains it, and lets never-failed work go first', async () => {
    const f = clock();

    f.offer(98n);
    f.offer(99n);

    const run = importer().mockRejectedValueOnce(new Error('endpoint unavailable'));

    const first = await f.queue.dispatch(run);

    expect(run).toHaveBeenCalledExactlyOnceWith(98n);
    expect(first.failed).toBe(true);
    expect(f.queue.size).toBe(2);
    expect(f.queue.sleepMilliseconds(1000, first)).toBe(1000);
    expect(f.events.filter((event) => event.kind === 'released')).toHaveLength(0);

    await f.queue.dispatch(run);

    expect(run.mock.calls.map(([round]) => round)).toEqual([98n, 99n, 98n]);
    expect(f.queue.size).toBe(0);
    expect(f.events.filter((event) => event.kind === 'started')).toHaveLength(2);
  });

  it('rotates entries that have all failed rather than starving the later one', async () => {
    const f = clock();

    f.offer(98n);
    f.offer(99n);

    const run = importer().mockRejectedValue(new Error('persistent failure'));

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const pass = await f.queue.dispatch(run);

      expect(pass.attempted).toBe(1);
      expect(f.queue.sleepMilliseconds(1000, pass)).toBe(1000);
    }

    expect(run.mock.calls.map(([round]) => round)).toEqual([98n, 99n, 98n, 99n]);
  });

  it('removes a clean deferral without turning it into scheduled retry', async () => {
    const f = clock();

    f.offer(100n);

    const run = importer().mockResolvedValue({
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'recovery-incomplete',
      round: 100n,
    });

    await f.queue.dispatch(run);
    await f.queue.dispatch(run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(f.queue.size).toBe(0);
    expect(f.events.at(-1)).toMatchObject({
      kind: 'released',
      disposition: 'deferred',
    });
  });

  it('propagates cancellation without recording a failed dispatch or exit', async () => {
    const f = clock();

    f.offer(100n);

    const controller = new AbortController();

    const run = importer().mockImplementation(async () => {
      controller.abort(new Error('stop'));
      controller.signal.throwIfAborted();
      throw new Error('unreachable');
    });

    await expect(f.queue.dispatch(run, controller.signal)).rejects.toThrow('stop');

    expect(f.queue.size).toBe(1);
    expect(f.events).toHaveLength(1);
  });

  it('rechecks time between dispatches and honours an importer eligibility recheck', async () => {
    const f = clock();

    f.offer(99n);
    f.offer(100n);

    const run = importer().mockImplementationOnce(async (round) => {
      f.setNow(Number(roundScheduledTime(99n) * 1000n));

      return {
        status: 'already-stored',
        round,
        randomness: HASH,
      };
    });

    await f.queue.dispatch(run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(f.queue.size).toBe(1);

    f.setNow(Number(roundScheduledTime(100n) * 1000n));
    run.mockResolvedValueOnce({
      status: 'waiting',
      reason: 'round-not-released',
      round: 100n,
      releaseTime: roundScheduledTime(100n),
    });

    const pass = await f.queue.dispatch(run);

    expect(pass.handedOff).toBe(0);
    expect(f.queue.size).toBe(1);
    expect(f.queue.sleepMilliseconds(1000, pass)).toBe(1000);
  });

  it('uses release-aware sleep without oversized timers or a recovery-failure spin', () => {
    const f = clock();

    f.offer(101n);
    f.offer((1n << 64n) - 1n);
    f.setNow(Number(roundScheduledTime(101n) * 1000n) - 200);

    expect(f.queue.sleepMilliseconds(1000, emptyPass())).toBe(200);
    expect(f.queue.sleepMilliseconds(1000)).toBe(1000);

    f.setNow(Number(roundScheduledTime(101n) * 1000n));

    expect(f.queue.sleepMilliseconds(1000, emptyPass())).toBe(1000);
  });

  it('keeps the soonest entries and provides no consumer reservation', async () => {
    const f = clock(2000n);

    const other = `0x${'33'.repeat(20)}` as const;

    f.queue.offer({
      ...request(2000n),
      consumer: other,
    }, roundScheduledTime(2000n));

    for (let round = 100n; round < 100n + BigInt(MAX_WAITING_ROUNDS - 1); round += 1n) {
      f.offer(round);
    }

    f.offer(99n);

    expect(f.queue.size).toBe(MAX_WAITING_ROUNDS);
    expect(f.events.find((event) => event.kind === 'evicted')?.entry.request.consumer)
      .toBe(other);

    const count = f.events.length;

    f.offer(2001n);
    f.offer(2001n);

    expect(f.queue.rejectedOffers).toBe(2n);
    expect(f.events).toHaveLength(count);
  });

  it('keeps scheduling when the reporter throws', async () => {
    const queue = new FutureRoundScheduler({
      chainId: 46630,
      registry: REGISTRY,
      onTransition: () => {
        throw new Error('destination failed');
      },
    });

    queue.offer(request(100n), roundScheduledTime(100n));

    await queue.dispatch(importer());

    expect(queue.size).toBe(0);
  });

  it('removes acknowledged handoffs, including a pending broadcast', async () => {
    const f = clock();

    f.offer(98n);
    f.offer(99n);

    const run = importer()
      .mockResolvedValueOnce({
        status: 'pending',
        reason: 'receipt-timeout',
        round: 98n,
        attemptId: 'bd4895c1-e491-4549-b0d6-f72e75cff1bc',
        transactionHash: HASH,
      })
      .mockResolvedValueOnce({
        status: 'imported',
        round: 99n,
        randomness: HASH,
        transactionHash: HASH,
        submission: 'witness',
      });

    const pass = await f.queue.dispatch(run);

    expect(pass.handedOff).toBe(2);
    expect(f.queue.size).toBe(0);

    await f.queue.dispatch(run);

    expect(run).toHaveBeenCalledTimes(2);
  });

});
