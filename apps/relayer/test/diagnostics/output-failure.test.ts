import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderOutputFailure,
  type CliOutput,
} from '../../src/cli/cli-output.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

const TOKEN = 'output-credential-canary';
const PRIVATE_KEY = `0x${'ab12'.repeat(16)}`;
const RPC_URL = `https://rpc.example/${TOKEN}`;

const HASH = `0x${'22'.repeat(32)}` as const;
const RANDOMNESS = `0x${'11'.repeat(32)}` as const;

const OUTPUT: CliOutput = {
  type: 'import-result',
  round: 100n,
  result: {
    status: 'imported',
    submission: 'witness',
    round: 100n,
    randomness: RANDOMNESS,
    transactionHash: HASH,
  },
};

const policy = {
  scrubText: createScrubber({
    rpcUrls: [RPC_URL],
    privateKey: PRIVATE_KEY,
  }),
};

describe('output failure diagnostics', () => {
  it('preserves the completed import and scrubbed error explanation', () => {
    const failure = Object.assign(
      new Error(
        `Output stream unavailable: ${RPC_URL}; ` +
        `token=${TOKEN}; key=${PRIVATE_KEY.toUpperCase()}`,
      ),
      { code: 'EPIPE' },
    );

    const line = renderOutputFailure(OUTPUT, failure, policy);
    const record = JSON.parse(line);

    expect(record).toMatchObject({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'import-result',
      status: 'imported',
      round: '100',
      randomness: RANDOMNESS,
      transactionHash: HASH,
      err: {
        name: 'Error',
        code: 'EPIPE',
        textModified: true,
      },
    });

    expect(record.err.message)
      .toContain('Output stream unavailable');
    expect(record.err.message)
      .toContain('https://rpc.example/[REDACTED]');
    expect(line).not.toContain(TOKEN);
    expect(line.toLowerCase())
      .not.toContain(PRIVATE_KEY.slice(2).toLowerCase());
  });

  it('keeps fixed fallback descriptions without a configured scrubber', () => {
    const line = renderOutputFailure(
      OUTPUT,
      new Error(TOKEN),
    );

    const record = JSON.parse(line);

    expect(record.err).toEqual({
      name: 'Error',
      message: 'Operation failed; details redacted.',
    });
    expect(record.transactionHash).toBe(HASH);
    expect(line).not.toContain(TOKEN);
  });

  it('bounds multibyte error text while retaining the import outcome', () => {
    const failure = new Error('😀'.repeat(3_000) + TOKEN);
    const line = renderOutputFailure(OUTPUT, failure, policy);
    const record = JSON.parse(line);

    expect(Buffer.byteLength(JSON.stringify(record.err)))
      .toBeLessThanOrEqual(8_192);
    expect(Buffer.byteLength(line + '\n'))
      .toBeLessThanOrEqual(32_768);

    expect(record.err.textModified).toBe(true);
    expect(record.status).toBe('imported');
    expect(record.transactionHash).toBe(HASH);
    expect(line).not.toContain(TOKEN);
  });

  it('retains the import outcome when scrubbing fails', () => {
    const line = renderOutputFailure(
      OUTPUT,
      new Error(TOKEN),
      {
        scrubText() {
          throw new Error(TOKEN);
        },
      },
    );

    const record = JSON.parse(line);

    expect(record.err.message)
      .toBe('[diagnostic text unavailable]');
    expect(record.err.textModified).toBe(true);
    expect(record.status).toBe('imported');
    expect(record.transactionHash).toBe(HASH);
    expect(line).not.toContain(TOKEN);
  });
});