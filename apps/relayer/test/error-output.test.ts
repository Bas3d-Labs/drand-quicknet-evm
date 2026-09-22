import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HttpRequestError,
  NonceTooLowError,
  RpcRequestError,
  TransactionExecutionError,
} from 'viem';

import { summarizeError } from '../src/error-summary.js';
import { createLogger } from '../src/logger.js';
import { createDaemonLogger } from '../src/daemon-logging.js';
import { reportCliError } from '../src/cli.js';
import type { RunDaemonCycleResult } from '../src/daemon-cycle.js';

const SECRET = 'credential-canary-DO-NOT-LOG';
const RPC_URL = `https://user:${SECRET}@rpc.example/${SECRET}?key=${SECRET}`;
const CONSUMER = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';

function httpError(): HttpRequestError {
  return new HttpRequestError({
    url: RPC_URL,
    status: 401,
    headers: new Headers({ authorization: `Bearer ${SECRET}` }),
    body: { method: 'eth_call', params: [SECRET] },
    details: `Authorization: Basic ${SECRET}`,
    cause: new Error(`Encoded endpoint: ${encodeURIComponent(RPC_URL)}`),
  });
}

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    destination: { write: (line: string) => { lines.push(line); } },
  });
  return { logger, lines };
}

function failedCycle(error: unknown): RunDaemonCycleResult {
  return {
    consumers: [{
      status: 'failed' as const,
      consumer: { address: CONSUMER, registry: REGISTRY },
      error,
    }],
  };
}

describe('error output boundaries', () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  it('omits raw viem fields without modifying the original error', () => {
    const error = httpError();
    const originalMessage = error.message;
    const summary = summarizeError(error);

    expect(summary).toEqual({
      name: 'HttpRequestError',
      message: 'HTTP request failed.',
      status: 401,
      cause: {
        name: 'Error',
        message: 'Operation failed; details redacted.',
      },
    });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(error.message).toBe(originalMessage);
    expect(error.url).toBe(RPC_URL);
    expect(error.headers?.get('authorization')).toContain(SECRET);
  });

  it('retains nonce classification and numeric RPC codes through wrappers', () => {
    const rpc = new RpcRequestError({
      url: RPC_URL,
      body: { method: 'eth_sendRawTransaction', params: [SECRET] },
      error: { code: -32000, message: `nonce too low: ${SECRET}` },
    });
    const error = new TransactionExecutionError(
      new NonceTooLowError({ cause: rpc, nonce: 7 }),
      { account: null },
    );
    const summary = summarizeError(error);

    expect(summary.name).toBe('TransactionExecutionError');
    expect(summary.cause?.name).toBe('NonceTooLowError');
    expect(summary.cause?.cause?.code).toBe(-32000);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it.each<unknown>([
    SECRET,
    null,
    undefined,
    { 
      name: SECRET,
      message: SECRET,
      code: SECRET,
      status: SECRET
    },
    {
      toString: () => SECRET,
      toJSON: () => ({ secret: SECRET })
    },
  ])('handles arbitrary thrown values without serializing them: %#', (error) => {
    expect(summarizeError(error)).toEqual({
      name: 'UnknownError',
      message: 'Operation failed; details redacted.',
    });
  });

  it('does not invoke coercion or serialization hooks', () => {
    const toJSON = vi.fn(() => { throw new Error(SECRET); });
    const toString = vi.fn(() => { throw new Error(SECRET); });
    const value = { toJSON, toString };

    expect(JSON.stringify(summarizeError(value))).not.toContain(SECRET);
    expect(toJSON).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it('survives property access failures', () => {
    const error = new Proxy({}, {
      get() { throw new Error(SECRET); },
    });
    expect(() => summarizeError(error)).not.toThrow();
    expect(JSON.stringify(summarizeError(error))).not.toContain(SECRET);
  });

  it('bounds cyclic and excessively deep causes', () => {
    const cycle = new Error(SECRET);
    cycle.cause = cycle;
    expect(summarizeError(cycle).causeOmitted).toBe(true);

    let deep = new Error(SECRET);
    for (let i = 0; i < 100; i += 1) {
      deep = new Error(SECRET, { cause: deep });
    }
    const summary = summarizeError(deep);
    expect(summary.cause?.cause?.cause?.causeOmitted).toBe(true);
    expect(summary.cause?.cause?.cause?.cause).toBeUndefined();
    expect(summarizeError(summary)).toEqual(summary);
  });

  it('omits application messages from generic summaries', () => {
    const message =
      'Missing required environment variable: PRIVATE_KEY.';

    expect(summarizeError(new Error(message)).message)
      .toBe('Operation failed; details redacted.');

    expect(summarizeError(new Error(`${message} ${SECRET}`)).message)
      .toBe('Operation failed; details redacted.');
  });

  it.each(['bare', 'err', 'error', 'explicit'] as const)(
    'captures safe real Pino output for %s errors on a child logger',
    (form) => {
      const { logger, lines } = captureLogger();
      const child = logger.child({ component: 'daemon' });
      const error = httpError();

      if (form === 'bare') {
        child.error(error);
      } else if (form === 'err') {
        child.error({ err: error });
      } else if (form === 'error') {
        child.error({ error });
      } else {
        child.error({ err: error }, 'Consumer processing failed');
      }

      expect(lines).toHaveLength(1);
      const output = lines.join('');
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain('rpc.example');
      expect(output).not.toContain('authorization');
      const record = JSON.parse(output);
      expect(record.err ?? record.error).toMatchObject({
        name: 'HttpRequestError', status: 401,
      });
      expect(record.component).toBe('daemon');
    },
  );

  it('captures safe consumer_failed output from the daemon', () => {
    const { logger, lines } = captureLogger();
    createDaemonLogger({ logger }).onCycle(failedCycle(httpError()));

    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain(SECRET);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'consumer_failed', consumer: CONSUMER,
      err: { name: 'HttpRequestError', status: 401 },
    });
  });

  it('captures safe logging_failed output when a logger throws', () => {
    const { logger, lines } = captureLogger();
    vi.spyOn(logger, 'error').mockImplementationOnce(() => {
      throw httpError();
    });
    createDaemonLogger({ logger }).onCycle(failedCycle(new Error(SECRET)));

    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain(SECRET);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'logging_failed',
      err: { name: 'HttpRequestError', status: 401 },
    });
  });

  it('captures safe CLI stderr and preserves the failure exit code', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportCliError(httpError());

    expect(stderr).toHaveBeenCalledOnce();
    
    const output = String(stderr.mock.calls[0]?.[0]);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('rpc.example');
    expect(output).toContain('HttpRequestError');
    expect(output).toContain('401');
    expect(process.exitCode).toBe(1);
  });

  it('summarizes aggregate members without exposing raw errors', () => {
    const error = new AggregateError([httpError()], SECRET);
    const summary = summarizeError(error);

    expect(summary).toEqual({
      name: 'AggregateError',
      message: 'Multiple operations failed.',
      errors: [{
        name: 'HttpRequestError',
        message: 'HTTP request failed.',
        status: 401,
        cause: {
          name: 'Error',
          message: 'Operation failed; details redacted.',
        },
      }],
    });

    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(JSON.stringify(summary)).not.toContain('rpc.example');
  });
});