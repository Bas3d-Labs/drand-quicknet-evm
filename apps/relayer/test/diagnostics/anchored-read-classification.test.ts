import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  classifyAnchoredReadFailure,
} from '../../src/diagnostics/anchored-read-classification.js';

import {
  registerAnchoredReadFailure,
} from '../../src/diagnostics/anchored-read-errors.js';

import {
  summarizeErrorForOutput,
} from '../../src/diagnostics/error-output.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

const HASH = 'aa'.repeat(32);

function register(error: unknown): void {
  registerAnchoredReadFailure(error, {
    method: 'eth_getTransactionCount',
    blockNumber: 100n,
    expectedBlockHash: '0x' + HASH,
    durationMs: 12.5,
  });
}

describe('anchored read classification', () => {
  it.each([
    'historical state is not available',
    'Historical state is not available.',
    `historical state ${HASH} is not available`,
    `historical state 0x${HASH} is not available`,
  ])('recognizes supported message: %s', message => {
    expect(classifyAnchoredReadFailure({ message }))
      .toBe('historical-state-unavailable');
  });

  it.each([
    'Missing or invalid parameters.',
    'Request timed out.',
    'historical state is available',
    'historical state might not be available',
    'historical state invalid-hash is not available',
    'Example: historical state is not available',
    'historical state is not available for unrelated reasons',
  ])('leaves unsupported message unknown: %s', message => {
    expect(classifyAnchoredReadFailure({ message })).toBe('unknown');
  });

  it('recognizes a supported message in the cause chain', () => {
    expect(classifyAnchoredReadFailure({
      message: 'Missing or invalid parameters.',
      cause: {
        message: `historical state ${HASH} is not available`,
      },
    })).toBe('historical-state-unavailable');
  });

  it('bounds cause traversal', () => {
    const summary = {
      message: 'Unrecognized failure.',
    } as {
      message: string;
      cause?: unknown;
    };

    summary.cause = summary;

    expect(classifyAnchoredReadFailure(
      summary as Parameters<typeof classifyAnchoredReadFailure>[0],
    )).toBe('unknown');
  });

  it('does not classify from RPC code alone', () => {
    const error = Object.assign(
      new Error('Missing or invalid parameters.'),
      { code: -32000 },
    );

    register(error);

    const summary = summarizeErrorForOutput(error, {
      scrubText: createScrubber({ rpcUrls: [] }),
    });

    expect(summary.code).toBe(-32000);
    expect(summary.anchoredRead?.classification).toBe('unknown');
  });

  it('classifies a nested provider failure while scrubbing its URL', () => {
    const secret = 'provider-credential-canary';
    const url = `https://rpc.example/${secret}`;

    const provider = Object.assign(
      new Error(
        `historical state ${HASH} is not available\n` +
        `Request URL: ${url}`,
      ),
      { code: -32000 },
    );

    const readFailure = new Error('RPC request failed.', {
      cause: provider,
    });

    register(readFailure);

    const outer = new Error('Submission failed.', {
      cause: readFailure,
    });

    const summary = summarizeErrorForOutput(outer, {
      scrubText: createScrubber({
        rpcUrls: [url],
      }),
    });

    expect(summary).not.toHaveProperty('anchoredRead');
    expect(summary.cause?.anchoredRead?.classification)
      .toBe('historical-state-unavailable');

    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain(url);
    expect(serialized).not.toContain(secret);
  });

  it('uses unknown when provider text is unavailable', () => {
    const error = new Error(
      `historical state ${HASH} is not available`,
    );

    register(error);

    expect(
      summarizeErrorForOutput(error).anchoredRead?.classification,
    ).toBe('unknown');
  });

  it('uses unknown when scrubbing fails', () => {
    const error = new Error(
      `historical state ${HASH} is not available`,
    );

    register(error);

    const summary = summarizeErrorForOutput(error, {
      scrubText() {
        throw new Error('Scrubber unavailable.');
      },
    });

    expect(summary.anchoredRead?.classification).toBe('unknown');
    expect(summary.message).toBe('[diagnostic text unavailable]');
  });

  it('does not attach anchored context to an unregistered error', () => {
    const error = new Error(
      `historical state ${HASH} is not available`,
    );

    const summary = summarizeErrorForOutput(error, {
      scrubText: createScrubber({ rpcUrls: [] }),
    });

    expect(summary).not.toHaveProperty('anchoredRead');
  });
});