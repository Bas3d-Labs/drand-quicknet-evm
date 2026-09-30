import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  UsageError,
} from '../../src/diagnostics/usage-error.js';

import {
  RelayerConfigError,
} from '../../src/diagnostics/config-errors.js';

import type {
  RoundImportProgress,
} from '../../src/diagnostics/operation-context.js';

const HASH = `0x${'12'.repeat(32)}` as const;

const progress: RoundImportProgress = {
  round: 32607411n,
  phase: 'wait-for-receipt',
  transactionHash: HASH,
};

const policy = {
  scrubText: (text: string) => ({
    text,
    removed: false,
  }),
};

describe('import failure diagnostic', () => {
  it('shares the validated import fields between CLI and daemon output', () => {
    const failure = new Error('The request timed out.');

    const cli = JSON.parse(
      renderDiagnostic(failure, policy, progress),
    );

    const lines: string[] = [];

    const logger = createRelayerLog({
      chainId: 4663,
      errorSummary: policy,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    logger.consumerFailed({
      consumer: '0x1111111111111111111111111111111111111111',
      error: failure,
      operation: {
        name: 'import-round',
        scanType: 'durable',
        fromBlock: 1000n,
        toBlock: 1099n,
        ...progress,
      },
    });

    expect(cli.operation).toEqual({
      name: 'import-round',
      round: '32607411',
      phase: 'wait-for-receipt',
      transactionHash: HASH,
    });

    const daemon = JSON.parse(lines[0]!);

    expect(daemon.operation).toMatchObject(cli.operation);
    expect(daemon.err).toEqual(cli.err);
    expect(cli).not.toHaveProperty('operationOmitted');
    expect(daemon).not.toHaveProperty('operationOmitted');
  });

  it.each([
    {
      round: 1n,
      phase: 'provider-secret',
    },
    {
      round: 1n << 64n,
      phase: 'fetch-beacon',
    },
    {
      round: 1n,
      phase: 'wait-for-receipt',
      transactionHash: 'provider-secret',
    },
  ])('omits malformed context while retaining the error: %#', (invalid) => {
    const record = JSON.parse(renderDiagnostic(
      new Error('original explanation'),
      policy,
      invalid as RoundImportProgress,
    ));

    expect(record).not.toHaveProperty('operation');
    expect(record.err.message).toBe('original explanation');
    expect(record.operationOmitted).toBe(true);
    expect(JSON.stringify(record)).not.toContain('provider-secret');
  });

  it('does not invoke progress accessors', () => {
    const getter = vi.fn(() => 'fetch-beacon');

    const invalid = Object.defineProperty(
      { round: 1n },
      'phase',
      { get: getter },
    );

    const record = JSON.parse(renderDiagnostic(
      new Error('original explanation'),
      policy,
      invalid as RoundImportProgress,
    ));

    expect(getter).not.toHaveBeenCalled();
    expect(record).not.toHaveProperty('operation');
    expect(record.operationOmitted).toBe(true);
    expect(record.err.message).toBe('original explanation');
  });

  it('does not copy extras or a hash from a pre-receipt phase', () => {
    const record = JSON.parse(renderDiagnostic(
      new Error('failed'),
      policy,
      {
        round: 1n,
        phase: 'submit-transaction',
        transactionHash: HASH,
        body: 'provider-secret',
      } as RoundImportProgress,
    ));

    expect(record.operation).toEqual({
      name: 'import-round',
      round: '1',
      phase: 'submit-transaction',
    });

    expect(record).not.toHaveProperty('operationOmitted');
  });

  it.each([
    new UsageError('UNKNOWN_COMMAND'),
    new RelayerConfigError(
      'INVALID_RPC_URL',
      'QUICKNET_RPC_URL',
    ),
  ])('keeps catalog diagnostics independent of import context', (error) => {
    expect(renderDiagnostic(error, policy, progress))
      .toBe(renderDiagnostic(error, policy));
  });
});