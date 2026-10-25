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

import type {
  RpcUsageLogContext,
} from '../../src/diagnostics/rpc/rpc-usage-log.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import {
  expectUsageError,
} from '../helpers/diagnostic-assertions.js';

const signerRuntimeMocks = vi.hoisted(() => ({
  openBeaconSubmitter: vi.fn(),
}));

const importLogMocks = vi.hoisted(() => ({
  createRelayerLog: vi.fn(),
}));

vi.mock(
  '../../src/diagnostics/relayer-log.js',
  () => importLogMocks,
);

vi.mock('../../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/config/config.js')
  >();

  return {
    ...actual,
    loadRelayerConfig: vi.fn(),
  };
});

vi.mock('../../src/chain/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));

vi.mock('../../src/cli/commands/daemon-command.js', () => ({
  runDaemonCommand: vi.fn(),
}));

vi.mock('../../src/cli/sync-nonce.js', () => ({
  syncNonce: vi.fn(),
}));

vi.mock(
  '../../src/cli/open-beacon-submitter.js',
  () => signerRuntimeMocks,
);

vi.mock('../../src/rounds/import-round.js', () => ({
  importQuicknetRound: vi.fn(),
}));

vi.mock('../../src/rounds/import-round-when-available.js', () => ({
  importQuicknetRoundWhenAvailable: vi.fn(),
}));

vi.mock('../../src/state/service-lock.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/service-lock.js')
  >();

  return {
    ...actual,
    assertServiceLockHeld: vi.fn(),
  };
});

import {
  createRelayerClients,
} from '../../src/chain/clients.js';

import {
  main,
} from '../../src/cli/cli.js';

import type {
  CliOutput,
} from '../../src/cli/output/cli-output.js';

import {
  runDaemonCommand,
} from '../../src/cli/commands/daemon-command.js';

import {
  parseCommandArguments,
} from '../../src/cli/parse-command-arguments.js';

import {
  syncNonce,
  type SyncNonceResult,
} from '../../src/cli/sync-nonce.js';

import {
  loadRelayerConfig,
  type NetworkSource,
  type LoadedRelayerConfig,
} from '../../src/config/config.js';

import type {
  DaemonStartupSummary,
} from '../../src/daemon/daemon-startup.js';

import {
  createRpcMetrics,
} from '../../src/diagnostics/rpc/rpc-metrics.js';

import type {
  UsageCode,
} from '../../src/diagnostics/usage-error.js';

import {
  importQuicknetRound,
} from '../../src/rounds/import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../../src/rounds/import-round-when-available.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from '../../src/state/service-lock.js';

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

const ERROR_SUMMARY = Object.freeze({
  scrubText(text: string) {
    return { text, removed: false };
  },
});

const CONFIG: LoadedRelayerConfig = {
  // Keep all existing fields.
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
  broadcastRetry: {
    initialDelayMs: 5_000,
    maxDelayMs: 60_000,
  },
  receiptTimeoutMs: 45_000,
  fetchTimeoutMs: 5_000,
  errorSummary: ERROR_SUMMARY,
  createErrorSummary: () => ERROR_SUMMARY,
};

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;

