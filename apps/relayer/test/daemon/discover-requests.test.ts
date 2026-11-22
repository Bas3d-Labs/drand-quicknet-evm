import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';

import {
  createPublicClient,
  custom,
  encodeEventTopics,
  toHex,
} from 'viem';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  QUICKNET_RANDOMNESS_REQUESTED_EVENT,
} from '../../src/consumers/consumer-abi.js';

import {
  discoverRequests,
  type DiscoverRequestsOptions,
} from '../../src/daemon/discover-requests.js';

import {
  FutureRoundScheduler,
  MAX_WAITING_ROUNDS,
} from '../../src/daemon/future-round-scheduler.js';

const CONSUMER = `0x${'11'.repeat(20)}` as const;

const SECOND_CONSUMER = `0x${'33'.repeat(20)}` as const;

const REGISTRY = `0x${'22'.repeat(20)}` as const;

const HASH = `0x${'ab'.repeat(32)}` as const;

const RELEASE = Number(roundScheduledTime(100n) * 1000n);

function fixture(rounds: bigint[] = []) {
  const calls: { method: string; params: unknown }[] = [];

  const control = {
    now: RELEASE,
    latest: 12n,
    failure: '',
    afterRead: (_method: string) => {},
  };

  const publicClient = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        calls.push({ method, params });

        if (control.failure === method) {
          throw new Error('provider unavailable');
        }

        control.afterRead(method);

        if (method === 'eth_blockNumber') {
          return toHex(control.latest);
        }

        if (method === 'eth_getLogs') {
          return rounds.map((round, index) => ({
            address: CONSUMER,
            blockNumber: '0xa',
            blockHash: HASH,
            transactionHash: HASH,
            transactionIndex: '0x0',
            logIndex: toHex(index),
            removed: false,
            data: '0x',
            topics: encodeEventTopics({
              abi: [QUICKNET_RANDOMNESS_REQUESTED_EVENT],
              eventName: 'QuicknetRandomnessRequested',
              args: { round },
            }),
          }));
        }

        throw new Error(`Unexpected provider method: ${method}`);
      },
    }, { retryCount: 0 }),
  });

  const queue = new FutureRoundScheduler({
    chainId: 46630,
    registry: REGISTRY,
    now: () => control.now,
  });

  // Supply only the read and admission capabilities, with no type casts.
  const options: DiscoverRequestsOptions = {
    publicClient: {
      getBlockNumber: publicClient.getBlockNumber,
      getLogs: publicClient.getLogs,
    },
    queue: { admit: queue.admit.bind(queue) },
    consumer: CONSUMER,
    nextBlock: 10n,
    maxBlockRange: 2n,
    now: () => control.now,
  };

  return { calls, control, queue, options };
}

