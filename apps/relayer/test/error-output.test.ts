import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  HttpRequestError,
  NonceTooLowError,
  RpcRequestError,
  TransactionExecutionError,
} from 'viem';

import {
  reportCliError,
} from '../src/cli.js';

import type {
  RunDaemonCycleResult,
} from '../src/daemon-cycle.js';

import {
  createDaemonLogger,
} from '../src/daemon-logging.js';

import type {
  ErrorSummary,
} from '../src/error-summary.js';

import {
  createRelayerLog,
  type RelayerLog,
} from '../src/relayer-log.js';

const CHAIN_ID = 4663;
const SECRET = 'credential-canary-DO-NOT-LOG';

const RPC_URL =
  `https://user:${SECRET}@rpc.example/${SECRET}?key=${SECRET}`;

const CONSUMER =
  '0x1111111111111111111111111111111111111111';

const REGISTRY =
  '0x2222222222222222222222222222222222222222';

function httpError(): HttpRequestError {
  return new HttpRequestError({
    url: RPC_URL,
    status: 401,
    headers: new Headers({
      authorization: `Bearer ${SECRET}`,
    }),
    body: {
      method: 'eth_call',
      params: [SECRET],
    },
    details: `Authorization: Basic ${SECRET}`,
    cause: new Error(
      `Encoded endpoint: ${encodeURIComponent(RPC_URL)}`,
    ),
  });
}

function nonceError(): TransactionExecutionError {
  const rpc = new RpcRequestError({
    url: RPC_URL,
    body: {
      method: 'eth_sendRawTransaction',
      params: [SECRET],
    },
    error: {
      code: -32000,
      message: `nonce too low: ${SECRET}`,
    },
  });

  return new TransactionExecutionError(
    new NonceTooLowError({
      cause: rpc,
      nonce: 7,
    }),
    {
      account: null,
    },
  );
}