const IMPORTED = {
  status: 'imported',
  submission: 'witness',
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
  expectUsageError(
    () => parseCommandArguments(args),
    code,
  );
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

let submitter: BeaconSubmitter;

beforeEach(() => {
  vi.mocked(loadRelayerConfig)
    .mockReset()
    .mockResolvedValue(CONFIG);

  vi.mocked(createRelayerClients)
    .mockReset()
    .mockReturnValue({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      rpcMetrics: createRpcMetrics(),
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

  vi.mocked(syncNonce)
    .mockReset()
    .mockResolvedValue({
      status: 'already-synchronized',
    });

  vi.mocked(assertServiceLockHeld)
    .mockReset()
    .mockReturnValue({
      stateDirectory: '/verified-state',
      dev: 1n,
      ino: 2n,
    });

  submitter = {
    findRetainedWork: vi.fn<BeaconSubmitter['findRetainedWork']>()
      .mockReturnValue(null),
    recover: vi.fn<BeaconSubmitter['recover']>(),
    submit: vi.fn<BeaconSubmitter['submit']>(),
  };

  signerRuntimeMocks.openBeaconSubmitter
    .mockReset()
    .mockResolvedValue(submitter);

  importLogMocks.createRelayerLog
    .mockReset()
    .mockReturnValue({
      rpcUsage: vi.fn(),
      loggingFailed: vi.fn(),
    });
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
    { args: ['--', 'help'], type: 'help' },
    { args: ['daemon', '--help'], type: 'daemon-help' },
    { args: ['import', '--help'], type: 'help' },
    { args: ['import-when-available', '-h'], type: 'help' },
    {
      args: ['import', '--network-config', '--help'],
      type: 'help',
    },
    {
      args: ['daemon', '--network-config', '--help'],
      type: 'daemon-help',
    },
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
      expect(assertServiceLockHeld).not.toHaveBeenCalled();
      expect(createRelayerClients).not.toHaveBeenCalled();
    },
  );
  
  it.each(SIGNALS)(
    'completes gracefully when %s cancels startup',
    async (signal) => {
      const before = SIGNALS.map(
        (name) => process.listeners(name),
      );
      const previous = process.listeners(signal);
      const output = vi.fn();

      vi.mocked(runDaemonCommand).mockImplementationOnce(
        async ({ signal: abortSignal }) => {
          const added = process.listeners(signal).filter(
            (listener) => !previous.includes(listener),
          );

          expect(added).toHaveLength(1);
          added[0]!(signal);

          expect(abortSignal?.aborted).toBe(true);
          abortSignal!.throwIfAborted();
        },
      );

      await expect(
        main(['daemon', '--network', PRESET], output),
      ).resolves.toBe('success');

      expect(output).not.toHaveBeenCalled();
      expect(
        SIGNALS.map((name) => process.listeners(name)),
      ).toEqual(before);
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
          account: ACCOUNT,
          submitter,
          deployment: CONFIG.deployment,
          round: ROUND,
          receiptTimeoutMs: CONFIG.receiptTimeoutMs,
          fetchTimeoutMs: CONFIG.fetchTimeoutMs,
          onProgress: expect.any(Function),
          signal: expect.any(AbortSignal),
        });

        expect(signerRuntimeMocks.openBeaconSubmitter)
          .toHaveBeenCalledOnce();

        expect(
          operation().mock.calls[0]![0].submitter,
        ).toBe(submitter);

        expect(output).toHaveBeenCalledExactlyOnceWith({
          type: 'import-result',
          round: ROUND,
          result: IMPORTED,
        });

        const calls =
          vi.mocked(importQuicknetRound).mock.calls.length +
          vi.mocked(importQuicknetRoundWhenAvailable).mock.calls.length;

        expect(calls).toBe(1);

        expect(assertServiceLockHeld)
          .toHaveBeenCalledExactlyOnceWith();

        expect(
          vi.mocked(assertServiceLockHeld)
            .mock.invocationCallOrder[0]!,
        ).toBeLessThan(
          vi.mocked(loadRelayerConfig)
            .mock.invocationCallOrder[0]!,
        );
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

    it('refuses execution before loading configuration when the lock is not verified', async () => {
      const failure = new ServiceLockNotHeldError('descriptor');

      vi.mocked(assertServiceLockHeld).mockImplementationOnce(() => {
        throw failure;
      });

      const output = vi.fn();
      const onDiagnostics = vi.fn();
      const onImportFailure = vi.fn();

      await expect(
        main([
          command,
          '--network',
          PRESET,
          '--round',
          ROUND.toString(),
        ], output, {
          onDiagnostics,
          onImportFailure,
        }),
      ).rejects.toBe(failure);

      expect(assertServiceLockHeld)
        .toHaveBeenCalledExactlyOnceWith();

      expect(loadRelayerConfig).not.toHaveBeenCalled();
      expect(createRelayerClients).not.toHaveBeenCalled();
      expect(importQuicknetRound).not.toHaveBeenCalled();
      expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
      expect(runDaemonCommand).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(onDiagnostics).not.toHaveBeenCalled();
      expect(onImportFailure).not.toHaveBeenCalled();
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
          onDiagnostics: expect.any(Function),
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

    it.each(SIGNALS)(
      'preserves an unrelated failure after %s requests shutdown',
      async (signal) => {
        const before = SIGNALS.map(
          (name) => process.listeners(name),
        );
        const previous = process.listeners(signal);
        const failure = new Error('Journal persistence failed.');
        const output = vi.fn();

        vi.mocked(runDaemonCommand).mockImplementationOnce(
          async ({ signal: abortSignal }) => {
            const added = process.listeners(signal).filter(
              (listener) => !previous.includes(listener),
            );

            expect(added).toHaveLength(1);
            added[0]!(signal);

            expect(abortSignal?.aborted).toBe(true);
            expect(abortSignal?.reason).not.toBe(failure);

            throw failure;
          },
        );

        await expect(
          main(['daemon', '--network', PRESET], output),
        ).rejects.toBe(failure);

        expect(output).not.toHaveBeenCalled();
        expect(
          SIGNALS.map((name) => process.listeners(name)),
        ).toEqual(before);
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

  it.each(SIGNALS)(
    'forwards the import signal and handles %s cancellation without failure reporting',
    async (shutdownSignal) => {
      const before = SIGNALS.map(name => process.listeners(name));
      const previous = process.listeners(shutdownSignal);
      const output = vi.fn();
      const onImportFailure = vi.fn();

      vi.mocked(importQuicknetRound).mockImplementationOnce(
        async ({ signal, onProgress }) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(
            signerRuntimeMocks.openBeaconSubmitter.mock.calls[0]![0].signal,
          ).toBe(signal);

          onProgress?.({
            round: ROUND,
            phase: 'fetch-beacon',
          });

          const added = process.listeners(shutdownSignal).filter(
            listener => !previous.includes(listener),
          );

          expect(added).toHaveLength(1);
          added[0]!(shutdownSignal);

          expect(signal?.aborted).toBe(true);
          signal!.throwIfAborted();

          throw new Error('Expected cancellation to throw.');
        },
      );

      await expect(main([
        'import',
        '--network',
        PRESET,
        '--round',
        ROUND.toString(),
      ], output, { onImportFailure })).resolves.toBe('interrupted');

      expect(importQuicknetRound).toHaveBeenCalledOnce();
      expect(output).not.toHaveBeenCalled();
      expect(onImportFailure).not.toHaveBeenCalled();
      expect(
        SIGNALS.map(name => process.listeners(name)),
      ).toEqual(before);
    },
  );

  it.each(['configuration', 'signer'] as const)(
    'stops import startup after cancellation during %s',
    async (stage) => {
      const before = SIGNALS.map(name => process.listeners(name));
      const previous = process.listeners('SIGTERM');
      const output = vi.fn();

      function requestShutdown(): void {
        const added = process.listeners('SIGTERM').filter(
          listener => !previous.includes(listener),
        );

        expect(added).toHaveLength(1);
        added[0]!('SIGTERM');
      }

      if (stage === 'configuration') {
        vi.mocked(loadRelayerConfig).mockImplementationOnce(async () => {
          requestShutdown();
          return CONFIG;
        });
      } else {
        signerRuntimeMocks.openBeaconSubmitter
          .mockImplementationOnce(async () => {
            requestShutdown();
            return submitter;
          });
      }

      await expect(main([
        'import',
        '--network',
        PRESET,
        '--round',
        ROUND.toString(),
      ], output)).resolves.toBe('interrupted');

      if (stage === 'configuration') {
        expect(createRelayerClients).not.toHaveBeenCalled();
        expect(signerRuntimeMocks.openBeaconSubmitter)
          .not.toHaveBeenCalled();
      } else {
        expect(signerRuntimeMocks.openBeaconSubmitter)
          .toHaveBeenCalledOnce();
      }

      expect(importQuicknetRound).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(
        SIGNALS.map(name => process.listeners(name)),
      ).toEqual(before);
    },
  );

  it.each(SIGNALS)(
    'forwards the import-when-available signal and handles %s cancellation without failure reporting',
    async (shutdownSignal) => {
      const before = SIGNALS.map(name => process.listeners(name));
      const previous = process.listeners(shutdownSignal);
      const output = vi.fn();
      const onImportFailure = vi.fn();

      vi.mocked(importQuicknetRoundWhenAvailable).mockImplementationOnce(
        async ({ signal, onProgress }) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(
            signerRuntimeMocks.openBeaconSubmitter.mock.calls[0]![0].signal,
          ).toBe(signal);

          onProgress?.({
            round: ROUND,
            phase: 'wait-for-beacon',
          });

          const added = process.listeners(shutdownSignal).filter(
            listener => !previous.includes(listener),
          );

          expect(added).toHaveLength(1);
          added[0]!(shutdownSignal);

          expect(signal?.aborted).toBe(true);
          signal!.throwIfAborted();

          throw new Error('Expected cancellation to throw.');
        },
      );

      await expect(main([
        'import-when-available',
        '--network',
        PRESET,
        '--round',
        ROUND.toString(),
      ], output, { onImportFailure })).resolves.toBe('interrupted');

      expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledOnce();
      expect(importQuicknetRound).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(onImportFailure).not.toHaveBeenCalled();
      expect(
        SIGNALS.map(name => process.listeners(name)),
      ).toEqual(before);
    },
  );

  it.each(['configuration', 'signer'] as const)(
    'stops import-when-available startup after cancellation during %s',
    async (stage) => {
      const before = SIGNALS.map(name => process.listeners(name));
      const previous = process.listeners('SIGTERM');
      const output = vi.fn();

      function requestShutdown(): void {
        const added = process.listeners('SIGTERM').filter(
          listener => !previous.includes(listener),
        );

        expect(added).toHaveLength(1);
        added[0]!('SIGTERM');
      }

      if (stage === 'configuration') {
        vi.mocked(loadRelayerConfig).mockImplementationOnce(async () => {
          requestShutdown();
          return CONFIG;
        });
      } else {
        signerRuntimeMocks.openBeaconSubmitter
          .mockImplementationOnce(async () => {
            requestShutdown();
            return submitter;
          });
      }

      await expect(main([
        'import-when-available',
        '--network',
        PRESET,
        '--round',
        ROUND.toString(),
      ], output)).resolves.toBe('interrupted');

      if (stage === 'configuration') {
        expect(createRelayerClients).not.toHaveBeenCalled();
        expect(signerRuntimeMocks.openBeaconSubmitter)
          .not.toHaveBeenCalled();
      } else {
        expect(signerRuntimeMocks.openBeaconSubmitter)
          .toHaveBeenCalledOnce();
      }

      expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
      expect(importQuicknetRound).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(
        SIGNALS.map(name => process.listeners(name)),
      ).toEqual(before);
    },
  );
});

describe('diagnostic policy handoff', () => {
  it.each(ROUND_COMMANDS)(
    'installs policy before %s creates clients',
    async (command) => {
      const policy = {
        scrubText: (text: string) => ({ text, removed: false }),
      };

      vi.mocked(loadRelayerConfig).mockImplementation(async (options) => {
        options.onDiagnostics?.(policy);

        return {
          ...CONFIG,
          errorSummary: policy,
          createErrorSummary: () => policy,
        };
      });

      const onDiagnostics = vi.fn();

      vi.mocked(createRelayerClients).mockImplementation(() => {
        expect(onDiagnostics).toHaveBeenCalledExactlyOnceWith(policy);
        throw new Error('client initialization failed');
      });

      await expect(
        main([
          command,
          '--network',
          PRESET,
          '--round',
          ROUND.toString(),
        ], vi.fn(), { onDiagnostics }),
      ).rejects.toThrow('client initialization failed');
    },
  );

  it('does not install a policy when loading fails before the callback', async () => {
    vi.mocked(loadRelayerConfig).mockRejectedValue(
      new Error('invalid configuration'),
    );

    const onDiagnostics = vi.fn();

    await expect(
      main([
        'import',
        '--network',
        PRESET,
        '--round',
        ROUND.toString(),
      ], vi.fn(), { onDiagnostics }),
    ).rejects.toThrow('invalid configuration');

    expect(onDiagnostics).not.toHaveBeenCalled();
  });

  it('forwards the daemon policy to the caller', async () => {
    const policy = undefined;

    vi.mocked(runDaemonCommand).mockImplementation(async (options) => {
      options.onDiagnostics?.(policy);
    });

    const onDiagnostics = vi.fn();

    await main(
      ['daemon', '--network', PRESET],
      vi.fn(),
      { onDiagnostics },
    );

    expect(onDiagnostics).toHaveBeenCalledExactlyOnceWith(policy);
  });
});

describe.each(ROUND_COMMANDS)('%s failure context', (command) => {
  function operation() {
    if (command === 'import') {
      return vi.mocked(importQuicknetRound);
    }

    return vi.mocked(importQuicknetRoundWhenAvailable);
  }

  const args = [
    command,
    '--network',
    PRESET,
    '--round',
    ROUND.toString(),
  ];

  const progress = {
    round: ROUND,
    phase: 'wait-for-receipt' as const,
    transactionHash: HASH,
  };

  it('reports the failed import without replacing its error', async () => {
    const failure = new Error('receipt timed out');

    operation().mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.(progress);
      throw failure;
    });

    const onImportFailure = vi.fn();

    await expect(
      main(args, vi.fn(), { onImportFailure }),
    ).rejects.toBe(failure);

    expect(onImportFailure).toHaveBeenCalledExactlyOnceWith(
      failure,
      progress,
    );
  });

  it('preserves the import error when its diagnostic observer throws', async () => {
    const failure = new Error('receipt timed out');

    operation().mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.(progress);
      throw failure;
    });

    await expect(
      main(args, vi.fn(), {
        onImportFailure() {
          throw new Error('observer failed');
        },
      }),
    ).rejects.toBe(failure);
  });

  it('does not attach import failure context to an output failure', async () => {
    operation().mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.(progress);
      return IMPORTED;
    });

    const failure = new Error('output failed');
    const onImportFailure = vi.fn();

    const output = () => {
      throw failure;
    };

    await expect(
      main(args, output, { onImportFailure }),
    ).rejects.toBe(failure);

    expect(onImportFailure).not.toHaveBeenCalled();
  });

  it.each(
    SIGNALS.flatMap(shutdownSignal =>
      (['success', 'failure'] as const).map(outcome => ({
        shutdownSignal,
        outcome,
      })),
    ),
  )(
    'awaits the active import through repeated $shutdownSignal and preserves $outcome',
    async ({ shutdownSignal, outcome }) => {
      const before = SIGNALS.map(name => process.listeners(name));
      const previous = process.listeners(shutdownSignal);
      const output = vi.fn();
      const onImportFailure = vi.fn();
      const failure = new Error('Active import failed.');

      const progress = {
        round: ROUND,
        phase: 'wait-for-receipt' as const,
        transactionHash: HASH,
      };

      let notifyStarted: () => void = () => {};
      let finishImport: () => void = () => {};

      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });

      const finished = new Promise<void>((resolve) => {
        finishImport = resolve;
      });

      let activeSignal: AbortSignal | undefined;

      operation().mockImplementationOnce(async ({ signal, onProgress }) => {
        activeSignal = signal;
        onProgress?.(progress);
        notifyStarted();

        await finished;

        if (outcome === 'failure') {
          throw failure;
        }

        return IMPORTED;
      });

      let commandFinished = false;

      // Observe rejection immediately so the failure case cannot become
      // an unhandled rejection while the test controls the active import.
      const pending = main([
        command,
        '--network',
        PRESET,
        '--round',
        ROUND.toString(),
      ], output, { onImportFailure }).then(
        () => {
          commandFinished = true;
          return { status: 'fulfilled' } as const;
        },
        (error: unknown) => {
          commandFinished = true;
          return { status: 'rejected', error } as const;
        },
      );

      try {
        await Promise.race([started, pending]);

        expect(operation()).toHaveBeenCalledOnce();
        expect(activeSignal).toBeInstanceOf(AbortSignal);

        const added = process.listeners(shutdownSignal).filter(
          listener => !previous.includes(listener),
        );

        expect(added).toHaveLength(1);
        const listener = added[0]!;

        listener(shutdownSignal);
        await Promise.resolve();

        expect(activeSignal?.aborted).toBe(true);
        expect(commandFinished).toBe(false);
        expect(process.listeners(shutdownSignal)).toContain(listener);

        listener(shutdownSignal);
        await Promise.resolve();

        expect(commandFinished).toBe(false);
        expect(process.listeners(shutdownSignal)).toContain(listener);
        expect(output).not.toHaveBeenCalled();
        expect(onImportFailure).not.toHaveBeenCalled();
      } finally {
        finishImport();
        await pending;
      }

      const result = await pending;

      if (outcome === 'success') {
        expect(result).toEqual({ status: 'fulfilled' });
        expect(output).toHaveBeenCalledExactlyOnceWith({
          type: 'import-result',
          round: ROUND,
          result: IMPORTED,
        });
        expect(onImportFailure).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe('rejected');

        if (result.status !== 'rejected') {
          throw new Error('Expected the import failure.');
        }

        expect(result.error).toBe(failure);
        expect(output).not.toHaveBeenCalled();
        expect(onImportFailure).toHaveBeenCalledExactlyOnceWith(
          failure,
          progress,
        );
      }

      expect(operation()).toHaveBeenCalledOnce();
      expect(
        SIGNALS.map(name => process.listeners(name)),
      ).toEqual(before);
    },
  );
});

