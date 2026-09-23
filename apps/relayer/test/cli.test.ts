import process from 'node:process';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Address,
  Hash,
  PublicClient,
  WalletClient,
} from 'viem';

import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodTestnet } from 'viem/chains';

vi.mock('../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/config.js')>();

  return {
    ...actual,
    loadRelayerConfig: vi.fn(),
  };
});

vi.mock('../src/chain/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));

vi.mock('../src/cli/daemon-command.js', () => ({
  runDaemonCommand: vi.fn(),
}));

vi.mock('../src/rounds/import-round.js', () => ({
  importQuicknetRound: vi.fn(),
}));

vi.mock('../src/rounds/import-round-when-available.js', () => ({
  importQuicknetRoundWhenAvailable: vi.fn(),
}));

import {
  main,
  parseCommandArguments,
} from '../src/cli/cli.js';

import type { CliOutput } from '../src/cli/cli-output.js';
import { createRelayerClients } from '../src/chain/clients.js';

import {
  loadRelayerConfig,
  type NetworkSource,
  type RelayerConfig,
} from '../src/config/config.js';

import { runDaemonCommand } from '../src/cli/daemon-command.js';
import type { DaemonStartupSummary } from '../src/daemon/daemon-startup.js';
import { importQuicknetRound } from '../src/rounds/import-round.js';
import { importQuicknetRoundWhenAvailable } from '../src/rounds/import-round-when-available.js';

import {
  UsageError,
  usageCode,
  type UsageCode,
} from '../src/diagnostics/usage-error.js';

const PRESET = 'robinhood-testnet';
const CONFIG_FILE = './networks/example-mainnet.json';

const SOURCE = {
  type: 'preset',
  network: PRESET,
} as const;

const ROUND = 31_089_008n;
const MAX_UINT64 = '18446744073709551615';
const ABOVE_MAX_UINT64 = '18446744073709551616';
const SECRET = 'cli-credential-canary';

const CONSUMER: Address =
  '0x1111111111111111111111111111111111111111';

const REGISTRY: Address =
  '0x2222222222222222222222222222222222222222';

const HASH: Hash =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const RANDOMNESS: Hash =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ACCOUNT = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);

const CONFIG: RelayerConfig = {
  network: PRESET,
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.example.test',
  account: ACCOUNT,
  deployment: {
    chainId: robinhoodTestnet.id,
    address: REGISTRY,
    runtimeCodehash: HASH,
    verifierAddress: CONSUMER,
    verifierRuntimeCodehash: HASH,
  },
  finality: { type: 'safe' },
};

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;

const IMPORTED = {
  status: 'imported',
  round: ROUND,
  randomness: RANDOMNESS,
  transactionHash: HASH,
} as const;

const ALREADY_STORED = {
  status: 'already-stored',
  round: ROUND,
  randomness: RANDOMNESS,
} as const;

const STARTUP_SUMMARY: DaemonStartupSummary = {
  network: PRESET,
  chainId: robinhoodTestnet.id,
  rpcOrigin: 'https://rpc.example.test',
  signer: ACCOUNT.address,
  signerBalance: 1n,
  registry: REGISTRY,
  registryRuntimeCodehash: HASH,
  finality: { type: 'safe' },
  latestHead: 1_000n,
  durableHead: 900n,
  consumers: [CONSUMER],
  checkpointFile: './state/checkpoint.json',
  startBlock: 800n,
  maxBlockRange: 2_000n,
  pollIntervalMs: 1_000,
  durableNextBlocks: new Map([[CONSUMER, 901n]]),
};

