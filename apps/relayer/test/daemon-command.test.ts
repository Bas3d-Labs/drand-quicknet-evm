import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodTestnet } from 'viem/chains';

import {
  verifyRegistryDeployment,
  type RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type { RelayerLog } from '../src/relayer-log.js';

const checkpointLockHandleMocks = vi.hoisted(() => ({
  release: vi.fn(),
}));

const checkpointLockMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
}));

const checkpointStoreMocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

const daemonLoggerMocks = vi.hoisted(() => ({
  onCycle: vi.fn(),
}));

const relayerLogMocks = vi.hoisted(() => ({
  consumerFailed: vi.fn(),
  durableHeadRegressed: vi.fn(),
  checkpointAdvanced: vi.fn(),
  roundImported: vi.fn(),
  roundAlreadyStored: vi.fn(),
  heartbeat: vi.fn(),
  loggingFailed: vi.fn(),
} satisfies RelayerLog));

vi.mock('@based-labs/drand-quicknet-registry', () => ({
  verifyRegistryDeployment: vi.fn(),
}));

vi.mock('../src/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));

vi.mock('../src/daemon-config.js', () => ({
  loadDaemonConfig: vi.fn(),
}));

vi.mock('../src/daemon-logging.js', () => ({
  createDaemonLogger: vi.fn(),
}));

vi.mock('../src/daemon-startup.js', () => ({
  collectDaemonStartupSummary: vi.fn(),
}));

vi.mock('../src/daemon.js', () => ({
  runDaemon: vi.fn(),
}));

vi.mock('../src/relayer-log.js', () => ({
  createRelayerLog: vi.fn(),
}));

vi.mock('../src/validate-consumers.js', () => ({
  validateQuicknetConsumers: vi.fn(),
}));

vi.mock('../src/file-checkpoint-lock.js', () => ({
  FileCheckpointLock: vi.fn(function FileCheckpointLock() {
    return checkpointLockMocks;
  }),
}));

vi.mock('../src/file-checkpoint-store.js', () => ({
  FileCheckpointStore: vi.fn(function FileCheckpointStore() {
    return checkpointStoreMocks;
  }),
}));

import { createRelayerClients } from '../src/clients.js';
import type { ValidatedQuicknetConsumer } from '../src/consumer.js';
import { runDaemonCommand } from '../src/daemon-command.js';

import {
  loadDaemonConfig,
  type DaemonConfig,
} from '../src/daemon-config.js';

import { createDaemonLogger } from '../src/daemon-logging.js';

import {
  collectDaemonStartupSummary,
  type DaemonStartupSummary,
} from '../src/daemon-startup.js';

import { runDaemon } from '../src/daemon.js';
import { FileCheckpointLock } from '../src/file-checkpoint-lock.js';
import { FileCheckpointStore } from '../src/file-checkpoint-store.js';
import { createRelayerLog } from '../src/relayer-log.js';
import { validateQuicknetConsumers } from '../src/validate-consumers.js';

const SOURCE = {
  type: 'preset',
  network: 'robinhood-testnet',
} as const;

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const REGISTRY_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const VERIFIER_ADDRESS: Address =
  '0x5555555555555555555555555555555555555555';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
};

const ACCOUNT = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;

const DAEMON_CONFIG: DaemonConfig = {
  network: 'robinhood-testnet',
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.example.test',
  account: ACCOUNT,
  deployment: DEPLOYMENT,
  finality: { type: 'safe' },
  consumers: [CONSUMER_A, CONSUMER_B],
  startBlock: 123_456n,
  checkpointFile: './state/checkpoint.json',
  maxBlockRange: 2_000n,
  pollIntervalMs: 1_000,
};

const VALIDATED_CONSUMERS: ValidatedQuicknetConsumer[] = [
  {
    address: CONSUMER_A,
    registry: REGISTRY_ADDRESS,
  },
  {
    address: CONSUMER_B,
    registry: REGISTRY_ADDRESS,
  },
];