const NONCE_REPAIR = {
  kind: 'sync-nonce' as const,
  at: '2026-10-12T12:00:00.000Z',
  previousNextNonce: 4n,
  nextNonce: 8n,
  observation: {
    anchor: {
      blockNumber: 110n,
      blockHash: HASH,
    },
    nonce: 8n,
  },
};

const NONCE_PREVIEW: SyncNonceResult = {
  status: 'repair-available',
  repair: NONCE_REPAIR,
  snapshot: {
    version: 1,
    identity: {
      chainId: CONFIG.chain.id,
      signer: ACCOUNT.address,
    },
    baseline: {
      anchor: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      nonce: 4n,
    },
    lastObservation: NONCE_REPAIR.observation,
    nextNonce: 8n,
    durableNextNonce: 8n,
    repairs: [NONCE_REPAIR],
    attempts: [],
  },
};

const SYNC_ARGS = [
  'sync-nonce',
  '--network',
  PRESET,
];

async function useRealNonceLogger(
  write: (line: string) => void,
): Promise<void> {
  const actual = await vi.importActual<
    typeof import('../../src/diagnostics/relayer-log.js')
  >('../../src/diagnostics/relayer-log.js');

  const logger = actual.createRelayerLog({
    chainId: CONFIG.chain.id,
    level: 'info',
    errorSummary: ERROR_SUMMARY,
    destination: { write },
  });

  importLogMocks.createRelayerLog.mockReturnValue(logger);
}

