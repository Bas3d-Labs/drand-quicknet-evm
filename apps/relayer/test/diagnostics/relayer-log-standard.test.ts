import { writeSync } from 'node:fs';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { RpcRequestError } from 'viem';

import {
  createRelayerLog,
  type RelayerLog,
} from '../../src/diagnostics/relayer-log.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeSync: vi.fn(),
}));

const SECRET = 'logger-policy-canary';
const CONSUMER = '0x1111111111111111111111111111111111111111';

const EXPECTED_HASH = `0x${'aa'.repeat(32)}` as const;
const OBSERVED_HASH = `0x${'bb'.repeat(32)}` as const;
const LARGE_UINT = 9_007_199_254_740_993n;

const DURABLE_EVENTS = [
  {
    event: 'durable_fulfillment_pending',
    level: 20,
    message: 'Beacon is not stored at the selected durable block',
    fields: {
      consumer: CONSUMER,
      round: LARGE_UINT.toString(),
      durableBlock: '0',
    },
    emit(log: RelayerLog) {
      log.durableFulfillmentPending({
        consumer: CONSUMER,
        round: LARGE_UINT,
        durableBlock: 0n,
      });
    },
  },
  {
    event: 'durable_fulfillment_unavailable',
    level: 40,
    message:
      'Durable fulfillment unavailable. Checkpoint advancement deferred',
    fields: {
      consumer: CONSUMER,
      round: LARGE_UINT.toString(),
      durableBlock: '0',
      err: {
        name: 'Error',
        message: 'Historical read failed.',
      },
    },
    emit(log: RelayerLog) {
      log.durableFulfillmentUnavailable({
        consumer: CONSUMER,
        round: LARGE_UINT,
        durableBlock: 0n,
        error: new Error('Historical read failed.'),
      });
    },
  },
  {
    event: 'durable_anchor_changed',
    level: 40,
    message: 'Durable anchor changed. Checkpoint advancement deferred',
    fields: {
      consumer: CONSUMER,
      durableBlock: LARGE_UINT.toString(),
      expectedHash: EXPECTED_HASH,
      observedHash: OBSERVED_HASH,
    },
    emit(log: RelayerLog) {
      log.durableAnchorChanged({
        consumer: CONSUMER,
        durableBlock: LARGE_UINT,
        expectedHash: EXPECTED_HASH,
        observedHash: OBSERVED_HASH,
      });
    },
  },
  {
    event: 'durable_anchor_unavailable',
    level: 40,
    message:
      'Durable anchor unavailable. Checkpoint advancement deferred',
    fields: {
      consumer: CONSUMER,
      durableBlock: LARGE_UINT.toString(),
      err: {
        name: 'Error',
        message: 'Anchor read failed.',
      },
    },
    emit(log: RelayerLog) {
      log.durableAnchorUnavailable({
        consumer: CONSUMER,
        durableBlock: LARGE_UINT,
        error: new Error('Anchor read failed.'),
      });
    },
  },
];

const UNAVAILABLE_EVENTS = [
  {
    method: 'durableFulfillmentUnavailable',
    event: 'durable_fulfillment_unavailable',
  },
  {
    method: 'durableAnchorUnavailable',
    event: 'durable_anchor_unavailable',
  },
] as const;

// Exercise policy injection; the full scrubber has its own suite.
function scrubText(text: string) {
  return {
    text: text.replaceAll(SECRET, '[REDACTED]'),
    removed: text.includes(SECRET),
  };
}