function expectUsage(
  args: readonly string[],
  code: UsageCode,
): void {
  let thrown: unknown;

  try {
    parseCommandArguments(args);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(UsageError);
  expect(usageCode(thrown)).toBe(code);
}

const NETWORK_CASES: {
  name: string;
  args: string[];
  source: NetworkSource;
}[] = [
  {
    name: 'preset',
    args: ['--network', PRESET],
    source: SOURCE,
  },
  {
    name: 'custom config',
    args: ['--network-config', CONFIG_FILE],
    source: {
      type: 'custom',
      configFile: CONFIG_FILE,
    },
  },
];

const NETWORK_FAILURES: {
  name: string;
  args: string[];
  code: UsageCode;
}[] = [
  {
    name: 'missing network',
    args: [],
    code: 'MISSING_NETWORK',
  },
  {
    name: 'missing preset value',
    args: ['--network'],
    code: 'MISSING_NETWORK_VALUE',
  },
  {
    name: 'missing config value',
    args: ['--network-config'],
    code: 'MISSING_NETWORK_CONFIG_VALUE',
  },
  {
    name: 'duplicate preset',
    args: ['--network', PRESET, '--network', PRESET],
    code: 'DUPLICATE_NETWORK',
  },
  {
    name: 'duplicate config',
    args: [
      '--network-config',
      CONFIG_FILE,
      '--network-config',
      './other.json',
    ],
    code: 'DUPLICATE_NETWORK_CONFIG',
  },
  {
    name: 'preset followed by config',
    args: [
      '--network',
      PRESET,
      '--network-config',
      CONFIG_FILE,
    ],
    code: 'CONFLICTING_NETWORK',
  },
  {
    name: 'config followed by preset',
    args: [
      '--network-config',
      CONFIG_FILE,
      '--network',
      PRESET,
    ],
    code: 'CONFLICTING_NETWORK',
  },
  {
    name: 'unsupported preset',
    args: ['--network', SECRET],
    code: 'UNSUPPORTED_NETWORK',
  },
];

const ROUND_COMMANDS = [
  'import',
  'import-when-available',
] as const;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

beforeEach(() => {
  vi.mocked(loadRelayerConfig)
    .mockReset()
    .mockResolvedValue(CONFIG);

  vi.mocked(createRelayerClients)
    .mockReset()
    .mockReturnValue({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
    });

  vi.mocked(importQuicknetRound)
    .mockReset()
    .mockResolvedValue(IMPORTED);

  vi.mocked(importQuicknetRoundWhenAvailable)
    .mockReset()
    .mockResolvedValue(IMPORTED);

  vi.mocked(runDaemonCommand)
    .mockReset()
    .mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCommandArguments', () => {
  it.each([
    [],
    ['--help'],
    ['-h'],
    ['help'],
  ])('parses help: %j', (...args) => {
    expect(parseCommandArguments(args)).toEqual({
      command: 'help',
    });
  });

  it('rejects an unknown command with a registered diagnostic', () => {
    expectUsage([SECRET], 'UNKNOWN_COMMAND');
  });

  describe.each(ROUND_COMMANDS)('%s', (command) => {
    it.each(NETWORK_CASES)(
      'parses a $name in either option order',
      ({ args, source }) => {
        for (const options of [
          [...args, '--round', ROUND.toString()],
          ['--round', ROUND.toString(), ...args],
        ]) {
          expect(
            parseCommandArguments([command, ...options]),
          ).toEqual({
            command,
            source,
            round: ROUND,
          });
        }
      },
    );

    it.each([
      ['000123', 123n],
      [MAX_UINT64, BigInt(MAX_UINT64)],
    ] as const)('accepts round %s', (value, round) => {
      expect(
        parseCommandArguments([
          command,
          '--network',
          PRESET,
          '--round',
          value,
        ]),
      ).toEqual({
        command,
        source: SOURCE,
        round,
      });
    });

    it.each(NETWORK_FAILURES)(
      'rejects $name',
      ({ args, code }) => {
        expectUsage([
          command,
          '--round',
          ROUND.toString(),
          ...args,
        ], code);
      },
    );

    it('rejects a missing round', () => {
      expectUsage([
        command,
        '--network',
        PRESET,
      ], 'MISSING_ROUND');
    });

    it('rejects a missing round value', () => {
      expectUsage([
        command,
        '--network',
        PRESET,
        '--round',
      ], 'MISSING_ROUND_VALUE');
    });

    it('rejects duplicate rounds', () => {
      expectUsage([
        command,
        '--network',
        PRESET,
        '--round',
        '1',
        '--round',
        '2',
      ], 'DUPLICATE_ROUND');
    });

    it.each([
      '',
      '-1',
      '0x1234',
      '123.5',
      '123abc',
      ' 123 ',
    ])('rejects invalid decimal round %j', (value) => {
      expectUsage([
        command,
        '--network',
        PRESET,
        '--round',
        value,
      ], 'INVALID_ROUND');
    });

    it('rejects zero', () => {
      expectUsage([
        command,
        '--network',
        PRESET,
        '--round',
        '0',
      ], 'ZERO_ROUND');
    });

    it('rejects uint64 overflow', () => {
      expectUsage([
        command,
        '--network',
        PRESET,
        '--round',
        ABOVE_MAX_UINT64,
      ], 'ROUND_OVERFLOW');
    });

    it('rejects an unknown argument', () => {
      expectUsage([
        command,
        '--network',
        PRESET,
        '--round',
        '1',
        SECRET,
      ], 'UNKNOWN_ARGUMENT');
    });
  });

  describe('daemon', () => {
    it.each(NETWORK_CASES)(
      'parses a $name',
      ({ args, source }) => {
        expect(
          parseCommandArguments(['daemon', ...args]),
        ).toEqual({
          command: 'daemon',
          source,
        });
      },
    );

    it.each(['--help', '-h'])('parses %s', (flag) => {
      expect(
        parseCommandArguments(['daemon', flag]),
      ).toEqual({
        command: 'daemon-help',
      });
    });

    it.each(NETWORK_FAILURES)(
      'rejects $name',
      ({ args, code }) => {
        expectUsage(['daemon', ...args], code);
      },
    );

    it.each([SECRET, '--round'])(
      'rejects argument %s',
      (argument) => {
        expectUsage([
          'daemon',
          '--network',
          PRESET,
          argument,
        ], 'UNKNOWN_ARGUMENT');
      },
    );
  });
});

describe('main', () => {
  it.each([
    { args: [], type: 'help' },
    { args: ['--help'], type: 'help' },
    { args: ['daemon', '--help'], type: 'daemon-help' },
  ] as const)(
    'emits $type for $args',
    async ({ args, type }) => {
      const output = vi.fn<(record: CliOutput) => void>();

      await main(args, output);

      expect(output).toHaveBeenCalledExactlyOnceWith({ type });
      expect(loadRelayerConfig).not.toHaveBeenCalled();
      expect(runDaemonCommand).not.toHaveBeenCalled();
      expect(importQuicknetRound).not.toHaveBeenCalled();
      expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    },
  );

  describe.each(ROUND_COMMANDS)('%s', (command) => {
    function operation() {
      if (command === 'import') {
        return vi.mocked(importQuicknetRound);
      }

      return vi.mocked(importQuicknetRoundWhenAvailable);
    }

    it.each(NETWORK_CASES)(
      'uses the $name and emits the result',
      async ({ args, source }) => {
        const output = vi.fn<(record: CliOutput) => void>();

        await main([
          command,
          ...args,
          '--round',
          ROUND.toString(),
        ], output);

        expect(loadRelayerConfig).toHaveBeenCalledExactlyOnceWith({
          source,
        });

        expect(createRelayerClients).toHaveBeenCalledExactlyOnceWith(
          CONFIG,
        );

        expect(operation()).toHaveBeenCalledExactlyOnceWith({
          publicClient: PUBLIC_CLIENT,
          walletClient: WALLET_CLIENT,
          account: ACCOUNT,
          deployment: CONFIG.deployment,
          round: ROUND,
        });

        expect(output).toHaveBeenCalledExactlyOnceWith({
          type: 'import-result',
          round: ROUND,
          result: IMPORTED,
        });

        const calls = vi.mocked(importQuicknetRound).mock.calls.length
          + vi.mocked(importQuicknetRoundWhenAvailable).mock.calls.length;

        expect(calls).toBe(1);
      },
    );

    it('emits an already-stored result', async () => {
      operation().mockResolvedValue(ALREADY_STORED);

      const output = vi.fn();

      await main([
        command,
        '--network',
        PRESET,
        '--round',
        ROUND.toString(),
      ], output);

      expect(output).toHaveBeenCalledExactlyOnceWith({
        type: 'import-result',
        round: ROUND,
        result: ALREADY_STORED,
      });
    });

    it('does not import or emit output when configuration fails', async () => {
      const failure = new Error('Configuration failed.');
      vi.mocked(loadRelayerConfig).mockRejectedValue(failure);

      const output = vi.fn();

      await expect(
        main([
          command,
          '--network',
          PRESET,
          '--round',
          '1',
        ], output),
      ).rejects.toBe(failure);

      expect(createRelayerClients).not.toHaveBeenCalled();
      expect(operation()).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
    });

    it('propagates operation failure without emitting a result', async () => {
      const failure = new Error('Import failed.');
      operation().mockRejectedValue(failure);

      const output = vi.fn();

      await expect(
        main([
          command,
          '--network',
          PRESET,
          '--round',
          '1',
        ], output),
      ).rejects.toBe(failure);

      expect(output).not.toHaveBeenCalled();
    });

    it('preserves an injected output failure without repeating the import', async () => {
      const failure = new Error('Output failed.');

      const output = vi.fn(() => {
        throw failure;
      });

      await expect(
        main([
          command,
          '--network',
          PRESET,
          '--round',
          ROUND.toString(),
        ], output),
      ).rejects.toBe(failure);

      expect(operation()).toHaveBeenCalledOnce();
      expect(output).toHaveBeenCalledOnce();
    });
  });

  describe('daemon', () => {
    it.each(NETWORK_CASES)(
      'runs with a $name',
      async ({ args, source }) => {
        await main(['daemon', ...args], vi.fn());

        expect(runDaemonCommand).toHaveBeenCalledExactlyOnceWith({
          source,
          signal: expect.any(AbortSignal),
          onStartup: expect.any(Function),
        });

        expect(
          vi.mocked(runDaemonCommand).mock.calls[0]?.[0].signal?.aborted,
        ).toBe(false);
      },
    );

    it('accepts the pnpm argument separator', async () => {
      await main([
        '--',
        'daemon',
        '--network',
        PRESET,
      ], vi.fn());

      expect(runDaemonCommand).toHaveBeenCalledOnce();
    });

    it('forwards the startup summary to output', async () => {
      vi.mocked(runDaemonCommand).mockImplementation(
        async ({ onStartup }) => {
          onStartup?.(STARTUP_SUMMARY);
        },
      );

      const output = vi.fn();

      await main(['daemon', '--network', PRESET], output);

      expect(output).toHaveBeenCalledExactlyOnceWith({
        type: 'daemon-startup',
        summary: STARTUP_SUMMARY,
      });
    });

    it.each(SIGNALS)(
      'handles repeated %s until shutdown completes',
      async (signal) => {
        const before = process.listeners(signal);

        vi.mocked(runDaemonCommand).mockImplementation(
          async (options) => {
            const added = process.listeners(signal).filter(
              (listener) => !before.includes(listener),
            );

            expect(added).toHaveLength(1);

            const listener = added[0];

            if (listener === undefined) {
              throw new Error('Expected shutdown listener.');
            }

            expect(options.signal?.aborted).toBe(false);

            listener(signal);

            expect(options.signal?.aborted).toBe(true);

            await Promise.resolve();

            expect(process.listeners(signal)).toContain(listener);

            listener(signal);

            expect(options.signal?.aborted).toBe(true);
            expect(process.listeners(signal)).toContain(listener);
          },
        );

        await main(['daemon', '--network', PRESET], vi.fn());

        expect(process.listeners(signal)).toEqual(before);
      },
    );

    it('removes both signal listeners after success', async () => {
      const before = SIGNALS.map(
        (signal) => process.listeners(signal),
      );

      await main(['daemon', '--network', PRESET], vi.fn());

      expect(
        SIGNALS.map((signal) => process.listeners(signal)),
      ).toEqual(before);
    });

    it('preserves daemon failure and removes both signal listeners', async () => {
      const before = SIGNALS.map(
        (signal) => process.listeners(signal),
      );

      const failure = new Error('Daemon failed.');
      vi.mocked(runDaemonCommand).mockRejectedValue(failure);

      await expect(
        main(['daemon', '--network', PRESET], vi.fn()),
      ).rejects.toBe(failure);

      expect(
        SIGNALS.map((signal) => process.listeners(signal)),
      ).toEqual(before);
    });

    it('preserves startup output failure and removes both signal listeners', async () => {
      const before = SIGNALS.map(
        (signal) => process.listeners(signal),
      );

      const failure = new Error('Output failed.');

      vi.mocked(runDaemonCommand).mockImplementation(
        async ({ onStartup }) => {
          onStartup?.(STARTUP_SUMMARY);
        },
      );

      const output = vi.fn(() => {
        throw failure;
      });

      await expect(
        main(['daemon', '--network', PRESET], output),
      ).rejects.toBe(failure);

      expect(output).toHaveBeenCalledOnce();

      expect(
        SIGNALS.map((signal) => process.listeners(signal)),
      ).toEqual(before);
    });
  });
});