describe('sync-nonce argument parsing', () => {
  it.each(NETWORK_CASES)(
    'defaults to preview with $name',
    ({ args, source }) => {
      expect(parseCommandArguments([
        'sync-nonce',
        ...args,
      ])).toEqual({
        command: 'sync-nonce',
        source,
        apply: false,
      });
    },
  );

  it.each(NETWORK_CASES)(
    'accepts --apply before or after $name',
    ({ args, source }) => {
      for (const options of [
        ['--apply', ...args],
        [...args, '--apply'],
      ]) {
        expect(parseCommandArguments([
          'sync-nonce',
          ...options,
        ])).toEqual({
          command: 'sync-nonce',
          source,
          apply: true,
        });
      }
    },
  );

  it.each(NETWORK_FAILURES)(
    'rejects $name',
    ({ args, code }) => {
      expectUsage([
        'sync-nonce',
        ...args,
      ], code);
    },
  );

  it('rejects duplicate --apply', () => {
    expectUsage([
      ...SYNC_ARGS,
      '--apply',
      '--apply',
    ], 'DUPLICATE_APPLY');
  });

  it.each([
    ['--round', '1'],
    ['--apply=false'],
    ['--apply', 'false'],
    ['--unknown'],
  ])('rejects unsupported arguments: %j', (...args) => {
    expectUsage([
      ...SYNC_ARGS,
      ...args,
    ], 'UNKNOWN_ARGUMENT');
  });

  it.each(['--help', '-h'])(
    'preserves help precedence: %s',
    (flag) => {
      expect(parseCommandArguments([
        'sync-nonce',
        '--apply',
        '--apply',
        flag,
      ])).toEqual({
        command: 'help',
      });
    },
  );
});

