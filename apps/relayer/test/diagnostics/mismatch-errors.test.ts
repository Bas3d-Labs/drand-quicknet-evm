import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createDeploymentChainMismatchError,
  createConsumerRegistryMismatchError,
  mismatchDetails,
} from '../../src/diagnostics/mismatch-errors.js';

import {
  summarizeErrorForOutput,
} from '../../src/diagnostics/error-output.js';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

const CONSUMER = '0x1111111111111111111111111111111111111111';
const EXPECTED = '0x2222222222222222222222222222222222222222';
const RECEIVED = '0x3333333333333333333333333333333333333333';

describe('registered mismatch diagnostics', () => {
  it('renders validated chain IDs without a configured policy', () => {
    const error = createDeploymentChainMismatchError(46630, 4663);

    expect(summarizeErrorForOutput(error)).toEqual({
      name: 'Error',
      code: 'DEPLOYMENT_CHAIN_MISMATCH',
      message:
        'Deployment manifest chain mismatch: ' +
        'expected 46630, received 4663.',
      mismatch: {
        kind: 'deployment-chain',
        expected: 46630,
        received: 4663,
      },
    });
  });

  it('shares registry mismatch fields between CLI and logger output', () => {
    const error = createConsumerRegistryMismatchError(
      CONSUMER,
      EXPECTED,
      RECEIVED,
    );

    const cli = JSON.parse(renderDiagnostic(error));
    const lines: string[] = [];

    const logger = createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    logger.consumerFailed({
      consumer: CONSUMER,
      error,
    });

    expect(lines).toHaveLength(1);

    const daemon = JSON.parse(lines[0]!);

    expect(cli.err).toMatchObject({
      code: 'CONSUMER_REGISTRY_MISMATCH',
      mismatch: {
        kind: 'consumer-registry',
        consumer: CONSUMER,
        expected: EXPECTED,
        received: RECEIVED,
      },
    });

    expect(daemon.err).toEqual(cli.err);
  });

  it('keeps registered values independent of mutable error properties', () => {
    const error = createDeploymentChainMismatchError(46630, 4663);

    Object.assign(error, {
      message: 'untrusted replacement',
      code: 'untrusted-code',
      mismatch: {
        expected: 1,
        received: 2,
      },
    });

    const first = summarizeErrorForOutput(error);

    expect(first.message).not.toContain('untrusted');
    expect(first.code).toBe('DEPLOYMENT_CHAIN_MISMATCH');

    if (
      first.mismatch === undefined ||
      first.mismatch.kind !== 'deployment-chain'
    ) {
      throw new Error('Expected chain mismatch details.');
    }

    first.mismatch.expected = 1;

    expect(summarizeErrorForOutput(error).mismatch).toEqual({
      kind: 'deployment-chain',
      expected: 46630,
      received: 4663,
    });
  });

  it('does not trust lookalike fields or invoke their getters', () => {
    const get = vi.fn(() => {
      throw new Error('must not inspect mismatch fields');
    });

    const error = Object.assign(new Error('provider failure'), {
      code: 'DEPLOYMENT_CHAIN_MISMATCH',
    });

    Object.defineProperty(error, 'mismatch', { get });

    expect(mismatchDetails(error)).toBeUndefined();
    expect(summarizeErrorForOutput(error))
      .not.toHaveProperty('mismatch');
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid chain ID: %s', (value) => {
    expect(() => createDeploymentChainMismatchError(value, 4663))
      .toThrow('Invalid deployment chain mismatch.');

    expect(() => createDeploymentChainMismatchError(46630, value))
      .toThrow('Invalid deployment chain mismatch.');
  });

  it('rejects malformed addresses before registration', () => {
    expect(() => createConsumerRegistryMismatchError(
      '0x1234',
      EXPECTED,
      RECEIVED,
    )).toThrow('Invalid consumer registry mismatch.');

    expect(() => createConsumerRegistryMismatchError(
      CONSUMER,
      '0x1234',
      RECEIVED,
    )).toThrow('Invalid consumer registry mismatch.');

    expect(() => createConsumerRegistryMismatchError(
      CONSUMER,
      EXPECTED,
      '0x1234',
    )).toThrow('Invalid consumer registry mismatch.');
  });
});