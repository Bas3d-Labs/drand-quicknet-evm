import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../../../src/cli/read-relayer-status.js', () => ({
  readRelayerStatus: vi.fn(),
}));

vi.mock('../../../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/config/config.js')
  >();

  return {
    ...actual,
    loadRelayerConfig: vi.fn(),
  };
});

import {
  main,
} from '../../../src/cli/cli.js';

import {
  parseCommandArguments,
} from '../../../src/cli/parse-command-arguments.js';

import {
  readRelayerStatus,
} from '../../../src/cli/read-relayer-status.js';

import {
  loadRelayerConfig,
} from '../../../src/config/config.js';

import {
  UsageError,
  usageCode,
  type UsageCode,
} from '../../../src/diagnostics/usage-error.js';

const SIGNER = `0x${'ab'.repeat(20)}` as const;

const IDENTITY_ARGS = [
  '--chain-id',
  '4663',
  '--signer',
  SIGNER,
];

function expectUsage(
  args: readonly string[],
  code: UsageCode,
): void {
  let thrown: unknown;

  try {
    parseCommandArguments(['status', ...args]);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(UsageError);
  expect(usageCode(thrown)).toBe(code);
}

beforeEach(() => {
  vi.mocked(readRelayerStatus).mockReset();
  vi.mocked(loadRelayerConfig).mockReset();
});

describe('status argument parsing', () => {
  it.each(['journal', 'daemon-snapshot'] as const)(
    'parses explicit source %s in either option order',
    (source) => {
      for (const args of [
        [...IDENTITY_ARGS, '--source', source],
        ['--source', source, ...IDENTITY_ARGS],
      ]) {
        expect(parseCommandArguments(['status', ...args])).toEqual({
          command: 'status',
          config: {
            identity: {
              chainId: 4663,
              signer: SIGNER,
            },
            source,
            ...(source === 'daemon-snapshot'
              ? { maxAgeMs: 120_000 }
              : {}),
          },
        });
      }
    },
  );

  it('parses a custom snapshot age threshold', () => {
    expect(parseCommandArguments([
      'status',
      ...IDENTITY_ARGS,
      '--max-age-ms',
      '300000',
      '--source',
      'daemon-snapshot',
    ])).toMatchObject({
      config: {
        source: 'daemon-snapshot',
        maxAgeMs: 300_000,
      },
    });
  });

  it('requires a chain ID', () => {
    expectUsage([
      '--signer', SIGNER,
      '--source', 'journal',
    ], 'MISSING_STATUS_CHAIN_ID');
  });

  it('requires a signer', () => {
    expectUsage([
      '--chain-id', '4663',
      '--source', 'journal',
    ], 'MISSING_STATUS_SIGNER');
  });

  it('requires the launcher or caller to select a source', () => {
    expectUsage(IDENTITY_ARGS, 'MISSING_STATUS_SOURCE');
  });

  it.each([
    '--chain-id',
    '--signer',
    '--source',
    '--max-age-ms',
  ])('rejects a missing value for %s', (option) => {
    expectUsage([option], 'MISSING_STATUS_OPTION_VALUE');
    expectUsage(
      [option, '--unknown'],
      'MISSING_STATUS_OPTION_VALUE',
    );
  });

  it.each([
    ['--chain-id', '4663'],
    ['--signer', SIGNER],
    ['--source', 'daemon-snapshot'],
    ['--max-age-ms', '120000'],
  ])('rejects duplicate option %s', (option, value) => {
    expectUsage([
      ...IDENTITY_ARGS,
      '--source', 'daemon-snapshot',
      '--max-age-ms', '120000',
      option!,
      value!,
    ], 'DUPLICATE_STATUS_OPTION');
  });

  it.each([
    ['--network', 'robinhood-testnet'],
    ['--network-config', './network.json'],
    ['--apply'],
    ['--source=journal'],
    ['credential-canary'],
  ])('rejects unsupported arguments %j', (...args) => {
    expectUsage([
      ...IDENTITY_ARGS,
      '--source', 'journal',
      ...args,
    ], 'UNKNOWN_ARGUMENT');
  });

  it.each([
    ['--chain-id', '0', '--signer', SIGNER, '--source', 'journal'],
    ['--chain-id', '4663', '--signer', 'invalid', '--source', 'journal'],
    [...IDENTITY_ARGS, '--source', 'auto'],
    [...IDENTITY_ARGS, '--source', 'daemon-snapshot', '--max-age-ms', '0'],
    [...IDENTITY_ARGS, '--source', 'journal', '--max-age-ms', '120000'],
  ])('reports invalid configuration with a registered diagnostic: %j', (...args) => {
    expectUsage(args, 'INVALID_STATUS_CONFIG');
  });

  it.each(['--help', '-h'])('preserves help precedence for %s', (flag) => {
    expect(parseCommandArguments([
      'status',
      '--source',
      '--source',
      flag,
    ])).toEqual({ command: 'help' });
  });
});

describe('status command execution', () => {
  it.each(['journal', 'daemon-snapshot'] as const)(
    'reads and reports %s without loading signing configuration',
    async (source) => {
      const result = source === 'journal'
        ? {
            source: 'journal' as const,
            journal: 'missing' as const,
            gate: 'unknown' as const,
          }
        : {
            source: 'daemon-snapshot' as const,
            snapshot: 'missing' as const,
            gate: 'unknown' as const,
          };

      vi.mocked(readRelayerStatus).mockResolvedValueOnce(result);

      const output = vi.fn();

      expect(await main([
        'status',
        ...IDENTITY_ARGS,
        '--source',
        source,
      ], output)).toBe('success');

      expect(readRelayerStatus).toHaveBeenCalledExactlyOnceWith({
        identity: {
          chainId: 4663,
          signer: SIGNER,
        },
        source,
        ...(source === 'daemon-snapshot'
          ? { maxAgeMs: 120_000 }
          : {}),
        signal: expect.any(AbortSignal),
      });

      expect(output).toHaveBeenCalledExactlyOnceWith({
        type: 'relayer-status',
        result,
      });

      expect(loadRelayerConfig).not.toHaveBeenCalled();
    },
  );

  it('preserves read failures without emitting a result', async () => {
    const failure = new Error('Status read failed');
    vi.mocked(readRelayerStatus).mockRejectedValueOnce(failure);
    const output = vi.fn();

    await expect(main([
      'status',
      ...IDENTITY_ARGS,
      '--source', 'journal',
    ], output)).rejects.toBe(failure);

    expect(output).not.toHaveBeenCalled();
    expect(readRelayerStatus).toHaveBeenCalledOnce();
  });

  it('preserves output failure without repeating the read', async () => {
    vi.mocked(readRelayerStatus).mockResolvedValueOnce({
      source: 'journal',
      journal: 'missing',
      gate: 'unknown',
    });

    const failure = new Error('Output failed');

    await expect(main([
      'status',
      ...IDENTITY_ARGS,
      '--source', 'journal',
    ], () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(readRelayerStatus).toHaveBeenCalledOnce();
  });

  it('runs help without reading status or loading configuration', async () => {
    const output = vi.fn();

    expect(await main(['status', '--help'], output)).toBe('success');

    expect(output).toHaveBeenCalledExactlyOnceWith({ type: 'help' });
    expect(readRelayerStatus).not.toHaveBeenCalled();
    expect(loadRelayerConfig).not.toHaveBeenCalled();
  });
});