describe('sync-nonce command execution', () => {
  const outcomes: {
    name: string;
    apply: boolean;
    result: SyncNonceResult;
    outcome: 'success' | 'deferred' | 'failure';
  }[] = [
    {
      name: 'eligible preview',
      apply: false,
      result: NONCE_PREVIEW,
      outcome: 'success',
    },
    {
      name: 'already synchronized preview',
      apply: false,
      result: { status: 'already-synchronized' },
      outcome: 'success',
    },
    {
      name: 'already synchronized apply',
      apply: true,
      result: { status: 'already-synchronized' },
      outcome: 'success',
    },
    {
      name: 'applied repair',
      apply: true,
      result: {
        status: 'applied',
        repair: NONCE_REPAIR,
      },
      outcome: 'success',
    },
    {
      name: 'nonce mismatch',
      apply: true,
      result: {
        status: 'deferred',
        reason: 'nonce-count-mismatch',
      },
      outcome: 'deferred',
    },
    {
      name: 'anchor change',
      apply: true,
      result: {
        status: 'deferred',
        reason: 'anchor-changed',
      },
      outcome: 'deferred',
    },
    {
      name: 'refused repair',
      apply: true,
      result: {
        status: 'refused',
        reason: 'retained-attempts',
      },
      outcome: 'failure',
    },
  ];

  it.each(outcomes)(
    'reports $name with outcome $outcome',
    async ({ apply, result, outcome }) => {
      const lines: string[] = [];
      await useRealNonceLogger((line) => lines.push(line));

      vi.mocked(syncNonce).mockResolvedValueOnce(result);

      const output = vi.fn<(record: CliOutput) => void>();

      expect(await main([
        ...SYNC_ARGS,
        ...(apply ? ['--apply'] : []),
      ], output)).toBe(outcome);

      expect(syncNonce).toHaveBeenCalledExactlyOnceWith({
        publicClient: PUBLIC_CLIENT,
        identity: {
          chainId: CONFIG.chain.id,
          signer: ACCOUNT.address,
        },
        finality: CONFIG.finality,
        apply,
        signal: expect.any(AbortSignal),
      });

      expect(output).toHaveBeenCalledExactlyOnceWith({
        type: 'nonce-sync-result',
        identity: {
          chainId: CONFIG.chain.id,
          signer: ACCOUNT.address,
        },
        mode: apply ? 'apply' : 'preview',
        result,
      });

      const records = lines.map((line) => JSON.parse(line));

      const expectedEvents = ['rpc_usage'];

      if (result.status === 'applied') {
        expectedEvents.unshift('signer_nonce_synced');

        expect(records[0]).toMatchObject({
          level: 40,
          event: 'signer_nonce_synced',
          chainId: CONFIG.chain.id,
          signer: ACCOUNT.address,
          previousNextNonce: '4',
          nextNonce: '8',
          durableBlock: '110',
          durableBlockHash: HASH,
          durableNonce: '8',
          repairAt: NONCE_REPAIR.at,
        });
      }

      expect(records.map((record) => record.event))
        .toEqual(expectedEvents);

      expect(records.at(-1)).toMatchObject({
        level: 30,
        event: 'rpc_usage',
        chainId: CONFIG.chain.id,
        observedAt: expect.any(String),
        report: {
          collectorId: expect.any(String),
          startedAt: expect.any(String),
          cumulative: {
            logical: [],
            http: [],
          },
          interval: {
            available: false,
            reason: 'no-baseline',
          },
        },
      });

      expect(signerRuntimeMocks.openBeaconSubmitter)
        .not.toHaveBeenCalled();
      expect(importQuicknetRound).not.toHaveBeenCalled();
      expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
      expect(runDaemonCommand).not.toHaveBeenCalled();
    },
  );

  it('rejects missing ownership before configuration loading', async () => {
    const failure = new ServiceLockNotHeldError('descriptor');

    vi.mocked(assertServiceLockHeld).mockImplementationOnce(() => {
      throw failure;
    });

    const output = vi.fn();

    await expect(main(SYNC_ARGS, output)).rejects.toBe(failure);

    expect(loadRelayerConfig).not.toHaveBeenCalled();
    expect(syncNonce).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('runs help without ownership or configuration', async () => {
    const output = vi.fn();

    expect(await main([
      'sync-nonce',
      '--help',
    ], output)).toBe('success');

    expect(output).toHaveBeenCalledExactlyOnceWith({ type: 'help' });
    expect(assertServiceLockHeld).not.toHaveBeenCalled();
    expect(loadRelayerConfig).not.toHaveBeenCalled();
    expect(syncNonce).not.toHaveBeenCalled();
  });

  it('emits the repair warning after completion and before output', async () => {
    const events: string[] = [];

    await useRealNonceLogger((line) => {
      events.push(JSON.parse(line).event);
    });

    vi.mocked(syncNonce).mockImplementationOnce(async () => {
      events.push('repair-completed');

      return {
        status: 'applied',
        repair: NONCE_REPAIR,
      };
    });

    expect(await main([
      ...SYNC_ARGS,
      '--apply',
    ], () => {
      events.push('output');
    })).toBe('success');

    expect(events).toEqual([
      'repair-completed',
      'signer_nonce_synced',
      'output',
      'rpc_usage',
    ]);
  });

  it('does not emit a repair warning or result after persistence failure', async () => {
    const lines: string[] = [];
    await useRealNonceLogger((line) => lines.push(line));

    const failure = new Error('Journal persistence failed');
    vi.mocked(syncNonce).mockRejectedValueOnce(failure);

    const output = vi.fn();

    await expect(main([
      ...SYNC_ARGS,
      '--apply',
    ], output)).rejects.toBe(failure);

    expect(lines.map((line) => JSON.parse(line).event))
      .toEqual(['rpc_usage']);
    expect(output).not.toHaveBeenCalled();
  });

  it('preserves an output failure after a committed repair', async () => {
    const lines: string[] = [];
    await useRealNonceLogger((line) => lines.push(line));

    vi.mocked(syncNonce).mockResolvedValueOnce({
      status: 'applied',
      repair: NONCE_REPAIR,
    });

    const failure = new Error('Output failed');

    await expect(main([
      ...SYNC_ARGS,
      '--apply',
    ], () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'signer_nonce_synced',
      'rpc_usage',
    ]);
    expect(syncNonce).toHaveBeenCalledOnce();
  });

  it('reports the committed result when the real logger destination fails', async () => {
    const write = vi.fn(() => {
      throw new Error('Log destination failed');
    });

    await useRealNonceLogger(write);

    vi.mocked(syncNonce).mockResolvedValueOnce({
      status: 'applied',
      repair: NONCE_REPAIR,
    });

    const output = vi.fn();

    expect(await main([
      ...SYNC_ARGS,
      '--apply',
    ], output)).toBe('success');

    expect(write).toHaveBeenCalled();
    expect(output).toHaveBeenCalledExactlyOnceWith({
      type: 'nonce-sync-result',
      identity: {
        chainId: CONFIG.chain.id,
        signer: ACCOUNT.address,
      },
      mode: 'apply',
      result: {
        status: 'applied',
        repair: NONCE_REPAIR,
      },
    });
  });

  it.each(SIGNALS)(
    'returns interrupted for handled %s cancellation',
    async (shutdownSignal) => {
      const lines: string[] = [];
      await useRealNonceLogger((line) => lines.push(line));

      const output = vi.fn();
      const listenersBefore = {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
      };

      vi.mocked(syncNonce).mockImplementationOnce(async ({ signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal);

        process.emit(shutdownSignal);

        signal!.throwIfAborted();
        throw new Error('Expected cancellation.');
      });

      expect(await main(SYNC_ARGS, output)).toBe('interrupted');

      expect(lines.map((line) => JSON.parse(line).event))
        .toEqual(['rpc_usage']);

      expect(output).not.toHaveBeenCalled();
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore.SIGINT);
      expect(process.listenerCount('SIGTERM')).toBe(listenersBefore.SIGTERM);
    },
  );

  it('reports applied when active persistence succeeds after a signal', async () => {
    const lines: string[] = [];
    await useRealNonceLogger((line) => lines.push(line));

    vi.mocked(syncNonce).mockImplementationOnce(async ({ signal }) => {
      process.emit('SIGTERM');

      expect(signal?.aborted).toBe(true);

      return {
        status: 'applied',
        repair: NONCE_REPAIR,
      };
    });

    const output = vi.fn();

    expect(await main([
      ...SYNC_ARGS,
      '--apply',
    ], output)).toBe('success');

    expect(output).toHaveBeenCalledOnce();
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'signer_nonce_synced',
      'rpc_usage',
    ]);
  });

  it('preserves an unrelated failure when a shutdown signal also arrives', async () => {
    const lines: string[] = [];
    await useRealNonceLogger((line) => lines.push(line));

    const failure = new Error('RPC failed');
    const output = vi.fn();

    vi.mocked(syncNonce).mockImplementationOnce(async () => {
      process.emit('SIGTERM');
      throw failure;
    });

    await expect(main(SYNC_ARGS, output)).rejects.toBe(failure);

    expect(lines.map((line) => JSON.parse(line).event))
      .toEqual(['rpc_usage']);

    expect(output).not.toHaveBeenCalled();
  });
});