describe('disconnected request discovery', () => {
  it('accepts read and admission capabilities only', async () => {
    expectTypeOf<keyof DiscoverRequestsOptions>().toEqualTypeOf<
      | 'publicClient' | 'queue' | 'consumer' | 'nextBlock' | 'maxBlockRange'
      | 'now' | 'observationClock' | 'onRequestDiscovered' | 'signal'
    >();
    expectTypeOf<keyof DiscoverRequestsOptions['publicClient']>()
      .toEqualTypeOf<'getBlockNumber' | 'getLogs'>();
    expectTypeOf<keyof DiscoverRequestsOptions['queue']>()
      .toEqualTypeOf<'admit'>();

    const f = fixture([100n]);

    const result = await discoverRequests(f.options);

    expect(result.admissions[0]?.status).toBe('released');
    expect(f.calls.map((call) => call.method)).toEqual([
      'eth_blockNumber',
      'eth_getLogs',
    ]);
    expect(f.queue.size).toBe(1);
  });

  it('makes one head read and one bounded log query per consumer, in order', async () => {
    const f = fixture();

    for (const consumer of [CONSUMER, SECOND_CONSUMER]) {
      const result = await discoverRequests({ ...f.options, consumer });

      expect(result.scan).toMatchObject({
        status: 'scanned',
        fromBlock: 10n,
        toBlock: 11n,
        nextBlock: 12n,
        throughBlock: 12n,
      });
    }

    expect(f.calls).toEqual([CONSUMER, SECOND_CONSUMER].flatMap((consumer) => [
      { method: 'eth_blockNumber', params: undefined },
      {
        method: 'eth_getLogs',
        params: [{
          address: [consumer],
          fromBlock: '0xa',
          toBlock: '0xb',
          topics: encodeEventTopics({
            abi: [QUICKNET_RANDOMNESS_REQUESTED_EVENT],
            eventName: 'QuicknetRandomnessRequested',
          }),
        }],
      },
    ]));
  });

  it('skips the log query once caught up and reads latest again on the next pass', async () => {
    const f = fixture();

    const first = await discoverRequests({ ...f.options, nextBlock: 13n });

    expect(first.scan.status).toBe('caught-up');
    expect(first.admissions).toEqual([]);

    f.control.latest = 13n;

    await discoverRequests({ ...f.options, nextBlock: 13n });

    expect(f.calls.map((call) => call.method)).toEqual([
      'eth_blockNumber',
      'eth_blockNumber',
      'eth_getLogs',
    ]);
  });

  it('distinguishes released, future, duplicate and terminal requests', async () => {
    const f = fixture([99n, 100n, 101n, 100n, 0n]);

    const result = await discoverRequests(f.options);

    expect(result.admissions.map((admission) => admission.status)).toEqual([
      'released', 'released', 'queued', 'released', 'unfulfillable',
    ]);
    expect(result.admissions[3]).toMatchObject({ admission: 'duplicate' });
    expect(result.admissions[4]).toMatchObject({ reason: 'round-zero' });
    expect(f.queue.size).toBe(3);
  });

  it('treats the last millisecond before release as future work', async () => {
    const f = fixture([100n]);

    f.control.now = RELEASE - 1;

    const first = await discoverRequests(f.options);

    expect(first.admissions[0]?.status).toBe('queued');

    f.control.now = RELEASE;

    const second = await discoverRequests(f.options);

    expect(second.admissions[0]).toMatchObject({
      status: 'released',
      admission: 'duplicate',
    });
  });

  it('counts a rejected released offer and advances the scanned range', async () => {
    const f = fixture([2_000n]);

    f.control.now = Number(roundScheduledTime(2_000n) * 1000n);

    for (let round = 1n; round <= BigInt(MAX_WAITING_ROUNDS); round += 1n) {
      f.queue.offer({
        consumer: CONSUMER,
        round,
        blockNumber: 9n,
        transactionHash: HASH,
        logIndex: 0,
      }, roundScheduledTime(round));
    }

    const result = await discoverRequests(f.options);

    expect(result.admissions[0]?.status).toBe('rejected');
    expect(result.scan.nextBlock).toBe(12n);
    expect(f.queue.size).toBe(MAX_WAITING_ROUNDS);
    expect(f.queue.rejectedOffers).toBe(1n);
  });

  it.each([
    'eth_blockNumber',
    'eth_getLogs',
  ])('propagates %s failures without admission', async (method) => {
    const f = fixture([100n]);

    f.control.failure = method;

    await expect(discoverRequests(f.options)).rejects.toThrow();

    expect(f.queue.size).toBe(0);
    expect(f.calls.at(-1)?.method).toBe(method);
  });

  it.each([
    'before',
    'eth_blockNumber',
    'eth_getLogs',
  ])('honours cancellation at %s', async (point) => {
    const f = fixture([100n]);

    const controller = new AbortController();

    if (point === 'before') {
      controller.abort();
    }

    f.control.afterRead = (method) => {
      if (method === point) {
        controller.abort();
      }
    };

    await expect(discoverRequests({
      ...f.options,
      signal: controller.signal,
    })).rejects.toThrow();

    expect(f.queue.size).toBe(0);
  });

  it('isolates observer exceptions from calls and admission', async () => {
    const plain = fixture([100n]);

    const observed = fixture([100n]);

    const observer = vi.fn(() => { throw new Error('observer failed'); });

    const first = await discoverRequests(plain.options);

    const second = await discoverRequests({
      ...observed.options,
      onRequestDiscovered: observer,
    });

    expect(second).toEqual(first);
    expect(observed.calls).toEqual(plain.calls);
    expect(observer).toHaveBeenCalledOnce();
  });

  it.each([
    { nextBlock: -1n },
    { maxBlockRange: 0n },
    { maxBlockRange: -1n },
  ])('rejects an invalid range before any provider call', async (invalid) => {
    const f = fixture();

    await expect(discoverRequests({ ...f.options, ...invalid })).rejects.toThrow();

    expect(f.calls).toEqual([]);
  });
});
