import { describe, expect, it, vi } from 'vitest';

import {
  ContractFunctionRevertedError,
  encodeErrorResult,
  parseAbi,
} from 'viem';

import {
  summarizeError,
} from '../../src/diagnostics/error-summary.js';

import {
  summarizeErrorForOutput,
} from '../../src/diagnostics/error-output.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

const SECRET = 'revert-secret-canary';

const options = {
  scrubText: createScrubber({
    rpcUrls: [],
    secrets: [SECRET],
  }),
};

function revertError(
  args: unknown,
  reason?: string,
) {
  return {
    name: 'ContractFunctionRevertedError',
    message: 'Contract execution reverted.',
    reason,
    data: {
      errorName: 'RejectedRound',
      args,
    },
  };
}

describe('decoded revert diagnostics', () => {
  it('preserves a real decoded custom error through a cause', () => {
    const abi = parseAbi([
      'function submitBeacon(uint64 round, bytes signature)',
      'error RejectedRound(uint64 round, string explanation)',
    ]);

    const data = encodeErrorResult({
      abi,
      errorName: 'RejectedRound',
      args: [32607411n, SECRET],
    });

    const cause = new ContractFunctionRevertedError({
      abi,
      data,
      functionName: 'submitBeacon',
    });

    const summary = summarizeError(
      new Error('Submission failed.', { cause }),
      options,
    );

    expect(summary.cause?.revert).toEqual({
      name: 'RejectedRound',
      args: ['32607411', '[REDACTED]'],
    });

    expect(summary.cause?.textModified).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('scrubs decoded names, reasons, and string arguments', () => {
    const error = revertError([SECRET], `rejected: ${SECRET}`);
    error.data.errorName = `Rejected-${SECRET}`;

    const summary = summarizeError(error, options);

    expect(summary.revert).toEqual({
      name: 'Rejected-[REDACTED]',
      reason: 'rejected: [REDACTED]',
      args: ['[REDACTED]'],
    });

    expect(summary.textModified).toBe(true);
  });

  it('preserves empty strings and scalar values', () => {
    const summary = summarizeError(
      revertError(['', 42, false, null]),
      options,
    );

    expect(summary.revert).toEqual({
      name: 'RejectedRound',
      args: ['', 42, false, null],
    });
  });

  it('bounds arguments without invoking getters or coercion', () => {
    const accessed = vi.fn(() => {
      throw new Error('Must not execute.');
    });

    const args: unknown[] = [
      { toString: accessed, toJSON: accessed },
      [],
      SECRET,
      4,
      'beyond the limit',
    ];

    Object.defineProperty(args, '1', {
      get: accessed,
    });

    const error = revertError(args);

    Object.defineProperty(error, 'reason', {
      get: accessed,
    });

    const summary = summarizeError(error, options);

    expect(summary.revert).toEqual({
      name: 'RejectedRound',
      args: ['[omitted]', '[omitted]', '[REDACTED]', 4],
      argsOmitted: true,
    });

    expect(accessed).not.toHaveBeenCalled();
  });

  it('omits unsupported numbers and oversized integers', () => {
    const summary = summarizeError(
      revertError([
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        1n << 4096n,
      ]),
      options,
    );

    expect(summary.revert).toEqual({
      name: 'RejectedRound',
      args: Array(4).fill('[omitted]'),
      argsOmitted: true,
    });
  });

  it('handles a revoked argument-array proxy', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();

    const summary = summarizeError(
      revertError(proxy),
      options,
    );

    expect(summary.revert).toEqual({
      name: 'RejectedRound',
      argsOmitted: true,
    });
  });

  it('omits external revert details without a configured scrubber', () => {
    const summary = summarizeError(
      revertError([SECRET], SECRET),
    );

    expect(summary.revert).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('never exposes raw fields when scrubbing throws', () => {
    const summary = summarizeError(
      revertError([SECRET], SECRET),
      {
        scrubText() {
          throw new Error(SECRET);
        },
      },
    );

    expect(summary.revert).toEqual({
      name: '[diagnostic text unavailable]',
      reason: '[diagnostic text unavailable]',
      args: ['[diagnostic text unavailable]'],
    });

    expect(summary.textModified).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('includes revert fields in the serialized output budget', () => {
    const longText = '😀'.repeat(2_000) + SECRET;

    function makeChain(depth: number): object {
      return {
        ...revertError(Array(4).fill(longText), longText),
        message: longText,
        data: {
          errorName: longText,
          args: Array(4).fill(longText),
        },
        ...(depth > 0
          ? { cause: makeChain(depth - 1) }
          : {}),
      };
    }

    const error = new AggregateError(
      Array.from({ length: 4 }, () => makeChain(2)),
      longText,
    );

    const summary = summarizeErrorForOutput(error, options);
    const serialized = JSON.stringify(summary);

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8_192);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[truncated]');
    expect(summary.errors?.[0]?.revert?.args).toHaveLength(4);
  });
});