describe.each(ROUND_COMMANDS)('%s RPC summary', (command) => {
  function operation() {
    if (command === 'import') {
      return vi.mocked(importQuicknetRound);
    }

    return vi.mocked(importQuicknetRoundWhenAvailable);
  }

  function setup() {
    const rpcUsage = vi.fn<(context: RpcUsageLogContext) => void>();
    const loggingFailed = vi.fn();
    const output = vi.fn<(record: CliOutput) => void>();

    importLogMocks.createRelayerLog.mockReturnValue({
      rpcUsage,
      loggingFailed,
    });

    const metrics = createRpcMetrics();
    const measured = metrics.snapshot();
    const capture = vi.fn(() => measured);

    vi.mocked(createRelayerClients).mockReturnValue({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      rpcMetrics: {
        ...metrics,
        snapshot: capture,
      },
    });

    const args = [
      command,
      '--network',
      PRESET,
      '--round',
      ROUND.toString(),
    ];

    return {
      args,
      output,
      rpcUsage,
      loggingFailed,
      capture,
      measured,
    };
  }

  it('reports cumulative usage after preserving the command result', async () => {
    const t = setup();

    await expect(main(t.args, t.output)).resolves.toBe('success');

    expect(t.output).toHaveBeenCalledExactlyOnceWith({
      type: 'import-result',
      round: ROUND,
      result: IMPORTED,
    });

    expect(t.capture).toHaveBeenCalledOnce();
    expect(t.rpcUsage).toHaveBeenCalledOnce();
    expect(t.rpcUsage.mock.calls[0]![0]).toMatchObject({
      observedAt: expect.any(String),
      report: {
        collectorId: t.measured.collectorId,
        startedAt: t.measured.startedAt,
        cumulative: {
          logical: [],
          http: [],
        },
        interval: {
          available: false,
          reason: 'no-baseline',
        },
      },
    });

    expect(t.output.mock.invocationCallOrder[0]!)
      .toBeLessThan(t.rpcUsage.mock.invocationCallOrder[0]!);

    expect(importLogMocks.createRelayerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: process.stderr,
      }),
    );
    expect(t.loggingFailed).not.toHaveBeenCalled();
  });

  it.each(['submitter', 'operation', 'output'] as const)(
    'preserves a failure from %s while reporting cumulative usage',
    async (stage) => {
      const t = setup();
      const failure = new Error('Original command failure');

      switch (stage) {
        case 'submitter':
          signerRuntimeMocks.openBeaconSubmitter
            .mockRejectedValueOnce(failure);
          break;

        case 'operation':
          operation().mockRejectedValueOnce(failure);
          break;

        case 'output':
          t.output.mockImplementationOnce(() => {
            throw failure;
          });
          break;
      }

      await expect(main(t.args, t.output)).rejects.toBe(failure);

      expect(t.capture).toHaveBeenCalledOnce();
      expect(t.rpcUsage).toHaveBeenCalledOnce();
      expect(t.rpcUsage.mock.calls[0]![0].report.interval).toEqual({
        available: false,
        reason: 'no-baseline',
      });
    },
  );

  it('preserves success when summary delivery and diagnostics throw', async () => {
    const t = setup();
    const failure = new Error('Summary delivery failed');

    t.rpcUsage.mockImplementationOnce(() => {
      throw failure;
    });

    t.loggingFailed.mockImplementationOnce(() => {
      throw new Error('Diagnostic delivery failed');
    });

    await expect(main(t.args, t.output)).resolves.toBe('success');

    expect(t.output).toHaveBeenCalledOnce();
    expect(t.loggingFailed).toHaveBeenCalledExactlyOnceWith({
      error: failure,
    });
  });

  it('does not fabricate a summary when client creation fails', async () => {
    const t = setup();
    const failure = new Error('Client creation failed');

    vi.mocked(createRelayerClients).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(main(t.args, t.output)).rejects.toBe(failure);

    expect(t.capture).not.toHaveBeenCalled();
    expect(t.rpcUsage).not.toHaveBeenCalled();
    expect(t.output).not.toHaveBeenCalled();
  });
});