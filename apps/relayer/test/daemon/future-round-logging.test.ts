import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  createDaemonLogger,
} from '../../src/daemon/daemon-logging.js';

import {
  FutureRoundScheduler,
  MAX_WAITING_ROUNDS,
} from '../../src/daemon/future-round-scheduler.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

const CONSUMER = `0x${'11'.repeat(20)}` as const;

const REGISTRY = `0x${'22'.repeat(20)}` as const;

const HASH = `0x${'ab'.repeat(32)}` as const;

function setup() {
  const lines: string[] = [];

  const logger = createRelayerLog({
    chainId: 46630,
    level: 'debug',
    errorSummary: {
      scrubText: createScrubber({
        rpcUrls: [],
        secrets: [],
      }),
    },
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  let now = 1000;

  const daemon = createDaemonLogger({
    logger,
    now: () => now,
  });

  const queue = new FutureRoundScheduler({
    chainId: 46630,
    registry: REGISTRY,
    onTransition: daemon.onWaitTransition,
  });

  function offer(round: bigint) {
    queue.offer({
      consumer: CONSUMER,
      round,
      blockNumber: 10n,
      transactionHash: HASH,
      logIndex: 0,
    }, roundScheduledTime(round), 'durable');
  }

  return {
    daemon,
    queue,
    offer,
    records: () => lines.map((line) => JSON.parse(line)),
    heartbeat: () => {
      now += 60000;
      daemon.onCycle({
        consumers: [],
        waitingRejectedOffers: queue.rejectedOffers,
      });
    },
  };
}

describe('future-round diagnostics', () => {
  it('logs the first blocked dispatch and eventual handoff, not blocked repeats', async () => {
    const f = setup();

    f.offer(100n);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      f.offer(100n);

      const scheduled = await f.queue.dispatch(async (round) => ({
        status: 'deferred',
        reason: 'signer-unavailable',
        blocker: 'retention-capacity-reached',
        round,
      }));

      f.daemon.onCycle({
        consumers: [],
        scheduled,
      });
    }

    expect(f.records().find((r) => r.event === 'round_wait_started')).toMatchObject({
      level: 20,
      chainId: 46630,
      registry: REGISTRY,
      consumer: CONSUMER,
      transactionHash: HASH,
      blockNumber: '10',
      logIndex: '0',
      round: '100',
      releaseTime: roundScheduledTime(100n).toString(),
      scanType: 'durable',
    });
    expect(f.records().find((r) => r.event === 'round_deferred')).toMatchObject({
      level: 30,
      scanType: 'scheduled',
      reason: 'signer-unavailable',
      blocker: 'retention-capacity-reached',
    });
    expect(f.records().filter((r) => r.event === 'round_deferred')).toHaveLength(1);
    expect(f.records().filter((r) => r.event === 'round_wait_started')).toHaveLength(1);
    expect(f.records().filter((r) => r.event === 'round_wait_ended')).toHaveLength(0);

    const scheduled = await f.queue.dispatch(async (round) => ({
      status: 'imported',
      round,
      randomness: HASH,
      transactionHash: HASH,
      submission: 'witness',
    }));

    f.daemon.onCycle({
      consumers: [],
      scheduled,
    });

    expect(f.records().filter((r) => r.event === 'round_wait_ended')).toHaveLength(1);
    expect(f.records().at(-1)).toMatchObject({
      event: 'round_imported',
      scanType: 'scheduled',
    });

    f.offer(100n);

    const blocked = await f.queue.dispatch(async (round) => ({
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'recovery-incomplete',
      round,
    }));

    f.daemon.onCycle({
      consumers: [],
      scheduled: blocked,
    });

    expect(f.records().filter((r) => r.event === 'round_deferred')).toHaveLength(2);
  });

  it('emits info on eviction and only a periodic counter for rejected offers', () => {
    const f = setup();

    for (let i = 1; i <= MAX_WAITING_ROUNDS; i += 1) {
      f.offer(BigInt(i + 100));
    }

    f.offer(100n);
    f.offer(100000n);
    f.offer(100000n);
    f.heartbeat();

    expect(f.records().filter((record) => record.event === 'round_wait_ended'))
      .toMatchObject([{
        reason: 'evicted',
        level: 30,
      }]);
    expect(f.records().filter((record) => record.event === 'round_wait_started'))
      .toHaveLength(MAX_WAITING_ROUNDS + 1);
    expect(f.records().at(-1)).toMatchObject({
      event: 'heartbeat',
      waitingRejectedOffers: '2',
    });
  });

  it('keeps the wait episode open through retries and reports the scheduled failure', async () => {
    const f = setup();

    f.offer(100n);

    const scheduled = await f.queue.dispatch(async () => {
      throw new Error('endpoint late');
    });

    f.daemon.onCycle({
      consumers: [],
      scheduled,
    });

    expect(f.records().filter((record) => record.event === 'round_wait_ended'))
      .toHaveLength(0);
    expect(f.records().filter((record) => record.event === 'consumer_failed'))
      .toMatchObject([{
        consumer: CONSUMER,
        operation: {
          name: 'scheduled-import',
          round: '100',
        },
      }]);

    const completed = await f.queue.dispatch(async (round) => ({
      status: 'already-stored',
      round,
      randomness: HASH,
    }));

    f.daemon.onCycle({
      consumers: [],
      scheduled: completed,
    });

    expect(f.records().filter((record) => record.event === 'round_wait_started'))
      .toHaveLength(1);
    expect(f.records().at(-1)).toMatchObject({
      event: 'round_already_stored',
      scanType: 'scheduled',
    });
  });
});
