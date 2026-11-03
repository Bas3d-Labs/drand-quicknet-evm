import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  registerAnchoredReadFailure,
} from '../../src/diagnostics/anchored-read-errors.js';

import {
  summarizeErrorForOutput,
} from '../../src/diagnostics/error-output.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

const HASH = `0x${'aa'.repeat(32)}`;

function register(error: unknown): void {
  registerAnchoredReadFailure(error, {
    method: 'eth_getTransactionCount',
    blockNumber: 100n,
    expectedBlockHash: HASH,
    durationMs: 12.5,
  });
}

describe('anchored read error summaries', () => {
  it('includes registered context on a nested original error', () => {
    const original = new Error('RPC failed.');
    register(original);

    const wrapper = new Error('Submission failed.', {
      cause: original,
    });

    const summary = summarizeErrorForOutput(wrapper);

    expect(summary).not.toHaveProperty('anchoredRead');
    expect(summary.cause?.anchoredRead).toEqual({
      method: 'eth_getTransactionCount',
      blockNumber: '100',
      expectedBlockHash: HASH,
      durationMs: 12.5,
      classification: 'unknown',
    });
  });

  it('scrubs a provider message that echoes the request URL', () => {
    const password = 'rpc-password-canary';
    const pathSecret = 'rpc-path-canary';
    const querySecret = 'rpc-query-canary';

    const url =
      `https://operator:${password}@rpc.example/` +
      `${pathSecret}?token=${querySecret}`;

    const original = new Error(
      'Historical state is not available; request URL: ' + url,
    );

    register(original);

    const summary = summarizeErrorForOutput(
      new Error('Submission failed.', { cause: original }),
      {
        scrubText: createScrubber({
          rpcUrls: [url],
        }),
      },
    );

    const serialized = JSON.stringify(summary);

    expect(summary.cause?.anchoredRead?.blockNumber).toBe('100');
    expect(summary.cause?.message)
      .toContain('Historical state is not available');

    expect(serialized).not.toContain(url);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(pathSecret);
    expect(serialized).not.toContain(querySecret);
  });

  it('ignores an unregistered lookalike property', () => {
    const error = Object.assign(new Error('RPC failed.'), {
      anchoredRead: {
        method: 'provider-controlled',
        url: 'https://secret.example/private',
      },
    });

    expect(summarizeErrorForOutput(error))
      .not.toHaveProperty('anchoredRead');
  });

  it('does not share mutable context between summaries', () => {
    const error = new Error('RPC failed.');
    register(error);

    const first = summarizeErrorForOutput(error);
    first.anchoredRead!.blockNumber = '200';

    expect(
      summarizeErrorForOutput(error).anchoredRead?.blockNumber,
    ).toBe('100');
  });

  it('keeps the serialized summary within its existing budget', () => {
    const children = Array.from({ length: 4 }, () => {
      const error = new Error('Provider explanation. '.repeat(1_000));
      register(error);
      return error;
    });

    const error = new AggregateError(children, 'Multiple failures.');
    register(error);

    const summary = summarizeErrorForOutput(error, {
      scrubText: createScrubber({ rpcUrls: [] }),
    });

    expect(summary.code).not.toBe('SUMMARY_UNAVAILABLE');
    expect(summary.anchoredRead).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(summary)))
      .toBeLessThanOrEqual(8_192);
  });
});