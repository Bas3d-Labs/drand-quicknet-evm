import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import pino from 'pino';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { HttpRequestError } from 'viem';

import {
  createDaemonLogger,
} from '../../src/daemon/daemon-logging.js';

import {
  createRelayerLog,
  type ConsumerHealth,
  type RelayerLog,
} from '../../src/diagnostics/relayer-log.js';

// Keep real Pino; intercept only the emergency stderr writer.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeSync: vi.fn(),
}));

const CHAIN_ID = 4663;

const CONSUMER =
  '0x1111111111111111111111111111111111111111';

const OTHER_CONSUMER =
  '0x2222222222222222222222222222222222222222';

const HASH = `0x${'ab'.repeat(32)}` as const;
const SECRET = 'logging-credential-canary';

const MAX_UINT256 = (1n << 256n) - 1n;
const FALLBACK_INTERVAL_MS = 5 * 60_000;

function providerError(): HttpRequestError {
  return new HttpRequestError({
    url: `https://rpc.example.test/${SECRET}`,
    body: { token: SECRET },
    details: SECRET,
    status: 429,
  });
}

function capture(level?: string) {
  const lines: string[] = [];

  const log = createRelayerLog({
    chainId: CHAIN_ID,
    ...(level === undefined ? {} : { level }),
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  return { log, lines };
}

function recordAt(
  lines: readonly string[],
  index = 0,
): Record<string, unknown> {
  const line = lines[index];

  if (line === undefined) {
    throw new Error('Expected a captured log line.');
  }

  expect(line.endsWith('\n')).toBe(true);

  return JSON.parse(line) as Record<string, unknown>;
}

function fallbackRecords(): Record<string, unknown>[] {
  return vi.mocked(writeSync).mock.calls.map((call) => {
    expect(call[0]).toBe(2);

    const line = call[1];

    if (typeof line !== 'string') {
      throw new Error('Expected a string written to stderr.');
    }

    return recordAt([line]);
  });
}

function healthyConsumer(
  block = 100n,
): ConsumerHealth {
  return {
    consumer: CONSUMER,
    status: 'healthy',
    latestBlock: block,
    durableBlock: block,
    durableNextBlock: block,
    softNextBlock: block,
  };
}

// Compile-time assertions only. This function is never called.
function assertLoggingTypes(log: RelayerLog): void {
  // @ts-expect-error Arbitrary Pino logging is not exposed.
  log.error('failed: %s', providerError());

  // @ts-expect-error Arbitrary child bindings are not exposed.
  log.child({ url: SECRET });

  log.consumerFailed({
    consumer: CONSUMER,
    error: null,
    // @ts-expect-error Undeclared fields are not event context.
    message: SECRET,
  });

  log.roundImported({
    consumer: CONSUMER,
    scanType: 'soft',
    // @ts-expect-error Rounds must be bigint.
    round: '40',
    transactionHash: HASH,
    submission: 'witness',
    fallbackReason: undefined,
  });

  // @ts-expect-error Application-specific events are not exposed.
  log.spinSettled({});
}

void assertLoggingTypes;

describe('createRelayerLog', () => {
  beforeEach(() => {
    vi.mocked(writeSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('exposes a frozen interface containing only approved methods', () => {
    const { log } = capture();

    expect(Object.isFrozen(log)).toBe(true);

    expect(Object.keys(log).sort()).toEqual([
      'checkpointAdvanced',
      'consumerFailed',
      'durableHeadRegressed',
      'heartbeat',
      'loggingFailed',
      'roundAlreadyStored',
      'roundImported',
    ]);
  });

  it('emits the fixed level, message, and fields for each event', () => {
    const { log, lines } = capture('debug');
    const error = new Error(SECRET);

    const summary = {
      name: 'Error',
      message: 'Operation failed; details redacted.',
    };

    log.consumerFailed({
      consumer: CONSUMER,
      error,
    });

    log.durableHeadRegressed({
      consumer: CONSUMER,
      durableBlock: 800n,
      durableNextBlock: 901n,
    });

    log.checkpointAdvanced({
      consumer: CONSUMER,
      fromBlock: 800n,
      toBlock: 899n,
      nextBlock: 900n,
    });

    log.roundImported({
      consumer: CONSUMER,
      scanType: 'soft',
      round: 40n,
      transactionHash: HASH,
      submission: 'witness',
      fallbackReason: undefined,
    });

    log.roundAlreadyStored({
      consumer: CONSUMER,
      scanType: 'durable',
      round: 41n,
    });

    log.heartbeat({
      consumers: [],
    });

    log.loggingFailed({
      error,
    });

    const expected = [
      {
        level: 50,
        event: 'consumer_failed',
        msg: 'Consumer processing failed',
        consumer: CONSUMER,
        err: summary,
      },
      {
        level: 40,
        event: 'durable_head_regressed',
        msg: 'Durable head is behind persisted checkpoint',
        consumer: CONSUMER,
        durableBlock: '800',
        durableNextBlock: '901',
      },
      {
        level: 20,
        event: 'checkpoint_advanced',
        msg: 'Durable checkpoint advanced',
        consumer: CONSUMER,
        fromBlock: '800',
        toBlock: '899',
        nextBlock: '900',
      },
      {
        level: 30,
        event: 'round_imported',
        msg: 'Quicknet round imported',
        consumer: CONSUMER,
        scanType: 'soft',
        round: '40',
        transactionHash: HASH,
        submission: 'witness',
      },
      {
        level: 20,
        event: 'round_already_stored',
        msg: 'Quicknet round already stored',
        consumer: CONSUMER,
        scanType: 'durable',
        round: '41',
      },
      {
        level: 30,
        event: 'heartbeat',
        msg: 'Relayer daemon heartbeat',
        consumers: [],
      },
      {
        level: 50,
        event: 'logging_failed',
        msg: 'Daemon logging failed',
        err: summary,
      },
    ];

    expect(lines).toHaveLength(expected.length);

    expected.forEach((record, index) => {
      expect(recordAt(lines, index)).toEqual({
        component: 'daemon',
        chainId: CHAIN_ID,
        time: expect.any(String),
        ...record,
      });
    });

    expect(lines.join('')).not.toContain(SECRET);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('defaults to info and suppresses debug events', () => {
    const { log, lines } = capture();

    log.roundAlreadyStored({
      consumer: CONSUMER,
      scanType: 'durable',
      round: 40n,
    });

    log.heartbeat({
      consumers: [],
    });

    expect(lines).toHaveLength(1);
    expect(recordAt(lines).event).toBe('heartbeat');
  });

  it('suppresses ordinary records at silent level', () => {
    const { log, lines } = capture('silent');

    log.consumerFailed({
      consumer: CONSUMER,
      error: providerError(),
    });

    log.heartbeat({
      consumers: [],
    });

    expect(lines).toHaveLength(0);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('warns safely about an invalid level and uses info filtering', () => {
    const { log, lines } = capture(SECRET);

    log.roundAlreadyStored({
      consumer: CONSUMER,
      scanType: 'durable',
      round: 40n,
    });

    log.heartbeat({
      consumers: [],
    });

    expect(lines).toHaveLength(2);

    expect(recordAt(lines)).toMatchObject({
      level: 40,
      event: 'invalid_log_level',
      code: 'INVALID_LOG_LEVEL',
      msg: 'Invalid log level; using info.',
    });

    expect(recordAt(lines, 1).event).toBe('heartbeat');
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('projects only declared fields without invoking extra hooks', () => {
    const { log, lines } = capture();

    const access = vi.fn(() => {
      throw new Error(SECRET);
    });

    const error = providerError();
    const originalMessage = error.message;

    // A variable can carry excess properties through TypeScript's checks.
    const context = {
      consumer: CONSUMER,
      error,
      message: SECRET,
      url: SECRET,
      lastError: error,
      toJSON: access,
      get extra() {
        return access();
      },
    } as const;

    log.consumerFailed(context);

    expect(lines).toHaveLength(1);

    expect(recordAt(lines)).toEqual({
      level: 50,
      time: expect.any(String),
      component: 'daemon',
      chainId: CHAIN_ID,
      event: 'consumer_failed',
      msg: 'Consumer processing failed',
      consumer: CONSUMER,
      err: {
        name: 'HttpRequestError',
        message: 'HTTP request failed.',
        status: 429,
      },
    });

    expect(access).not.toHaveBeenCalled();
    expect(error.message).toBe(originalMessage);
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('summarizes a non-Error value without copying it', () => {
    const { log, lines } = capture();

    log.consumerFailed({
      consumer: CONSUMER,
      error: SECRET,
    });

    expect(recordAt(lines).err).toEqual({
      name: 'UnknownError',
      message: 'Operation failed; details redacted.',
    });

    expect(lines.join('')).not.toContain(SECRET);
  });

  it('accepts fixed-length mixed-case addresses and hashes', () => {
    const { log, lines } = capture();

    const consumer = `0x${'aB'.repeat(20)}` as const;
    const hash = `0x${'Cd'.repeat(32)}` as const;

    log.roundImported({
      consumer,
      scanType: 'soft',
      round: 40n,
      transactionHash: hash,
      submission: 'witness',
      fallbackReason: undefined,
    });

    expect(recordAt(lines)).toMatchObject({
      consumer,
      transactionHash: hash,
    });
  });

  it.each([
    '',
    SECRET,
    null,
    1,
    `0x${'a'.repeat(39)}`,
    `0x${'a'.repeat(41)}`,
    `0x${'z'.repeat(40)}`,
    `0X${'a'.repeat(40)}`,
    `${CONSUMER}\n`,
  ])('rejects an invalid address: %#', (consumer) => {
    const { log, lines } = capture();

    expect(() => {
      log.consumerFailed({
        consumer: consumer as never,
        error: providerError(),
      });
    }).not.toThrow();

    expect(lines).toHaveLength(0);

    expect(fallbackRecords()).toEqual([
      expect.objectContaining({
        code: 'LOG_RECORD_REJECTED',
        rejected: 'consumer_failed',
      }),
    ]);

    expect(JSON.stringify(fallbackRecords())).not.toContain(SECRET);
  });

  it.each([
    `0x${'a'.repeat(63)}`,
    `0x${'a'.repeat(65)}`,
    `0x${'z'.repeat(64)}`,
  ])('rejects an invalid transaction hash: %#', (transactionHash) => {
    const { log, lines } = capture();

    log.roundImported({
      consumer: CONSUMER,
      scanType: 'soft',
      round: 40n,
      transactionHash: transactionHash as never,
      submission: 'witness',
      fallbackReason: undefined,
    });

    expect(lines).toHaveLength(0);

    expect(fallbackRecords()[0]).toMatchObject({
      code: 'LOG_RECORD_REJECTED',
      rejected: 'round_imported',
    });
  });

  it.each([
    0n,
    9_007_199_254_740_993n,
    MAX_UINT256,
  ])('serializes valid uint fields exactly: %s', (round) => {
    const { log, lines } = capture();

    log.roundImported({
      consumer: CONSUMER,
      scanType: 'soft',
      round,
      transactionHash: HASH,
      submission: 'witness',
      fallbackReason: undefined,
    });

    expect(recordAt(lines).round).toBe(round.toString());
  });

  it.each([
    -1n,
    MAX_UINT256 + 1n,
    40,
    '40',
    null,
  ])('rejects an invalid uint field: %#', (round) => {
    const { log, lines } = capture();

    log.roundImported({
      consumer: CONSUMER,
      scanType: 'soft',
      round: round as never,
      transactionHash: HASH,
      submission: 'witness',
      fallbackReason: undefined,
    });

    expect(lines).toHaveLength(0);

    expect(fallbackRecords()[0]).toMatchObject({
      code: 'LOG_RECORD_REJECTED',
      rejected: 'round_imported',
    });
  });

  it('rejects undeclared scan types', () => {
    const { log, lines } = capture('debug');

    log.roundAlreadyStored({
      consumer: CONSUMER,
      scanType: SECRET as never,
      round: 40n,
    });

    expect(lines).toHaveLength(0);

    expect(fallbackRecords()[0]).toMatchObject({
      code: 'LOG_RECORD_REJECTED',
      rejected: 'round_already_stored',
    });

    expect(JSON.stringify(fallbackRecords())).not.toContain(SECRET);
  });

  it('rejects missing or inherited required context fields', () => {
    for (const context of [
      {
        error: providerError(),
      },
      Object.assign(
        Object.create({ consumer: CONSUMER }),
        { error: providerError() },
      ),
    ]) {
      const { log, lines } = capture();

      log.consumerFailed(context as never);

      expect(lines).toHaveLength(0);
    }

    expect(writeSync).toHaveBeenCalledTimes(2);
  });

  it('rejects declared accessors without invoking them', () => {
    const { log, lines } = capture();

    const get = vi.fn(() => CONSUMER);

    const context = Object.defineProperty(
      { error: providerError() },
      'consumer',
      { get },
    );

    log.consumerFailed(context as never);

    expect(get).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);

    expect(fallbackRecords()[0]).toMatchObject({
      code: 'LOG_RECORD_REJECTED',
      rejected: 'consumer_failed',
    });
  });

  it('contains throwing descriptor traps and revoked proxies', () => {
    const trap = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error(SECRET);
      },
    });

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const context of [trap, revoked.proxy]) {
      const { log, lines } = capture();

      expect(() => {
        log.consumerFailed(context as never);
      }).not.toThrow();

      expect(lines).toHaveLength(0);
    }

    expect(writeSync).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fallbackRecords())).not.toContain(SECRET);
  });

  it('projects healthy and failed heartbeat entries', () => {
    const { log, lines } = capture();

    log.heartbeat({
      consumers: [
        {
          consumer: CONSUMER,
          status: 'healthy',
          latestBlock: 1_000n,
          durableBlock: 900n,
          durableNextBlock: 901n,
          softNextBlock: 1_001n,
        },
        {
          consumer: OTHER_CONSUMER,
          status: 'failed',
        },
      ],
    });

    expect(recordAt(lines).consumers).toEqual([
      {
        consumer: CONSUMER,
        status: 'healthy',
        latestBlock: '1000',
        durableBlock: '900',
        durableNextBlock: '901',
        softNextBlock: '1001',
      },
      {
        consumer: OTHER_CONSUMER,
        status: 'failed',
      },
    ]);

    expect(recordAt(lines)).not.toHaveProperty('consumersOmitted');
  });

  it('rejects sparse heartbeat arrays', () => {
    const { log, lines } = capture();
    const consumers = new Array<ConsumerHealth>(1);

    log.heartbeat({
      consumers,
    });

    expect(lines).toHaveLength(0);

    expect(fallbackRecords()[0]).toMatchObject({
      code: 'LOG_RECORD_REJECTED',
      rejected: 'heartbeat',
    });
  });

  it('does not invoke heartbeat entry getters', () => {
    const { log, lines } = capture();

    const get = vi.fn(() => healthyConsumer());
    const consumers: ConsumerHealth[] = [];

    Object.defineProperty(consumers, '0', { get });

    log.heartbeat({
      consumers,
    });

    expect(get).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);

    expect(fallbackRecords()[0]).toMatchObject({
      code: 'LOG_RECORD_REJECTED',
      rejected: 'heartbeat',
    });
  });

  it('bounds the emitted heartbeat and never reads omitted entries', () => {
    const { log, lines } = capture();

    const consumers = Array.from(
      { length: 26 },
      () => healthyConsumer(MAX_UINT256),
    );

    const get = vi.fn(() => {
      throw new Error(SECRET);
    });

    Object.defineProperty(consumers, '25', { get });

    log.heartbeat({
      consumers,
    });

    expect(lines).toHaveLength(1);
    expect(recordAt(lines).consumers).toHaveLength(25);
    expect(recordAt(lines).consumersOmitted).toBe(1);

    expect(
      Buffer.byteLength(lines[0]!, 'utf8'),
    ).toBeLessThanOrEqual(16_384);

    expect(get).not.toHaveBeenCalled();
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid chain ID at initialization: %#', (chainId) => {
    expect(() => {
      createRelayerLog({
        chainId,
      });
    }).toThrow(TypeError);

    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each([
    'chainId',
    'level',
    'destination',
  ])('rejects an accessor on initialization option %s', (key) => {
    const get = vi.fn(() => {
      throw new Error(SECRET);
    });

    const options = {
      chainId: CHAIN_ID,
    };

    Object.defineProperty(options, key, { get });

    expect(() => {
      createRelayerLog(options);
    }).toThrow(TypeError);

    expect(get).not.toHaveBeenCalled();
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('rejects an invalid destination at initialization', () => {
    expect(() => {
      createRelayerLog({
        chainId: CHAIN_ID,
        destination: { write: null } as never,
      });
    }).toThrow('Invalid logging destination.');

    expect(writeSync).not.toHaveBeenCalled();
  });

  it('propagates default destination initialization failures', () => {
    const failure = new Error('Destination initialization failed.');

    vi.spyOn(pino, 'destination').mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => {
      createRelayerLog({
        chainId: CHAIN_ID,
      });
    }).toThrow(failure);

    expect(writeSync).not.toHaveBeenCalled();
  });

  it('keeps attempting output after a stream error and a write failure', () => {
    const lines: string[] = [];

    const destination = Object.assign(new EventEmitter(), {
      write: vi.fn((line: string) => {
        lines.push(line);
      }),
    });

    const log = createRelayerLog({
      chainId: CHAIN_ID,
      destination,
    });

    expect(() => {
      destination.emit('error', new Error(SECRET));
    }).not.toThrow();

    destination.write.mockImplementationOnce(() => {
      throw new Error(SECRET);
    });

    expect(() => {
      log.consumerFailed({
        consumer: CONSUMER,
        error: providerError(),
      });
    }).not.toThrow();

    log.consumerFailed({
      consumer: CONSUMER,
      error: providerError(),
    });

    expect(destination.write).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);
    expect(recordAt(lines).event).toBe('consumer_failed');

    expect(fallbackRecords()).toEqual([
      expect.objectContaining({
        code: 'LOG_OUTPUT_FAILED',
      }),
      expect.objectContaining({
        code: 'LOG_OUTPUT_FAILED',
        rejected: 'consumer_failed',
      }),
    ]);

    expect(fallbackRecords()[0]).not.toHaveProperty('rejected');
    expect(JSON.stringify(fallbackRecords())).not.toContain(SECRET);
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('contains failure of stderr as well as the primary destination', () => {
    vi.mocked(writeSync).mockImplementation(() => {
      throw new Error(SECRET);
    });

    const log = createRelayerLog({
      chainId: CHAIN_ID,
      destination: {
        write() {
          throw new Error(SECRET);
        },
      },
    });

    expect(() => {
      log.consumerFailed({
        consumer: CONSUMER,
        error: providerError(),
      });
    }).not.toThrow();

    expect(writeSync).toHaveBeenCalledOnce();

    expect(
      JSON.stringify(vi.mocked(writeSync).mock.calls),
    ).not.toContain(SECRET);
  });

  it('rate-limits fallback independently by code and event', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);

    const log = createRelayerLog({
      chainId: CHAIN_ID,
      destination: {
        write() {
          throw new Error(SECRET);
        },
      },
    });

    const rejectConsumer = () => {
      log.consumerFailed({
        consumer: SECRET as never,
        error: providerError(),
      });
    };

    rejectConsumer();
    rejectConsumer();

    expect(writeSync).toHaveBeenCalledOnce();

    // Different code, same event: independently reported.
    log.consumerFailed({
      consumer: CONSUMER,
      error: providerError(),
    });

    log.consumerFailed({
      consumer: CONSUMER,
      error: providerError(),
    });

    expect(writeSync).toHaveBeenCalledTimes(2);

    // Same rejection code, different event: independently reported.
    log.heartbeat({
      consumers: [undefined] as never,
    });

    expect(writeSync).toHaveBeenCalledTimes(3);

    clock.mockReturnValue(FALLBACK_INTERVAL_MS - 1);
    rejectConsumer();

    expect(writeSync).toHaveBeenCalledTimes(3);

    clock.mockReturnValue(FALLBACK_INTERVAL_MS);
    rejectConsumer();

    expect(writeSync).toHaveBeenCalledTimes(4);

    expect(fallbackRecords()[0]).toEqual({
      level: 50,
      time: expect.any(Number),
      component: 'daemon',
      chainId: CHAIN_ID,
      event: 'logging_failed',
      code: 'LOG_RECORD_REJECTED',
      rejected: 'consumer_failed',
      msg: 'Relayer logging failed',
    });

    expect(fallbackRecords()[1]).toMatchObject({
      code: 'LOG_OUTPUT_FAILED',
      rejected: 'consumer_failed',
    });

    expect(fallbackRecords()[2]).toMatchObject({
      code: 'LOG_RECORD_REJECTED',
      rejected: 'heartbeat',
    });

    expect(JSON.stringify(fallbackRecords())).not.toContain(SECRET);
  });

  it('captures safe output through the real daemon logger', () => {
    const { log, lines } = capture();
    let now = 0;

    const daemonLogger = createDaemonLogger({
      logger: log,
      heartbeatIntervalMs: 1_000,
      now: () => now,
    });

    now = 1_000;

    daemonLogger.onCycle({
      consumers: [
        {
          status: 'failed',
          consumer: {
            address: CONSUMER,
            registry: OTHER_CONSUMER,
          },
          error: providerError(),
        },
      ],
    });

    expect(lines).toHaveLength(2);

    expect(recordAt(lines)).toMatchObject({
      event: 'consumer_failed',
      consumer: CONSUMER,
      err: {
        name: 'HttpRequestError',
        status: 429,
      },
    });

    expect(recordAt(lines, 1)).toMatchObject({
      event: 'heartbeat',
      consumers: [
        {
          consumer: CONSUMER,
          status: 'failed',
        },
      ],
    });

    expect(lines.join('')).not.toContain(SECRET);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each([
    'witness-rejected',
    'witness-decode-failed',
  ] as const)(
    'projects completed fallback metadata without provider fields: %s',
    (fallbackReason) => {
      const { log, lines } = capture('info');

      const context = {
        consumer: CONSUMER,
        scanType: 'durable',
        round: 1000n,
        transactionHash: HASH,
        submission: 'compressed',
        fallbackReason,
        error: providerError(),
        url: SECRET,
      } as const;

      log.roundImported(context);

      expect(recordAt(lines)).toMatchObject({
        event: 'round_imported',
        submission: 'compressed',
        fallbackReason,
      });

      expect(lines.join('')).not.toContain(SECRET);
      expect(recordAt(lines)).not.toHaveProperty('err');
      expect(recordAt(lines)).not.toHaveProperty('url');
    },
  );

  it.each([
    'submission',
    'fallbackReason',
  ] as const)(
    'rejects unrecognized %s without emitting its value',
    (field) => {
      const { log, lines } = capture();

      const context = {
        consumer: CONSUMER,
        scanType: 'durable',
        round: 1000n,
        transactionHash: HASH,
        submission: 'compressed',
        fallbackReason: 'witness-rejected',
        [field]: SECRET,
      };

      // Deliberately bypass the type boundary to test runtime validation.
      log.roundImported(context as never);

      expect(lines).toHaveLength(0);

      expect(
        JSON.stringify(fallbackRecords()),
      ).not.toContain(SECRET);

      expect(fallbackRecords()[0]).toMatchObject({
        code: 'LOG_RECORD_REJECTED',
        rejected: 'round_imported',
      });
  });
});