function capture(level = 'info') {
  const lines: string[] = [];
  const policy = {
    scrubText,
  };

  const log = createRelayerLog({
    chainId: 4663,
    level,
    errorSummary: policy,
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  return { log, lines, policy };
}

describe('relayer log standard policy', () => {
  beforeEach(() => {
    vi.mocked(writeSync).mockReset();
  });

  it('preserves scrubbed provider text through Pino serialization', () => {
    const { log, lines } = capture();

    log.consumerFailed({
      consumer: CONSUMER,
      error: new RpcRequestError({
        body: {
          method: 'eth_getLogs',
          token: SECRET,
        },
        url: `https://rpc.example/${SECRET}`,
        error: {
          code: -32029,
          message: `public rate limit exceeded; token=${SECRET}`,
        },
      }),
    });

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record.err).toMatchObject({
      name: 'RpcRequestError',
      code: -32029,
      message: 'public rate limit exceeded; token=[REDACTED]',
      textModified: true,
      cause: {
        code: -32029,
        message: 'public rate limit exceeded; token=[REDACTED]',
      },
    });

    expect(record.err).not.toHaveProperty('url');
    expect(record.err).not.toHaveProperty('body');
    expect(record).not.toHaveProperty('operationOmitted');
    expect(lines.join('')).not.toContain(SECRET);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('uses the policy for logging failures too', () => {
    const { log, lines } = capture();

    log.loggingFailed({
      error: new Error(`output failed: ${SECRET}`),
    });

    expect(JSON.parse(lines[0]!).err.message)
      .toBe('output failed: [REDACTED]');
  });

  it('snapshots the policy at logger creation', () => {
    const { log, lines, policy } = capture();

    policy.scrubText = (text) => ({
      text,
      removed: false,
    });

    log.consumerFailed({
      consumer: CONSUMER,
      error: new Error(SECRET),
    });

    expect(lines.join('')).not.toContain(SECRET);
    expect(JSON.parse(lines[0]!).err.message).toBe('[REDACTED]');
  });

  it('rejects a scrubText accessor without invoking it', () => {
    const get = vi.fn(() => {
      throw new Error(SECRET);
    });

    const policy = { scrubText };

    Object.defineProperty(policy, 'scrubText', { get });

    expect(() => createRelayerLog({
      chainId: 4663,
      errorSummary: policy,
      destination: {
        write() {},
      },
    })).toThrow(TypeError);

    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { scrubText: null },
    { scrubText: SECRET },
  ])('rejects invalid policies without echoing values: %#', (policy) => {
    expect(() => createRelayerLog({
      chainId: 4663,
      errorSummary: policy as never,
      destination: {
        write() {},
      },
    })).toThrow('Invalid error summary policy.');
  });

  it('emits a safe placeholder when the scrubber fails', () => {
    const lines: string[] = [];

    const log = createRelayerLog({
      chainId: 4663,
      errorSummary: {
        scrubText() {
          throw new Error(SECRET);
        },
      },
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    log.consumerFailed({
      consumer: CONSUMER,
      error: new Error(SECRET),
    });

    expect(JSON.parse(lines[0]!).err.message)
      .toBe('[diagnostic text unavailable]');
    expect(lines.join('')).not.toContain(SECRET);
  });

  it.each(['😀', '"\\\n'])
    ('fits large summaries without discarding their tree: %j', (fragment) => {
      const { log, lines } = capture();
      const message =
        'provider explanation: ' +
        fragment.repeat(1_500) +
        SECRET;

      function tree(depth: number): Error {
        if (depth === 0) {
          return new Error(message);
        }

        return new AggregateError(
          Array.from({ length: 5 }, () => tree(depth - 1)),
          message,
          { cause: tree(depth - 1) },
        );
      }

      const error = tree(3);

      log.consumerFailed({
        consumer: CONSUMER,
        error,
      });

      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]!);

      expect(record.event).toBe('consumer_failed');
      expect(record.err.message).toContain('provider explanation:');
      expect(record.err.message).toContain('[truncated]');
      expect(record.err.textModified).toBe(true);
      expect(record.err.code).not.toBe('SUMMARY_UNAVAILABLE');
      expect(record.err.cause).toBeDefined();
      expect(record.err.cause.errors).toBeDefined();

      expect(Buffer.byteLength(JSON.stringify(record.err)))
        .toBeLessThanOrEqual(8_192);
      expect(Buffer.byteLength(lines[0]!))
        .toBeLessThanOrEqual(16_384);

      expect(lines.join('')).not.toContain(SECRET);
      expect(error.message).toBe(message);
      expect(writeSync).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'unknown operation',
      operation: { name: 'unknown-operation' },
    },
    {
      name: 'invalid import phase',
      operation: {
        name: 'import-round',
        scanType: 'durable',
        fromBlock: 100n,
        toBlock: 199n,
        round: 74n,
        phase: 'invalid-phase',
      },
    },
  ])('preserves the error with $name', ({ operation }) => {
    const { log, lines } = capture();

    log.consumerFailed({
      consumer: CONSUMER,
      error: new Error(`provider unavailable; token=${SECRET}`),
      operation: operation as never,
    });

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record).toMatchObject({
      event: 'consumer_failed',
      consumer: CONSUMER,
      err: {
        name: 'Error',
        message: 'provider unavailable; token=[REDACTED]',
        textModified: true,
      },
    });

    expect(record).not.toHaveProperty('operation');
    expect(record.operationOmitted).toBe(true);
    expect(lines.join('')).not.toContain(SECRET);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each(['context', 'operation'] as const)
    ('does not invoke an accessor on %s or lose the error', (location) => {
    const { log, lines } = capture();
    const get = vi.fn(() => {
      throw new Error(SECRET);
    });

    const operation = {
      name: 'read-chain-heads' as const,
    };

    const context = {
      consumer: CONSUMER as typeof CONSUMER,
      error: new Error(`provider unavailable; token=${SECRET}`),
      operation,
    };

    if (location === 'context') {
      Object.defineProperty(context, 'operation', { get });
    } else {
      Object.defineProperty(operation, 'name', { get });
    }

    log.consumerFailed(context);

    expect(get).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record.event).toBe('consumer_failed');
    expect(record.err.message).toBe(
      'provider unavailable; token=[REDACTED]',
    );
    expect(record).not.toHaveProperty('operation');
    expect(record.operationOmitted).toBe(true);
    expect(lines.join('')).not.toContain(SECRET);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each(DURABLE_EVENTS)(
    'emits the fixed schema and severity for $event',
    ({ event, level, message, fields, emit }) => {
      const { log, lines } = capture('debug');

      emit(log);

      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]!);

      expect(record).toMatchObject({
        level,
        component: 'daemon',
        chainId: 4663,
        event,
        msg: message,
        ...fields,
      });

      expect(typeof record.time).toBe('string');

      expect(Object.keys(record).sort()).toEqual([
        'level',
        'time',
        'component',
        'chainId',
        'event',
        'msg',
        ...Object.keys(fields),
      ].sort());

      expect(Buffer.byteLength(lines[0]!))
        .toBeLessThanOrEqual(16_384);

      expect(writeSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      level: 'debug',
      expected: [
        'durable_fulfillment_pending',
        'durable_fulfillment_unavailable',
        'durable_anchor_changed',
        'durable_anchor_unavailable',
      ],
    },
    {
      level: 'info',
      expected: [
        'durable_fulfillment_unavailable',
        'durable_anchor_changed',
        'durable_anchor_unavailable',
      ],
    },
    {
      level: 'warn',
      expected: [
        'durable_fulfillment_unavailable',
        'durable_anchor_changed',
        'durable_anchor_unavailable',
      ],
    },
    {
      level: 'error',
      expected: [],
    },
    {
      level: 'silent',
      expected: [],
    },
  ])('filters durable events at $level', ({ level, expected }) => {
    const { log, lines } = capture(level);

    for (const entry of DURABLE_EVENTS) {
      entry.emit(log);
    }

    expect(
      lines.map((line) => JSON.parse(line).event),
    ).toEqual(expected);

    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each(UNAVAILABLE_EVENTS)(
    'scrubs provider evidence and excludes raw fields for $event',
    ({ method, event }) => {
      const { log, lines } = capture();

      const error = new RpcRequestError({
        body: {
          method: 'eth_call',
          token: SECRET,
        },
        url: `https://rpc.example/${SECRET}`,
        error: {
          code: -32000,
          message: `historical state unavailable; token=${SECRET}`,
        },
      });

      Object.assign(error, {
        headers: { authorization: `Bearer ${SECRET}` },
        metaMessages: [`raw metadata ${SECRET}`],
      });

      const get = vi.fn(() => {
        throw new Error(SECRET);
      });

      const toJSON = vi.fn(() => ({
        secret: SECRET,
      }));

      const context = {
        consumer: CONSUMER as typeof CONSUMER,
        round: LARGE_UINT,
        durableBlock: 0n,
        error,
        secret: SECRET,
        toJSON,
      };

      Object.defineProperty(context, 'extra', {
        enumerable: true,
        get,
      });

      log[method](context);

      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]!);

      expect(record).toMatchObject({
        level: 40,
        event,
        consumer: CONSUMER,
        durableBlock: '0',
        err: {
          name: 'RpcRequestError',
          code: -32000,
          message: 'historical state unavailable; token=[REDACTED]',
          textModified: true,
        },
      });

      if (method === 'durableFulfillmentUnavailable') {
        expect(record.round).toBe(LARGE_UINT.toString());
      } else {
        // The caller supplied it, but this event does not declare it.
        expect(record).not.toHaveProperty('round');
      }

      for (const field of [
        'stack',
        'url',
        'body',
        'headers',
        'metaMessages',
        'secret',
        'extra',
        'toJSON',
      ]) {
        expect(lines[0]).not.toContain(
          JSON.stringify(field) + ':',
        );
      }

      expect(get).not.toHaveBeenCalled();
      expect(toJSON).not.toHaveBeenCalled();
      expect(lines.join('')).not.toContain(SECRET);
      expect(writeSync).not.toHaveBeenCalled();
    },
  );

  it.each(UNAVAILABLE_EVENTS)(
    'bounds a large error tree without losing its structure for $event',
    ({ method, event }) => {
      const { log, lines } = capture();

      const message =
        'provider explanation: ' +
        SECRET +
        '😀"\\\n'.repeat(1_500);

      const cause = new AggregateError(
        Array.from({ length: 5 }, () => new Error(message)),
        message,
      );

      const error = new AggregateError(
        Array.from({ length: 5 }, () => new Error(message)),
        message,
        { cause },
      );

      log[method]({
        consumer: CONSUMER,
        round: LARGE_UINT,
        durableBlock: LARGE_UINT,
        error,
      });

      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]!);

      expect(record.event).toBe(event);
      expect(record.err.message).toContain('provider explanation:');
      expect(record.err.textModified).toBe(true);
      expect(record.err.code).not.toBe('SUMMARY_UNAVAILABLE');
      expect(record.err.cause).toBeDefined();
      expect(record.err.errors).toBeDefined();
      expect(record.err.cause.errors).toBeDefined();

      expect(Buffer.byteLength(JSON.stringify(record.err)))
        .toBeLessThanOrEqual(8_192);

      expect(Buffer.byteLength(lines[0]!))
        .toBeLessThanOrEqual(16_384);

      expect(lines.join('')).not.toContain(SECRET);
      expect(error.message).toBe(message);
      expect(cause.message).toBe(message);
      expect(writeSync).not.toHaveBeenCalled();
    },
  );

  it.each(['expectedHash', 'observedHash'] as const)(
    'rejects an invalid %s without exposing its value',
    (field) => {
      const { log, lines } = capture();

      const context = {
        consumer: CONSUMER as typeof CONSUMER,
        durableBlock: 900n,
        expectedHash: EXPECTED_HASH,
        observedHash: OBSERVED_HASH,
      };

      Object.defineProperty(context, field, {
        value: SECRET,
      });

      expect(() => {
        log.durableAnchorChanged(context);
      }).not.toThrow();

      expect(lines).toHaveLength(0);
      expect(writeSync).toHaveBeenCalledOnce();

      const call = vi.mocked(writeSync).mock.calls[0];

      expect(call?.[0]).toBe(2);

      const fallback = String(call?.[1]);

      expect(JSON.parse(fallback)).toMatchObject({
        event: 'logging_failed',
        code: 'LOG_RECORD_REJECTED',
        rejected: 'durable_anchor_changed',
      });

      expect(fallback).not.toContain(SECRET);
    },
  );

  it.each(UNAVAILABLE_EVENTS)(
    'rejects an error accessor without invoking it for $event',
    ({ method, event }) => {
      const { log, lines } = capture();

      const get = vi.fn(() => {
        throw new Error(SECRET);
      });

      const context = {
        consumer: CONSUMER as typeof CONSUMER,
        round: LARGE_UINT,
        durableBlock: 900n,
        error: new Error('Unused error.'),
      };

      Object.defineProperty(context, 'error', { get });

      expect(() => {
        log[method](context);
      }).not.toThrow();

      expect(get).not.toHaveBeenCalled();
      expect(lines).toHaveLength(0);
      expect(writeSync).toHaveBeenCalledOnce();

      const fallback = String(
        vi.mocked(writeSync).mock.calls[0]?.[1],
      );

      expect(JSON.parse(fallback)).toMatchObject({
        event: 'logging_failed',
        code: 'LOG_RECORD_REJECTED',
        rejected: event,
      });

      expect(fallback).not.toContain(SECRET);
  });
});