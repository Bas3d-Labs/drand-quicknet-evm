import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  RpcRequestError,
} from 'viem';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

import {
  RelayerConfigError,
} from '../../src/diagnostics/config-errors.js';

import {
  UsageError,
} from '../../src/diagnostics/usage-error.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import type {
  SummarizeErrorOptions,
} from '../../src/diagnostics/error-summary.js';

const SECRET = 'cli-diagnostic-canary';
const CONSUMER = '0x1111111111111111111111111111111111111111';

// Test policy handoff. Secret recognition has its own scrubber suite.
const standard: SummarizeErrorOptions = {
  scrubText(text) {
    return {
      text: text.replaceAll(SECRET, '[REDACTED]'),
      removed: text.includes(SECRET),
    };
  },
};

describe('renderDiagnostic', () => {
  it('remains strict when no policy is supplied', () => {
    const line = renderDiagnostic(new Error(SECRET));

    expect(JSON.parse(line)).toEqual({
      event: 'cli_failed',
      kind: 'operation',
      err: {
        name: 'Error',
        message: 'Operation failed; details redacted.',
      },
    });
  });

  it('preserves scrubbed provider evidence in standard mode', () => {
    const error = new RpcRequestError({
      body: { method: 'eth_chainId' },
      url: `https://rpc.example/${SECRET}`,
      error: {
        code: -32029,
        message: `public rate limit exceeded; token=${SECRET}`,
      },
    });

    const line = renderDiagnostic(error, standard);
    const record = JSON.parse(line);

    expect(record).toMatchObject({
      event: 'cli_failed',
      kind: 'operation',
      err: {
        name: 'RpcRequestError',
        code: -32029,
        message: 'public rate limit exceeded; token=[REDACTED]',
        cause: {
          code: -32029,
          message: 'public rate limit exceeded; token=[REDACTED]',
        },
      },
    });

    expect(line).not.toContain(SECRET);
    expect(record.err).not.toHaveProperty('url');
    expect(record.err).not.toHaveProperty('body');
  });

  it('preserves the outer explanation and nested timeout', () => {
    const timeout = {
      name: 'TimeoutError',
      details: 'The request timed out.',
    };

    const transaction = {
      name: 'TransactionExecutionError',
      details: 'The request timed out.',
      cause: timeout,
    };

    const contract = {
      name: 'ContractFunctionExecutionError',
      details: 'The request timed out.',
      cause: transaction,
      metaMessages: [`Request body: ${SECRET}`],
    };

    const message =
      'Submissions blocked; inspect signer state before restarting.';

    const error = new Error(message, { cause: contract });
    const line = renderDiagnostic(error, standard);
    const summary = JSON.parse(line).err;

    expect(summary.message).toBe(message);
    expect(summary.cause.message).toBe('The request timed out.');
    expect(summary.cause.cause.message).toBe('The request timed out.');

    expect(summary.cause.cause.cause).toMatchObject({
      name: 'TimeoutError',
      message: 'The request timed out.',
    });

    expect(line).not.toContain(SECRET);
    expect(summary.cause).not.toHaveProperty('metaMessages');
  });

  it.each(['usage', 'configuration'] as const)(
    'keeps %s catalog output independent of the text policy',
    (kind) => {
      let error: Error;

      if (kind === 'usage') {
        error = new UsageError('UNKNOWN_COMMAND');
      } else {
        error = new RelayerConfigError(
          'INVALID_RPC_URL',
          'QUICKNET_RPC_URL',
        );
      }

      error.message = SECRET;
      error.cause = new Error(SECRET);

      const scrubText = vi.fn(() => {
        throw new Error(SECRET);
      });

      const line = renderDiagnostic(error, {
        scrubText,
      });

      expect(line).toBe(renderDiagnostic(error));
      expect(JSON.parse(line).kind).toBe(kind);
      expect(line).not.toContain(SECRET);
      expect(scrubText).not.toHaveBeenCalled();
    },
  );

  it.each(['😀', '"\\\n'])(
    'shares bounded output with the typed logger: %j',
    (fragment) => {
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
      const line = renderDiagnostic(error, standard);
      const summary = JSON.parse(line).err;

      expect(Buffer.byteLength(line + '\n'))
        .toBeLessThanOrEqual(32_768);

      expect(Buffer.byteLength(JSON.stringify(summary)))
        .toBeLessThanOrEqual(8_192);

      expect(summary.message).toContain('provider explanation:');
      expect(summary.message).toContain('[truncated]');
      expect(summary.cause).toBeDefined();
      expect(summary.textModified).toBe(true);
      expect(line).not.toContain(SECRET);
      expect(error.message).toBe(message);

      const lines: string[] = [];

      const log = createRelayerLog({
        chainId: 4663,
        errorSummary: standard,
        destination: {
          write(value) {
            lines.push(value);
          },
        },
      });

      log.consumerFailed({
        consumer: CONSUMER,
        error,
      });

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).err).toEqual(summary);
    },
  );

  it('does not expose raw text when the scrubber fails', () => {
    const line = renderDiagnostic(new Error(SECRET), {
      scrubText() {
        throw new Error(SECRET);
      },
    });

    expect(JSON.parse(line).err.message)
      .toBe('[diagnostic text unavailable]');

    expect(line).not.toContain(SECRET);
  });
});