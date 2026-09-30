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
      let wrapperMessage: string | undefined;

      if (code === -32000) {
        const wrapper = new InvalidInputRpcError(rpcError);
        error = wrapper;
        wrapperMessage = options.scrubText(wrapper.shortMessage).text;
      }

      const before = error.message;
      const summary = summarizeError(error, options);

      expect(summary.code).toBe(code);

      let providerSummary = summary;

      if (wrapperMessage !== undefined) {
        expect(summary.name).toBe('InvalidInputRpcError');
        expect(summary.message).toBe(wrapperMessage);

        if (summary.cause === undefined) {
          throw new Error('Expected the provider cause.');
        }

        providerSummary = summary.cause;
      }

      expect(providerSummary.message)
        .toBe(`${detail}; token=[REDACTED]`);
      expect(providerSummary.textModified).toBe(true);
      expect(providerSummary.cause?.message)
        .toBe(providerSummary.message);

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

  it('preserves distinct wrapper messages in the timeout chain', () => {
    const details = `The request timed out; token=${SECRET}`;

    const timeout = {
      name: 'TimeoutError',
      details,
      shortMessage: 'The request took too long to respond.',
    };

    const transaction = {
      name: 'TransactionExecutionError',
      details,
      shortMessage: 'Transaction submission failed.',
      cause: timeout,
    };

    const contract = {
      name: 'ContractFunctionExecutionError',
      details,
      shortMessage: 'The submitBeacon contract call failed.',
      cause: transaction,
    };

    const summary = summarizeError(contract, options);

    expect(summary).toMatchObject({
      name: 'ContractFunctionExecutionError',
      message: 'The submitBeacon contract call failed.',
      cause: {
        name: 'TransactionExecutionError',
        message: 'Transaction submission failed.',
        cause: {
          name: 'TimeoutError',
          message: 'The request timed out; token=[REDACTED]',
          textModified: true,
        },
      },
    });

    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('compares identical details before scrubbing', () => {
    const details = `Provider rejected credential ${SECRET}`;

    const summary = summarizeError({
      details,
      shortMessage: 'Contract submission failed.',
      cause: {
        details,
      },
    }, options);

    expect(summary.message).toBe('Contract submission failed.');
    expect(summary.cause?.message)
      .toBe('Provider rejected credential [REDACTED]');
  });

  it('does not treat different details as equal after scrubbing', () => {
    const first = 'first-provider-credential';
    const second = 'second-provider-credential';

    const summary = summarizeError({
      details: `Rejected ${first}`,
      shortMessage: 'Wrapper explanation.',
      cause: {
        details: `Rejected ${second}`,
      },
    }, {
      scrubText: createScrubber({
        rpcUrls: [],
        secrets: [first, second],
      }),
    });

    // The raw details differ even though their scrubbed forms are identical.
    expect(summary.message).toBe('Rejected [REDACTED]');
    expect(summary.cause?.message).toBe('Rejected [REDACTED]');
  });

  it.each([undefined, ''])(
    'retains duplicated details without a useful shortMessage: %j',
    (shortMessage) => {
      const summary = summarizeError({
        details: 'Provider unavailable.',
        shortMessage,
        message: 'Composite message with request metadata.',
        cause: {
          details: 'Provider unavailable.',
        },
      }, options);

      expect(summary.message).toBe('Provider unavailable.');
    },
  );

  it('does not invoke a cause details accessor during comparison', () => {
    const get = vi.fn(() => {
      throw new Error(SECRET);
    });

    const cause = Object.defineProperty(
      { message: 'Cause explanation.' },
      'details',
      { get },
    );

    const summary = summarizeError({
      details: 'Node-specific details.',
      shortMessage: 'Wrapper explanation.',
      cause,
    }, options);

    expect(get).not.toHaveBeenCalled();
    expect(summary.message).toBe('Node-specific details.');
    expect(summary.cause?.message).toBe('Cause explanation.');
  });

  it('compares inherited data properties on the cause', () => {
    const cause = Object.create({
      details: 'Provider unavailable.',
    });

    const summary = summarizeError({
      details: 'Provider unavailable.',
      shortMessage: 'Contract submission failed.',
      cause,
    }, options);

    expect(summary.message).toBe('Contract submission failed.');
    expect(summary.cause?.message).toBe('Provider unavailable.');
  });
});