import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  InvalidInputRpcError,
  RpcRequestError,
} from 'viem';

import {
  summarizeError,
  type ErrorSummary,
  type SummarizeErrorOptions,
} from '../../src/diagnostics/error-summary.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

const SECRET = 'provider-credential-canary';
const RPC_URL = `https://rpc.example/${SECRET}`;

const options: SummarizeErrorOptions = {
  scrubText: createScrubber({
    rpcUrls: [RPC_URL],
  }),
};

function countNodes(summary: ErrorSummary): number {
  let count = 1;

  if (summary.cause !== undefined) {
    count += countNodes(summary.cause);
  }

  for (const child of summary.errors ?? []) {
    count += countNodes(child);
  }

  return count;
}

describe('summarizeError standard mode', () => {
  it.each([
    [-32000, 'historical state is not available'],
    [-32029, 'public rate limit exceeded'],
  ] as const)(
    'preserves provider evidence for code %i',
    (code, detail) => {
      const rpcError = new RpcRequestError({
        body: { method: 'eth_getLogs' },
        error: {
          code,
          message: `${detail}; token=${SECRET}`,
        },
        url: RPC_URL,
      });

      let error: Error = rpcError;

      if (code === -32000) {
        error = new InvalidInputRpcError(rpcError);
      }

      const before = error.message;
      const summary = summarizeError(error, options);

      expect(summary.message)
        .toBe(`${detail}; token=[REDACTED]`);
      expect(summary.code).toBe(code);
      expect(summary.textModified).toBe(true);
      expect(summary.cause?.message).toBe(summary.message);

      if (code === -32000) {
        expect(summary.name).toBe('InvalidInputRpcError');
        expect(summary.cause?.cause?.message)
          .toBe(summary.message);
      }

      expect(JSON.stringify(summary)).not.toContain(SECRET);
      expect(summary).not.toHaveProperty('url');
      expect(summary).not.toHaveProperty('body');
      expect(summary).not.toHaveProperty('stack');
      expect(error.message).toBe(before);
    },
  );

  it.each([
    {
      details: 'provider explanation',
      shortMessage: 'wrapper',
    },
    {
      details: '',
      shortMessage: 'provider explanation',
    },
    {
      details: '',
      shortMessage: '',
      message: 'provider explanation',
    },
  ])('selects the most specific available text: %#', (fields) => {
    const summary = summarizeError({
      message: 'composite request body and metadata',
      ...fields,
    }, options);

    expect(summary.message).toBe('provider explanation');
  });

  it('preserves a registry mismatch explanation', () => {
    const message =
      'Consumer registry 0x692100c4863adAED9f560F6Ce982cF878F083e93 ' +
      'differs from configured registry ' +
      '0x25CA96ff9CAC264b801e5a0E06a9545360494A7E.';

    expect(summarizeError(new Error(message), options)).toEqual({
      name: 'Error',
      message,
    });
  });

  it('scrubs unfamiliar names and codes in aggregate members', () => {
    const error = new AggregateError([{
      name: `ProviderError-${SECRET}`,
      code: `PROVIDER_${SECRET}`,
      message: `request rejected: ${SECRET}`,
    }], `batch failed: ${SECRET}`);

    const summary = summarizeError(error, options);

    expect(summary.errors).toEqual([{
      name: 'ProviderError-[REDACTED]',
      code: 'PROVIDER_[REDACTED]',
      message: 'request rejected: [REDACTED]',
      textModified: true,
    }]);

    expect(summary.message).toBe('batch failed: [REDACTED]');
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('does not invoke getters for external text or metadata', () => {
    const access = vi.fn(() => {
      throw new Error(SECRET);
    });

    const error = Object.create(null);

    for (const key of [
      'name',
      'code',
      'details',
      'shortMessage',
      'message',
      'cause',
      'status',
      'stack',
      'toJSON',
    ]) {
      Object.defineProperty(error, key, {
        get: access,
      });
    }

    expect(summarizeError(error, options)).toEqual({
      name: 'UnknownError',
      message: 'Operation failed; details redacted.',
    });

    expect(access).not.toHaveBeenCalled();
  });

  it('retains traversal limits and bounds selected text', () => {
    function tree(depth: number): Error {
      if (depth === 0) {
        return new Error(SECRET);
      }

      return new AggregateError(
        Array.from({ length: 5 }, () => tree(depth - 1)),
        'x'.repeat(5_000) + SECRET,
        { cause: tree(depth - 1) },
      );
    }

    const summary = summarizeError(tree(3), options);

    expect(countNodes(summary)).toBe(12);
    expect(summary.message).toHaveLength(4_096);
    expect(summary.errorsOmitted).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('never falls back to raw text when the scrubber throws', () => {
    const summary = summarizeError(new Error(SECRET), {
      scrubText() {
        throw new Error(SECRET);
      },
    });

    expect(summary.message).toBe('[diagnostic text unavailable]');
    expect(summary.textModified).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('keeps strict behavior as the default', () => {
    const error = new Error('provider explanation');
    const expected = {
      name: 'Error',
      message: 'Operation failed; details redacted.',
    };

    expect(summarizeError(error)).toEqual(expected);
    expect(summarizeError(error, undefined))
      .toEqual(expected);
  });

  it('scrubs thrown strings', () => {
    expect(
      summarizeError(`request failed: ${SECRET}`, options),
    ).toEqual({
      name: 'UnknownError',
      message: 'request failed: [REDACTED]',
      textModified: true,
    });
  });
});