function captureLogger() {
  const lines: string[] = [];

  const logger = createRelayerLog({
    chainId: CHAIN_ID,
    level: 'debug',
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  return { logger, lines };
}

function failedCycle(
  error: unknown,
): RunDaemonCycleResult {
  return {
    consumers: [
      {
        status: 'failed',
        consumer: {
          address: CONSUMER,
          registry: REGISTRY,
        },
        error,
      },
    ],
  };
}

function assertSafeOutput(
  output: string,
): void {
  expect(output).not.toContain(SECRET);
  expect(output).not.toContain(RPC_URL);
  expect(output).not.toContain(encodeURIComponent(RPC_URL));
  expect(output).not.toContain('rpc.example');
  expect(output.toLowerCase()).not.toContain('authorization');
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
  assertSafeOutput(line);

  return JSON.parse(line) as Record<string, unknown>;
}

function captureCliError(
  error: unknown,
): ErrorSummary {
  const stderr = vi.spyOn(console, 'error').mockImplementation(
    () => {},
  );

  reportCliError(error);

  expect(stderr).toHaveBeenCalledOnce();

  const call = stderr.mock.calls[0];

  if (call === undefined) {
    throw new Error('Expected CLI error output.');
  }

  expect(call).toHaveLength(1);

  const output = call[0];

  if (typeof output !== 'string') {
    throw new Error('Expected a rendered CLI diagnostic.');
  }

  assertSafeOutput(output);
  expect(process.exitCode).toBe(1);

  const diagnostic = JSON.parse(output) as {
    event: string;
    kind: string;
    err: ErrorSummary;
  };

  expect(diagnostic).toEqual({
    event: 'cli_failed',
    kind: 'operation',
    err: expect.any(Object),
  });

  return diagnostic.err;
}

describe('error output boundaries', () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  it('emits safe daemon output without modifying the original viem error', () => {
    const { logger, lines } = captureLogger();

    const error = httpError();
    const originalMessage = error.message;

    const daemonLogger = createDaemonLogger({
      logger,
      now: () => 0,
    });

    daemonLogger.onCycle(failedCycle(error));

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
        status: 401,
        cause: {
          name: 'Error',
          message: 'Operation failed; details redacted.',
        },
      },
    });

    expect(error.message).toBe(originalMessage);
    expect(error.url).toBe(RPC_URL);

    expect(
      error.headers?.get('authorization'),
    ).toBe(`Bearer ${SECRET}`);
  });

  it('retains nonce labels and numeric RPC codes in emitted output', () => {
    const { logger, lines } = captureLogger();

    createDaemonLogger({
      logger,
      now: () => 0,
    }).onCycle(failedCycle(nonceError()));

    expect(lines).toHaveLength(1);

    const record = recordAt(lines);
    const summary = record.err as ErrorSummary;

    expect(record.event).toBe('consumer_failed');
    expect(summary.name).toBe('TransactionExecutionError');
    expect(summary.cause?.name).toBe('NonceTooLowError');
    expect(summary.cause?.cause?.code).toBe(-32000);
  });

  it.each<unknown>([
    SECRET,
    null,
    undefined,
    {
      name: SECRET,
      message: SECRET,
      code: SECRET,
      status: SECRET,
    },
    {
      toString: () => SECRET,
      toJSON: () => ({ secret: SECRET }),
    },
  ])(
    'emits safe daemon output for an arbitrary thrown value: %#',
    (error) => {
      const { logger, lines } = captureLogger();

      createDaemonLogger({
        logger,
        now: () => 0,
      }).onCycle(failedCycle(error));

      expect(lines).toHaveLength(1);

      expect(recordAt(lines)).toMatchObject({
        event: 'consumer_failed',
        consumer: CONSUMER,
        err: {
          name: 'UnknownError',
          message: 'Operation failed; details redacted.',
        },
      });
    },
  );

  it('does not invoke error coercion or serialization hooks during logging', () => {
    const { logger, lines } = captureLogger();

    const toJSON = vi.fn(() => {
      throw new Error(SECRET);
    });

    const toString = vi.fn(() => {
      throw new Error(SECRET);
    });

    const toPrimitive = vi.fn(() => {
      throw new Error(SECRET);
    });

    const error = {
      toJSON,
      toString,
      [Symbol.toPrimitive]: toPrimitive,
    };

    createDaemonLogger({
      logger,
      now: () => 0,
    }).onCycle(failedCycle(error));

    expect(lines).toHaveLength(1);

    expect(recordAt(lines).err).toEqual({
      name: 'UnknownError',
      message: 'Operation failed; details redacted.',
    });

    expect(toJSON).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(toPrimitive).not.toHaveBeenCalled();
  });

  it('emits a safe record when error reflection fails', () => {
    const { logger, lines } = captureLogger();

    const get = vi.fn(() => {
      throw new Error(SECRET);
    });

    const getOwnPropertyDescriptor = vi.fn(() => {
      throw new Error(SECRET);
    });

    const error = new Proxy({}, {
      get,
      getOwnPropertyDescriptor,
    });

    const daemonLogger = createDaemonLogger({
      logger,
      now: () => 0,
    });

    expect(() => {
      daemonLogger.onCycle(failedCycle(error));
    }).not.toThrow();

    expect(lines).toHaveLength(1);

    expect(recordAt(lines).err).toEqual({
      name: 'UnknownError',
      message: 'Operation failed; details redacted.',
    });

    expect(get).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptor).toHaveBeenCalled();
  });

  it('emits bounded summaries for cyclic and deeply nested errors', () => {
    const { logger, lines } = captureLogger();

    const daemonLogger = createDaemonLogger({
      logger,
      now: () => 0,
    });

    const cycle = new Error(SECRET);
    cycle.cause = cycle;

    let deep = new Error(SECRET);

    for (let index = 0; index < 100; index += 1) {
      deep = new Error(SECRET, {
        cause: deep,
      });
    }

    daemonLogger.onCycle(failedCycle(cycle));
    daemonLogger.onCycle(failedCycle(deep));

    expect(lines).toHaveLength(2);

    const cyclicSummary = recordAt(lines, 0).err as ErrorSummary;
    const deepSummary = recordAt(lines, 1).err as ErrorSummary;

    expect(cyclicSummary.causeOmitted).toBe(true);
    expect(cyclicSummary.cause).toBeUndefined();

    expect(
      deepSummary.cause?.cause?.cause?.causeOmitted,
    ).toBe(true);

    expect(
      deepSummary.cause?.cause?.cause?.cause,
    ).toBeUndefined();

    for (const line of lines) {
      expect(
        Buffer.byteLength(line, 'utf8'),
      ).toBeLessThanOrEqual(16_384);
    }
  });

  it('emits aggregate member summaries without raw provider fields', () => {
    const { logger, lines } = captureLogger();

    const error = new AggregateError(
      [httpError()],
      SECRET,
    );

    createDaemonLogger({
      logger,
      now: () => 0,
    }).onCycle(failedCycle(error));

    expect(lines).toHaveLength(1);

    expect(recordAt(lines).err).toEqual({
      name: 'AggregateError',
      message: 'Multiple operations failed.',
      errors: [
        {
          name: 'HttpRequestError',
          message: 'HTTP request failed.',
          status: 401,
          cause: {
            name: 'Error',
            message: 'Operation failed; details redacted.',
          },
        },
      ],
    });
  });

  it('emits safe logging_failed output for an injected logger failure', () => {
    const { logger, lines } = captureLogger();

    const failure = httpError();

    // The real logger is frozen. Override one method on a test wrapper.
    const injectedLogger: RelayerLog = {
      ...logger,
      consumerFailed() {
        throw failure;
      },
    };

    const daemonLogger = createDaemonLogger({
      logger: injectedLogger,
      now: () => 0,
    });

    expect(() => {
      daemonLogger.onCycle(
        failedCycle(new Error(SECRET)),
      );
    }).not.toThrow();

    expect(lines).toHaveLength(1);

    expect(recordAt(lines)).toMatchObject({
      level: 50,
      event: 'logging_failed',
      msg: 'Daemon logging failed',
      err: {
        name: 'HttpRequestError',
        message: 'HTTP request failed.',
        status: 401,
        cause: {
          name: 'Error',
          message: 'Operation failed; details redacted.',
        },
      },
    });
  });

  it('renders safe CLI stderr and sets the failure exit code', () => {
    const error = httpError();
    const originalMessage = error.message;

    const summary = captureCliError(error);

    expect(summary).toEqual({
      name: 'HttpRequestError',
      message: 'HTTP request failed.',
      status: 401,
      cause: {
        name: 'Error',
        message: 'Operation failed; details redacted.',
      },
    });

    expect(error.message).toBe(originalMessage);
    expect(error.url).toBe(RPC_URL);
  });

  it('retains nonce labels and numeric RPC codes in CLI output', () => {
    const summary = captureCliError(nonceError());

    expect(summary.name).toBe('TransactionExecutionError');
    expect(summary.cause?.name).toBe('NonceTooLowError');
    expect(summary.cause?.cause?.code).toBe(-32000);
  });

  it.each<unknown>([
    SECRET,
    null,
    undefined,
    {
      name: SECRET,
      message: SECRET,
      code: SECRET,
      status: SECRET,
    },
  ])(
    'renders safe CLI output for an arbitrary thrown value: %#',
    (error) => {
      expect(captureCliError(error)).toEqual({
        name: 'UnknownError',
        message: 'Operation failed; details redacted.',
      });
    },
  );

  it('does not pass application error messages through CLI output', () => {
    const message =
      'Missing required environment variable: PRIVATE_KEY.';

    expect(
      captureCliError(new Error(message)),
    ).toEqual({
      name: 'Error',
      message: 'Operation failed; details redacted.',
    });
  });

  it('does not invoke serialization hooks while rendering CLI errors', () => {
    const access = vi.fn(() => {
      throw new Error(SECRET);
    });

    const error = {
      toJSON: access,
      toString: access,
      [Symbol.toPrimitive]: access,
    };

    expect(captureCliError(error)).toEqual({
      name: 'UnknownError',
      message: 'Operation failed; details redacted.',
    });

    expect(access).not.toHaveBeenCalled();
  });
});