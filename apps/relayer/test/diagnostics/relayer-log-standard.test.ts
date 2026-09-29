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
} from '../../src/diagnostics/relayer-log.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeSync: vi.fn(),
}));

const SECRET = 'logger-policy-canary';
const CONSUMER = '0x1111111111111111111111111111111111111111';

// Exercise policy injection; the full scrubber has its own suite.
function scrubText(text: string) {
  return {
    text: text.replaceAll(SECRET, '[REDACTED]'),
    removed: text.includes(SECRET),
  };
}

function capture() {
  const lines: string[] = [];
  const policy = {
    scrubText,
  };

  const log = createRelayerLog({
    chainId: 4663,
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

  it.each(['😀', '"\\\n'])(
    'fits large summaries without discarding their tree: %j',
    (fragment) => {
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
      expect(record.err.cause).toBeDefined();
      expect(record.err.cause.errors).toBeDefined();

      expect(Buffer.byteLength(JSON.stringify(record.err)))
        .toBeLessThanOrEqual(8_192);
      expect(Buffer.byteLength(lines[0]!))
        .toBeLessThanOrEqual(16_384);

      expect(lines.join('')).not.toContain(SECRET);
      expect(error.message).toBe(message);
      expect(writeSync).not.toHaveBeenCalled();
    },
  );
});