const STARTUP_SUMMARY: DaemonStartupSummary = {
  network: DAEMON_CONFIG.network,
  chainId: robinhoodTestnet.id,
  rpcOrigin: 'https://rpc.example.test',
  signer: ACCOUNT.address,
  signerBalance: 1_000_000_000_000_000_000n,
  registry: REGISTRY_ADDRESS,
  registryRuntimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  finality: { type: 'safe' },
  latestHead: 124_000n,
  durableHead: 123_900n,
  consumers: [CONSUMER_A, CONSUMER_B],
  checkpointFile: DAEMON_CONFIG.checkpointFile,
  startBlock: 123_456n,
  maxBlockRange: 2_000n,
  pollIntervalMs: 1_000,
  durableNextBlocks: new Map<Address, bigint>(),
};

interface RecordedCalls {
  mock: {
    invocationCallOrder: number[];
  };
}

function firstInvocationOrder(mock: RecordedCalls): number {
  const order = mock.mock.invocationCallOrder[0];

  if (order === undefined) {
    throw new Error('Expected mock to have been called.');
  }

  return order;
}

function expectNotCalled(...mocks: RecordedCalls[]): void {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe('runDaemonCommand', () => {
  beforeEach(() => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(loadDaemonConfig)
      .mockReset()
      .mockResolvedValue(DAEMON_CONFIG);

    vi.mocked(createRelayerLog)
      .mockReset()
      .mockReturnValue(relayerLogMocks);

    vi.mocked(createDaemonLogger)
      .mockReset()
      .mockReturnValue(daemonLoggerMocks);

    vi.mocked(createRelayerClients)
      .mockReset()
      .mockReturnValue({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
      });

    vi.mocked(verifyRegistryDeployment)
      .mockReset()
      .mockResolvedValue(undefined);

    vi.mocked(validateQuicknetConsumers)
      .mockReset()
      .mockResolvedValue(VALIDATED_CONSUMERS);

    vi.mocked(collectDaemonStartupSummary)
      .mockReset()
      .mockResolvedValue(STARTUP_SUMMARY);

    vi.mocked(runDaemon)
      .mockReset()
      .mockResolvedValue(undefined);

    // Preserve the constructor implementations while clearing their calls.
    vi.mocked(FileCheckpointStore).mockClear();
    vi.mocked(FileCheckpointLock).mockClear();

    checkpointStoreMocks.load
      .mockReset()
      .mockResolvedValue(undefined);

    checkpointStoreMocks.save
      .mockReset()
      .mockResolvedValue(undefined);

    checkpointLockMocks.acquire
      .mockReset()
      .mockResolvedValue(checkpointLockHandleMocks);

    checkpointLockHandleMocks.release
      .mockReset()
      .mockResolvedValue(undefined);

    daemonLoggerMocks.onCycle.mockReset();

    for (const mock of Object.values(relayerLogMocks)) {
      mock.mockReset();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('loads daemon configuration for the requested network', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await runDaemonCommand({ source: SOURCE, env });

    expect(loadDaemonConfig).toHaveBeenCalledExactlyOnceWith({
      source: SOURCE,
      env,
    });
  });

  it('omits env when no environment is provided', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(loadDaemonConfig).toHaveBeenCalledExactlyOnceWith({
      source: SOURCE,
    });
  });

  it('creates the relayer logger with chain ID and default level', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      level: 'info',
    });
  });

  it('uses the log level from the supplied environment', async () => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', 'error');

    await runDaemonCommand({
      source: SOURCE,
      env: { QUICKNET_LOG_LEVEL: 'debug' },
    });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      level: 'debug',
    });
  });

  it('uses the process log level when no environment is supplied', async () => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', 'warn');

    await runDaemonCommand({ source: SOURCE });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      level: 'warn',
    });
  });

  it('defaults to info for an explicit environment without a log level', async () => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', 'error');

    await runDaemonCommand({
      source: SOURCE,
      env: {},
    });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      level: 'info',
    });
  });

  it('delegates log-level validation to createRelayerLog', async () => {
    await runDaemonCommand({
      source: SOURCE,
      env: { QUICKNET_LOG_LEVEL: 'invalid-level' },
    });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      level: 'invalid-level',
    });
  });

  it('creates the daemon logger from the relayer logger', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(createDaemonLogger).toHaveBeenCalledExactlyOnceWith({
      logger: relayerLogMocks,
    });
  });

  it('creates relayer clients from the daemon configuration', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(createRelayerClients).toHaveBeenCalledExactlyOnceWith(
      DAEMON_CONFIG,
    );
  });

  it('verifies the configured registry deployment', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(verifyRegistryDeployment).toHaveBeenCalledExactlyOnceWith(
      PUBLIC_CLIENT,
      DEPLOYMENT,
    );
  });

  it('validates the configured consumers', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(validateQuicknetConsumers).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      deployment: DEPLOYMENT,
      consumers: [CONSUMER_A, CONSUMER_B],
    });
  });

  it('creates a checkpoint store for the configured deployment', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(FileCheckpointStore).toHaveBeenCalledExactlyOnceWith({
      filePath: './state/checkpoint.json',
      deployment: DEPLOYMENT,
    });
  });

  it('creates a checkpoint lock for the configured checkpoint file', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(FileCheckpointLock).toHaveBeenCalledExactlyOnceWith({
      checkpointFile: './state/checkpoint.json',
    });
  });

  it('acquires the checkpoint lock', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(checkpointLockMocks.acquire).toHaveBeenCalledOnce();
  });

  it('loads persisted checkpoints for the validated consumers', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(checkpointStoreMocks.load).toHaveBeenCalledTimes(2);
    expect(checkpointStoreMocks.load).toHaveBeenNthCalledWith(
      1,
      CONSUMER_A,
    );
    expect(checkpointStoreMocks.load).toHaveBeenNthCalledWith(
      2,
      CONSUMER_B,
    );
  });

  it('starts the daemon with the validated consumers and configured settings', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(runDaemon).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: checkpointStoreMocks,
      consumers: VALIDATED_CONSUMERS,
      startBlock: 123_456n,
      maxBlockRange: 2_000n,
      finality: { type: 'safe' },
      pollIntervalMs: 1_000,
      onCycle: daemonLoggerMocks.onCycle,
    });
  });

  it('passes a custom network source to daemon configuration', async () => {
    const source = {
      type: 'custom',
      configFile: './networks/example-mainnet.json',
    } as const;

    await runDaemonCommand({ source });

    expect(loadDaemonConfig).toHaveBeenCalledExactlyOnceWith({
      source,
    });
  });

  it('forwards the abort signal to the daemon', async () => {
    const controller = new AbortController();

    await runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
    });

    expect(runDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('does not start later components when configuration loading fails', async () => {
    const failure = new Error('Daemon configuration failed.');
    vi.mocked(loadDaemonConfig).mockRejectedValue(failure);

    await expect(
      runDaemonCommand({ source: SOURCE }),
    ).rejects.toBe(failure);

    expectNotCalled(
      vi.mocked(createRelayerLog),
      vi.mocked(createDaemonLogger),
      vi.mocked(createRelayerClients),
      vi.mocked(verifyRegistryDeployment),
      vi.mocked(validateQuicknetConsumers),
      vi.mocked(FileCheckpointStore),
      vi.mocked(FileCheckpointLock),
      vi.mocked(runDaemon),
      checkpointLockHandleMocks.release,
    );
  });

  it('does not start later components when logger initialization fails', async () => {
    const failure = new Error('Logger initialization failed.');

    vi.mocked(createRelayerLog).mockImplementation(() => {
      throw failure;
    });

    await expect(
      runDaemonCommand({ source: SOURCE }),
    ).rejects.toBe(failure);

    expectNotCalled(
      vi.mocked(createDaemonLogger),
      vi.mocked(createRelayerClients),
      vi.mocked(verifyRegistryDeployment),
      vi.mocked(validateQuicknetConsumers),
      vi.mocked(FileCheckpointStore),
      vi.mocked(FileCheckpointLock),
      vi.mocked(runDaemon),
      checkpointLockHandleMocks.release,
    );
  });

  it('does not validate consumers or start the daemon when deployment verification fails', async () => {
    const failure = new Error('Registry verification failed.');
    vi.mocked(verifyRegistryDeployment).mockRejectedValue(failure);

    await expect(
      runDaemonCommand({ source: SOURCE }),
    ).rejects.toBe(failure);

    expectNotCalled(
      vi.mocked(validateQuicknetConsumers),
      vi.mocked(FileCheckpointStore),
      vi.mocked(FileCheckpointLock),
      vi.mocked(runDaemon),
      checkpointLockHandleMocks.release,
    );
  });

  it('does not create checkpoint components when consumer validation fails', async () => {
    const failure = new Error('Consumer validation failed.');
    vi.mocked(validateQuicknetConsumers).mockRejectedValue(failure);

    await expect(
      runDaemonCommand({ source: SOURCE }),
    ).rejects.toBe(failure);

    expectNotCalled(
      vi.mocked(FileCheckpointStore),
      vi.mocked(FileCheckpointLock),
      vi.mocked(runDaemon),
      checkpointLockHandleMocks.release,
    );
  });

  it('does not load checkpoints or release a lock when acquisition fails', async () => {
    const failure = new Error('Checkpoint lock acquisition failed.');
    checkpointLockMocks.acquire.mockRejectedValue(failure);

    const onStartup = vi.fn();

    await expect(
      runDaemonCommand({ source: SOURCE, onStartup }),
    ).rejects.toBe(failure);

    expectNotCalled(
      checkpointStoreMocks.load,
      vi.mocked(collectDaemonStartupSummary),
      onStartup,
      vi.mocked(runDaemon),
      checkpointLockHandleMocks.release,
    );
  });

  it('releases the lock when checkpoint loading fails', async () => {
    const failure = new Error('Checkpoint loading failed.');
    checkpointStoreMocks.load.mockRejectedValue(failure);

    const onStartup = vi.fn();

    await expect(
      runDaemonCommand({ source: SOURCE, onStartup }),
    ).rejects.toBe(failure);

    expectNotCalled(
      vi.mocked(collectDaemonStartupSummary),
      onStartup,
      vi.mocked(runDaemon),
    );

    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('propagates daemon failures and releases the lock', async () => {
    const failure = new Error('Daemon failed.');
    vi.mocked(runDaemon).mockRejectedValue(failure);

    await expect(
      runDaemonCommand({ source: SOURCE }),
    ).rejects.toBe(failure);

    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('initializes logging before creating clients or acquiring the lock', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(
      firstInvocationOrder(vi.mocked(createRelayerLog)),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(createDaemonLogger)),
    );

    expect(
      firstInvocationOrder(vi.mocked(createDaemonLogger)),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(createRelayerClients)),
    );

    expect(
      firstInvocationOrder(vi.mocked(createRelayerLog)),
    ).toBeLessThan(
      firstInvocationOrder(checkpointLockMocks.acquire),
    );
  });

  it.each([
    [
      'verifies deployment before validating consumers',
      vi.mocked(verifyRegistryDeployment),
      vi.mocked(validateQuicknetConsumers),
    ],
    [
      'validates consumers before creating the store',
      vi.mocked(validateQuicknetConsumers),
      vi.mocked(FileCheckpointStore),
    ],
    [
      'creates the store before creating the lock',
      vi.mocked(FileCheckpointStore),
      vi.mocked(FileCheckpointLock),
    ],
    [
      'acquires the lock before loading checkpoints',
      checkpointLockMocks.acquire,
      checkpointStoreMocks.load,
    ],
    [
      'creates the store before starting the daemon',
      vi.mocked(FileCheckpointStore),
      vi.mocked(runDaemon),
    ],
  ] as const)('%s', async (_name, earlier, later) => {
    await runDaemonCommand({ source: SOURCE });

    expect(firstInvocationOrder(earlier)).toBeLessThan(
      firstInvocationOrder(later),
    );
  });

  it('passes daemon cycle results to the daemon logger', async () => {
    const cycle = { consumers: [] };

    vi.mocked(runDaemon).mockImplementation(async ({ onCycle }) => {
      onCycle?.(cycle);
    });

    await runDaemonCommand({ source: SOURCE });

    expect(daemonLoggerMocks.onCycle).toHaveBeenCalledExactlyOnceWith(
      cycle,
    );
  });

  it('collects and forwards the startup summary without printing it', async () => {
    const onStartup = vi.fn();

    await runDaemonCommand({
      source: SOURCE,
      onStartup,
    });

    expect(collectDaemonStartupSummary).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      config: DAEMON_CONFIG,
      durableNextBlocks: new Map(),
    });

    expect(onStartup).toHaveBeenCalledExactlyOnceWith(STARTUP_SUMMARY);
    expect(console.log).not.toHaveBeenCalled();

    expect(
      firstInvocationOrder(checkpointLockMocks.acquire),
    ).toBeLessThan(
      firstInvocationOrder(onStartup),
    );

    expect(
      firstInvocationOrder(onStartup),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(runDaemon)),
    );
  });

  it('includes persisted consumer checkpoints in the startup summary', async () => {
    checkpointStoreMocks.load
      .mockResolvedValueOnce(123_500n)
      .mockResolvedValueOnce(123_600n);

    await runDaemonCommand({ source: SOURCE });

    expect(collectDaemonStartupSummary).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      config: DAEMON_CONFIG,
      durableNextBlocks: new Map([
        [CONSUMER_A, 123_500n],
        [CONSUMER_B, 123_600n],
      ]),
    });
  });

  it('preserves a zero checkpoint and omits a missing checkpoint', async () => {
    checkpointStoreMocks.load
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(undefined);

    await runDaemonCommand({ source: SOURCE });

    expect(collectDaemonStartupSummary).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      config: DAEMON_CONFIG,
      durableNextBlocks: new Map([
        [CONSUMER_A, 0n],
      ]),
    });
  });

  it('starts without printing when no startup callback is supplied', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(collectDaemonStartupSummary).toHaveBeenCalledOnce();
    expect(runDaemon).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('releases the lock when startup summary collection fails', async () => {
    const failure = new Error('Startup summary failed.');

    vi.mocked(collectDaemonStartupSummary).mockRejectedValue(failure);

    const onStartup = vi.fn();

    await expect(
      runDaemonCommand({ source: SOURCE, onStartup }),
    ).rejects.toBe(failure);

    expectNotCalled(
      onStartup,
      vi.mocked(runDaemon),
    );

    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('preserves startup callback failure and releases the lock', async () => {
    const failure = new Error('Startup output failed.');

    const onStartup = vi.fn(() => {
      throw failure;
    });

    await expect(
      runDaemonCommand({ source: SOURCE, onStartup }),
    ).rejects.toBe(failure);

    expect(onStartup).toHaveBeenCalledExactlyOnceWith(STARTUP_SUMMARY);
    expect(runDaemon).not.toHaveBeenCalled();
    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('holds the lock until the daemon finishes', async () => {
    let notifyStarted: () => void = () => {};
    let finishDaemon: () => void = () => {};

    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const finished = new Promise<void>((resolve) => {
      finishDaemon = resolve;
    });

    vi.mocked(runDaemon).mockImplementation(async () => {
      notifyStarted();
      await finished;
    });

    const pending = runDaemonCommand({ source: SOURCE });

    try {
      // A startup failure must reject here rather than leave this test waiting.
      await Promise.race([started, pending]);

      expect(runDaemon).toHaveBeenCalledOnce();
      expect(checkpointLockHandleMocks.release).not.toHaveBeenCalled();
    } finally {
      finishDaemon();
      await pending;
    }

    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });
});