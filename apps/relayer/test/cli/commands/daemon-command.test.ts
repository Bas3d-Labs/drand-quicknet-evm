import {
  performance,
} from 'node:perf_hooks';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type {
  Address,
  Hex,
  PublicClient,
  WalletClient
} from 'viem';

import {
  privateKeyToAccount
} from 'viem/accounts';

import {
  robinhoodTestnet
} from 'viem/chains';

import {
  verifyRegistryDeployment,
  type RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  OpenBeaconSubmitterOptions,
} from '../../../src/cli/open-beacon-submitter.js';

import type {
  ScopedRelayerLog
} from '../../../src/diagnostics/relayer-log.js';

import type {
  BeaconSubmitter,
} from '../../../src/rounds/create-beacon-submitter.js';

import {
  isUuidV4,
} from '../../../src/shared/uuid.js';

import type {
  SignerRuntimeObservation,
} from '../../../src/state/read-signer-runtime-observation.js';

import {
  writeDaemonStatusFile,
} from '../../../src/state/file-daemon-status-store.js';

const signerRuntimeMocks = vi.hoisted(() => ({
  openBeaconSubmitter: vi.fn(),
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
  rpcUsage: vi.fn(),
  loggingFailed: vi.fn(),
  durableFulfillmentPending: vi.fn(),
  durableFulfillmentUnavailable: vi.fn(),
  durableAnchorChanged: vi.fn(),
  durableAnchorUnavailable: vi.fn(),
  attemptBroadcastAccepted: vi.fn(),
  attemptBroadcastNotAcknowledged: vi.fn(),
  attemptResolved: vi.fn(),
  roundDeferred: vi.fn(),
  roundPending: vi.fn(),
  signerBlocked: vi.fn(),
  signerBootstrapDeferred: vi.fn(),
  signerGateReleased: vi.fn(),
  signerNonceSynced: vi.fn(),
  statusPublicationFailed: vi.fn(),

  withContext: 
    vi.fn<ScopedRelayerLog['withContext']>(),
  withErrorSummary:
    vi.fn<ScopedRelayerLog['withErrorSummary']>(),
} satisfies ScopedRelayerLog));

vi.mock('@based-labs/drand-quicknet-registry', () => ({
  verifyRegistryDeployment: vi.fn(),
}));

vi.mock('../../../src/chain/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));

vi.mock(
  '../../../src/cli/open-beacon-submitter.js',
  () => signerRuntimeMocks,
);

vi.mock('../../../src/config/daemon-config.js', () => ({
  loadDaemonConfig: vi.fn(),
}));

vi.mock('../../../src/daemon/daemon-logging.js', () => ({
  createDaemonLogger: vi.fn(),
}));

vi.mock('../../../src/daemon/daemon-startup.js', () => ({
  collectDaemonStartupSummary: vi.fn(),
}));

vi.mock('../../../src/daemon/daemon.js', () => ({
  runDaemon: vi.fn(),
}));

vi.mock('../../../src/diagnostics/relayer-log.js', () => ({
  createRelayerLog: vi.fn(),
}));

vi.mock('../../../src/consumers/validate-consumers.js', () => ({
  validateQuicknetConsumers: vi.fn(),
}));

vi.mock('../../../src/state/service-lock.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/state/service-lock.js')
  >();

  return {
    ...actual,
    assertServiceLockHeld: vi.fn(),
  };
});

vi.mock('../../../src/state/file-checkpoint-store.js', () => ({
  FileCheckpointStore: {
    open: vi.fn(async () => checkpointStoreMocks),
  },
}));

vi.mock('../../../src/state/file-daemon-status-store.js', () => ({
  writeDaemonStatusFile: vi.fn(),
}));

import {
  join,
  resolve,
} from 'node:path';

import {
  createRelayerClients
} from '../../../src/chain/clients.js';

import type {
  ValidatedQuicknetConsumer
} from '../../../src/consumers/consumer.js';

import {
  runDaemonCommand
} from '../../../src/cli/commands/daemon-command.js';

import {
  loadDaemonConfig,
  type DaemonConfig,
} from '../../../src/config/daemon-config.js';

import {
  createDaemonLogger
} from '../../../src/daemon/daemon-logging.js';

import {
  collectDaemonStartupSummary,
  type DaemonStartupSummary,
} from '../../../src/daemon/daemon-startup.js';

import {
  runDaemon
} from '../../../src/daemon/daemon.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from '../../../src/state/service-lock.js';

import {
  FileCheckpointStore
} from '../../../src/state/file-checkpoint-store.js';

import {
  createRelayerLog
} from '../../../src/diagnostics/relayer-log.js';

import {
  createRpcMetrics,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  validateQuicknetConsumers
} from '../../../src/consumers/validate-consumers.js';

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
  receiptTimeoutMs: 45_000,
};

const VERIFIED_STATE_DIRECTORY = resolve(
  'verified-state-directory',
);

const VERIFIED_CHECKPOINT_FILE = join(
  VERIFIED_STATE_DIRECTORY,
  'checkpoint.json',
);

const VERIFIED_DAEMON_CONFIG: DaemonConfig = {
  ...DAEMON_CONFIG,
  checkpointFile: VERIFIED_CHECKPOINT_FILE,
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
  checkpointFile: VERIFIED_CHECKPOINT_FILE,
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
  let submitter: BeaconSubmitter;

  function enableStatusObservation(): void {
    const observation: SignerRuntimeObservation = {
      journalInitialized: true,
      status: {
        open: true,
        primaryReason: null,
        blockers: [],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
        blockedSince: null,
      },
      attempts: [],
    };

    signerRuntimeMocks.openBeaconSubmitter.mockImplementationOnce(
      async (options: OpenBeaconSubmitterOptions) => {
        options.onRecoveryCompleted?.({
          retryDelayMs: null,
        });

        options.onInitialized?.(() => observation);

        return submitter;
      },
    );
  }

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
        rpcMetrics: createRpcMetrics(),
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

    vi.mocked(assertServiceLockHeld)
      .mockReset()
      .mockReturnValue({
        stateDirectory: VERIFIED_STATE_DIRECTORY,
        dev: 1n,
        ino: 2n,
      });

    vi.mocked(FileCheckpointStore.open).mockClear();

    vi.mocked(writeDaemonStatusFile)
      .mockReset()
      .mockResolvedValue(undefined);

    checkpointStoreMocks.load
      .mockReset()
      .mockResolvedValue(undefined);

    checkpointStoreMocks.save
      .mockReset()
      .mockResolvedValue(undefined);

    daemonLoggerMocks.onCycle.mockReset();

    for (const mock of Object.values(relayerLogMocks)) {
      mock.mockReset();
    }

    relayerLogMocks.withErrorSummary
      .mockReturnValue(relayerLogMocks);

    relayerLogMocks.withContext
      .mockReturnValue(relayerLogMocks);

    submitter = {
      recover: vi.fn<BeaconSubmitter['recover']>(),
      submit: vi.fn<BeaconSubmitter['submit']>(),
    };

    signerRuntimeMocks.openBeaconSubmitter
      .mockReset()
      .mockResolvedValue(submitter);
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

    expect(assertServiceLockHeld).toHaveBeenCalledTimes(2);

    expect(assertServiceLockHeld).toHaveBeenNthCalledWith(1, {
      env,
    });

    expect(assertServiceLockHeld).toHaveBeenNthCalledWith(2, {
      env,
      checkpointFile: resolve(DAEMON_CONFIG.checkpointFile),
    });
  });

  it('uses the process environment when none is provided', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(loadDaemonConfig).toHaveBeenCalledExactlyOnceWith({
      source: SOURCE,
      env: process.env,
    });

    expect(assertServiceLockHeld).toHaveBeenCalledTimes(2);

    expect(assertServiceLockHeld).toHaveBeenNthCalledWith(1, {
      env: process.env,
    });

    expect(assertServiceLockHeld).toHaveBeenNthCalledWith(2, {
      env: process.env,
      checkpointFile: resolve(DAEMON_CONFIG.checkpointFile),
    });
  });

  it('creates the relayer logger with chain ID and default level', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      runId: expect.any(String),
      level: 'info',
      errorSummary: undefined,
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
      runId: expect.any(String),
      level: 'debug',
      errorSummary: undefined,
    });
  });

  it('uses the process log level when no environment is supplied', async () => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', 'warn');

    await runDaemonCommand({ source: SOURCE });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      runId: expect.any(String),
      level: 'warn',
      errorSummary: undefined,
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
      runId: expect.any(String),
      level: 'info',
      errorSummary: undefined,
    });
  });

  it('delegates log-level validation to createRelayerLog', async () => {
    await runDaemonCommand({
      source: SOURCE,
      env: { QUICKNET_LOG_LEVEL: 'invalid-level' },
    });

    expect(createRelayerLog).toHaveBeenCalledExactlyOnceWith({
      chainId: robinhoodTestnet.id,
      runId: expect.any(String),
      level: 'invalid-level',
      errorSummary: undefined,
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
      VERIFIED_DAEMON_CONFIG,
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

  it('opens a checkpoint store for the configured deployment', async () => {
    await runDaemonCommand({ source: SOURCE });

    expect(FileCheckpointStore.open).toHaveBeenCalledExactlyOnceWith({
      filePath: VERIFIED_CHECKPOINT_FILE,
      deployment: DEPLOYMENT,
    });
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

    expect(signerRuntimeMocks.openBeaconSubmitter)
      .toHaveBeenCalledExactlyOnceWith({
        config: VERIFIED_DAEMON_CONFIG,
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        log: relayerLogMocks,
        readChainHeads: expect.any(Function),
        maxBlockRange: 2_000n,
        checkpointFile: VERIFIED_DAEMON_CONFIG.checkpointFile,
        startupPollIntervalMs: VERIFIED_DAEMON_CONFIG.pollIntervalMs,
        onInitialized: expect.any(Function),
        onRecoveryCompleted: expect.any(Function),
        signal: undefined,
        env: process.env,
      });

    const openedWith =
      signerRuntimeMocks.openBeaconSubmitter.mock.calls[0]![0];

    expect(runDaemon).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      account: ACCOUNT,
      submitter,
      readChainHeads: openedWith.readChainHeads,
      deployment: DEPLOYMENT,
      checkpointStore: checkpointStoreMocks,
      consumers: VALIDATED_CONSUMERS,
      startBlock: 123_456n,
      maxBlockRange: 2_000n,
      finality: { type: 'safe' },
      pollIntervalMs: 1_000,
      receiptTimeoutMs: 45_000,
      onCycle: expect.any(Function),
    });

    const daemonOptions = vi.mocked(runDaemon).mock.calls[0]![0];

    expect(daemonOptions.submitter).toBe(submitter);
    expect(daemonOptions.readChainHeads)
      .toBe(openedWith.readChainHeads);
  });

  it('passes a custom network source to daemon configuration', async () => {
    const source = {
      type: 'custom',
      configFile: './networks/example-mainnet.json',
    } as const;

    await runDaemonCommand({ source });

    expect(loadDaemonConfig).toHaveBeenCalledExactlyOnceWith({
      source,
      env: process.env,
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

    expect(signerRuntimeMocks.openBeaconSubmitter)
      .toHaveBeenCalledWith(
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

    expect(assertServiceLockHeld).toHaveBeenCalledExactlyOnceWith({
      env: process.env,
    });

    expectNotCalled(
      vi.mocked(createRelayerLog),
      vi.mocked(createDaemonLogger),
      vi.mocked(createRelayerClients),
      vi.mocked(verifyRegistryDeployment),
      vi.mocked(validateQuicknetConsumers),
      vi.mocked(FileCheckpointStore.open),
      vi.mocked(runDaemon),
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
      vi.mocked(FileCheckpointStore.open),
      vi.mocked(runDaemon),
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
      vi.mocked(FileCheckpointStore.open),
      vi.mocked(runDaemon),
    );
  });

  it('does not create checkpoint components when consumer validation fails', async () => {
    const failure = new Error('Consumer validation failed.');
    vi.mocked(validateQuicknetConsumers).mockRejectedValue(failure);

    await expect(
      runDaemonCommand({ source: SOURCE }),
    ).rejects.toBe(failure);

    expectNotCalled(
      vi.mocked(FileCheckpointStore.open),
      vi.mocked(runDaemon),
    );
  });

  it('preserves checkpoint loading failure', async () => {
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
  });

  it('propagates daemon failures', async () => {
    const failure = new Error('Daemon failed.');
    vi.mocked(runDaemon).mockRejectedValue(failure);

    await expect(
      runDaemonCommand({ source: SOURCE }),
    ).rejects.toBe(failure);
  });

  it('verifies ownership before configuration and placement before logging', async () => {
    await runDaemonCommand({ source: SOURCE });

    const verification = vi.mocked(assertServiceLockHeld);

    expect(verification).toHaveBeenCalledTimes(2);

    const first = verification.mock.invocationCallOrder[0];
    const second = verification.mock.invocationCallOrder[1];

    if (first === undefined || second === undefined) {
      throw new Error('Expected both service-lock checks.');
    }

    expect(first).toBeLessThan(
      firstInvocationOrder(vi.mocked(loadDaemonConfig)),
    );

    expect(
      firstInvocationOrder(vi.mocked(loadDaemonConfig)),
    ).toBeLessThan(second);

    expect(second).toBeLessThan(
      firstInvocationOrder(vi.mocked(createRelayerLog)),
    );

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
  });

  it.each([
    [
      'verifies deployment before validating consumers',
      vi.mocked(verifyRegistryDeployment),
      vi.mocked(validateQuicknetConsumers),
    ],
    [
      'validates consumers before opening the store',
      vi.mocked(validateQuicknetConsumers),
      vi.mocked(FileCheckpointStore.open),
    ],
    [
      'verifies ownership before opening the store',
      vi.mocked(assertServiceLockHeld),
      vi.mocked(FileCheckpointStore.open),
    ],
    [
      'opens the store before loading checkpoints',
      vi.mocked(FileCheckpointStore.open),
      checkpointStoreMocks.load,
    ],
    [
      'opens the store before starting the daemon',
      vi.mocked(FileCheckpointStore.open),
      vi.mocked(runDaemon),
    ],
  ] as const)('%s', async (_name, earlier, later) => {
    await runDaemonCommand({ source: SOURCE });

    expect(firstInvocationOrder(earlier)).toBeLessThan(
      firstInvocationOrder(later),
    );
  });

  it.each([
    'platform',
    'state-directory',
    'lock-file',
    'descriptor',
  ] as const)(
    'stops before initialization when service verification fails: %s',
    async (reason) => {
      const failure = new ServiceLockNotHeldError(reason);

      vi.mocked(assertServiceLockHeld).mockImplementationOnce(() => {
        throw failure;
      });

      const onStartup = vi.fn();

      await expect(
        runDaemonCommand({
          source: SOURCE,
          onStartup,
        }),
      ).rejects.toBe(failure);

      expect(loadDaemonConfig).not.toHaveBeenCalled();

      expect(assertServiceLockHeld).toHaveBeenCalledExactlyOnceWith({
        env: process.env,
      });

      expectNotCalled(
        vi.mocked(createRelayerLog),
        vi.mocked(createDaemonLogger),
        vi.mocked(createRelayerClients),
        vi.mocked(verifyRegistryDeployment),
        vi.mocked(validateQuicknetConsumers),
        vi.mocked(FileCheckpointStore.open),
        checkpointStoreMocks.load,
        checkpointStoreMocks.save,
        vi.mocked(collectDaemonStartupSummary),
        onStartup,
        vi.mocked(runDaemon),
      );
  });

  it('stops initialization when checkpoint placement verification fails', async () => {
    const failure = new ServiceLockNotHeldError('state-directory');

    vi.mocked(assertServiceLockHeld)
      .mockReturnValueOnce({
        stateDirectory: VERIFIED_STATE_DIRECTORY,
        dev: 1n,
        ino: 2n,
      })
      .mockImplementationOnce(() => {
        throw failure;
      });

    const onStartup = vi.fn();

    await expect(
      runDaemonCommand({
        source: SOURCE,
        onStartup,
      }),
    ).rejects.toBe(failure);

    expect(loadDaemonConfig).toHaveBeenCalledOnce();

    expect(assertServiceLockHeld).toHaveBeenCalledTimes(2);

    expect(assertServiceLockHeld).toHaveBeenNthCalledWith(1, {
      env: process.env,
    });

    expect(assertServiceLockHeld).toHaveBeenNthCalledWith(2, {
      env: process.env,
      checkpointFile: resolve(DAEMON_CONFIG.checkpointFile),
    });

    expectNotCalled(
      vi.mocked(createRelayerLog),
      vi.mocked(createDaemonLogger),
      vi.mocked(createRelayerClients),
      vi.mocked(verifyRegistryDeployment),
      vi.mocked(validateQuicknetConsumers),
      vi.mocked(FileCheckpointStore.open),
      checkpointStoreMocks.load,
      checkpointStoreMocks.save,
      vi.mocked(collectDaemonStartupSummary),
      onStartup,
      vi.mocked(runDaemon),
    );
  });

  it('passes daemon cycle results to the daemon logger', async () => {
    const cycle = {
      consumers: [],
    };

    vi.mocked(runDaemon).mockImplementation(async ({ onCycle }) => {
      await onCycle?.(cycle, { cycle: 1 });
    });

    await runDaemonCommand({ source: SOURCE });

    expect(daemonLoggerMocks.onCycle).toHaveBeenCalledExactlyOnceWith(
      cycle,
      relayerLogMocks,
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
      config: VERIFIED_DAEMON_CONFIG,
      durableNextBlocks: new Map(),
    });

    expect(onStartup).toHaveBeenCalledExactlyOnceWith(STARTUP_SUMMARY);
    expect(console.log).not.toHaveBeenCalled();

    expect(
      firstInvocationOrder(vi.mocked(assertServiceLockHeld)),
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
      config: VERIFIED_DAEMON_CONFIG,
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
      config: VERIFIED_DAEMON_CONFIG,
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

  it('preserves startup summary collection failure', async () => {
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
  });

  it('preserves startup callback failure', async () => {
    const failure = new Error('Startup output failed.');

    const onStartup = vi.fn(() => {
      throw failure;
    });

    await expect(
      runDaemonCommand({ source: SOURCE, onStartup }),
    ).rejects.toBe(failure);

    expect(onStartup).toHaveBeenCalledExactlyOnceWith(STARTUP_SUMMARY);
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('awaits daemon completion after shutdown is requested', async () => {
    let notifyStarted: () => void = () => {};
    let finishDaemon: () => void = () => {};

    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const finished = new Promise<void>((resolve) => {
      finishDaemon = resolve;
    });

    const controller = new AbortController();

    vi.mocked(runDaemon).mockImplementation(async ({ signal }) => {
      expect(signal).toBe(controller.signal);

      notifyStarted();
      await finished;
    });

    let commandFinished = false;

    const pending = runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
    }).finally(() => {
      commandFinished = true;
    });

    try {
      await Promise.race([started, pending]);

      expect(runDaemon).toHaveBeenCalledOnce();

      controller.abort();
      await Promise.resolve();

      expect(controller.signal.aborted).toBe(true);
      expect(commandFinished).toBe(false);
    } finally {
      finishDaemon();
      await pending;
    }

    expect(commandFinished).toBe(true);
  });

  it('installs the same policy before logger creation and startup RPC work', async () => {
    const policy = {
      scrubText: (text: string) => ({ text, removed: false }),
    };

    vi.mocked(loadDaemonConfig).mockImplementation(async (options) => {
      options.onDiagnostics?.(policy);

      return {
        ...DAEMON_CONFIG,
        errorSummary: policy,
      };
    });

    const onDiagnostics = vi.fn();

    vi.mocked(createRelayerLog).mockImplementation((options) => {
      expect(onDiagnostics).toHaveBeenCalledExactlyOnceWith(policy);
      expect(options.errorSummary).toBe(policy);

      return relayerLogMocks;
    });

    const failure = new Error('public rate limit exceeded');
    vi.mocked(verifyRegistryDeployment).mockRejectedValue(failure);

    await expect(
      runDaemonCommand({ source: SOURCE, onDiagnostics }),
    ).rejects.toBe(failure);

    expect(onDiagnostics).toHaveBeenCalledExactlyOnceWith(policy);
  });

  it('does not install a policy when daemon loading fails before the callback', async () => {
    vi.mocked(loadDaemonConfig).mockRejectedValue(
      new Error('invalid daemon configuration'),
    );

    const onDiagnostics = vi.fn();

    await expect(
      runDaemonCommand({ source: SOURCE, onDiagnostics }),
    ).rejects.toThrow('invalid daemon configuration');

    expect(onDiagnostics).not.toHaveBeenCalled();
  });

  it('stops startup when opening the checkpoint store fails', async () => {
    const failure = new Error('Checkpoint store opening failed.');

    vi.mocked(FileCheckpointStore.open)
      .mockRejectedValueOnce(failure);

    const onStartup = vi.fn();

    await expect(
      runDaemonCommand({
        source: SOURCE,
        onStartup,
      }),
    ).rejects.toBe(failure);

    expectNotCalled(
      checkpointStoreMocks.load,
      checkpointStoreMocks.save,
      vi.mocked(collectDaemonStartupSummary),
      onStartup,
      vi.mocked(runDaemon),
    );
  });

  it('passes a signer and cycle scoped logger to the cycle reporter', async () => {
    await runDaemonCommand({ source: SOURCE });

    const options = vi.mocked(runDaemon).mock.calls[0]![0];

    const child = {
      ...relayerLogMocks,
    };

    relayerLogMocks.withContext.mockReturnValueOnce(child);

    const result = {
      consumers: [],
    };

    await options.onCycle!(result, { cycle: 7 });

    expect(relayerLogMocks.withContext).toHaveBeenCalledExactlyOnceWith({
      cycle: 7,
      signer: ACCOUNT.address,
    });

    expect(daemonLoggerMocks.onCycle)
      .toHaveBeenCalledExactlyOnceWith(result, child);
  });

  it('stops startup when opening the signer runtime fails', async () => {
    const failure = new Error('Signer runtime opening failed.');

    signerRuntimeMocks.openBeaconSubmitter
      .mockRejectedValueOnce(failure);

    const onStartup = vi.fn();

    await expect(
      runDaemonCommand({
        source: SOURCE,
        onStartup,
      }),
    ).rejects.toBe(failure);

    expect(signerRuntimeMocks.openBeaconSubmitter)
      .toHaveBeenCalledOnce();

    expectNotCalled(
      vi.mocked(FileCheckpointStore.open),
      checkpointStoreMocks.load,
      vi.mocked(collectDaemonStartupSummary),
      onStartup,
      vi.mocked(runDaemon),
    );
  });

  it('does not open checkpoints until the signer startup wait completes', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });

    signerRuntimeMocks.openBeaconSubmitter
      .mockImplementationOnce(async () => {
        await waiting;
        return submitter;
      });

    const onStartup = vi.fn();

    const pending = runDaemonCommand({
      source: SOURCE,
      onStartup,
    });

    try {
      await vi.waitFor(() => {
        expect(signerRuntimeMocks.openBeaconSubmitter)
          .toHaveBeenCalledOnce();
      });

      expectNotCalled(
        vi.mocked(FileCheckpointStore.open),
        checkpointStoreMocks.load,
        vi.mocked(collectDaemonStartupSummary),
        onStartup,
        vi.mocked(runDaemon),
      );
    } finally {
      release();
      await pending;
    }

    expect(FileCheckpointStore.open).toHaveBeenCalledOnce();
    expect(onStartup).toHaveBeenCalledOnce();
    expect(runDaemon).toHaveBeenCalledOnce();
  });

  it('does not create checkpoints when signer startup is cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('Startup cancelled');
    const onStartup = vi.fn();

    signerRuntimeMocks.openBeaconSubmitter
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw reason;
      });

    await expect(runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
      onStartup,
    })).rejects.toBe(reason);

    expect(
      signerRuntimeMocks.openBeaconSubmitter.mock.calls[0]![0].signal,
    ).toBe(controller.signal);

    expectNotCalled(
      vi.mocked(FileCheckpointStore.open),
      checkpointStoreMocks.load,
      checkpointStoreMocks.save,
      vi.mocked(collectDaemonStartupSummary),
      onStartup,
      vi.mocked(runDaemon),
    );
  });

  it('stops before ownership verification when already cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('Startup cancelled');
    const onStartup = vi.fn();

    controller.abort(reason);

    await expect(runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
      onStartup,
    })).rejects.toBe(reason);

    expectNotCalled(
      vi.mocked(assertServiceLockHeld),
      vi.mocked(loadDaemonConfig),
      vi.mocked(createRelayerLog),
      signerRuntimeMocks.openBeaconSubmitter,
      vi.mocked(FileCheckpointStore.open),
      onStartup,
      vi.mocked(runDaemon),
    );
  });

  it.each([
    'configuration',
    'deployment',
    'consumers',
    'signer',
    'checkpoint-open',
    'checkpoint-load',
    'summary',
  ] as const)(
    'stops after %s completes when cancellation was requested',
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error('Startup cancelled');
      const onStartup = vi.fn();

      switch (stage) {
        case 'configuration':
          vi.mocked(loadDaemonConfig).mockImplementationOnce(async () => {
            controller.abort(reason);
            return DAEMON_CONFIG;
          });
          break;

        case 'deployment':
          vi.mocked(verifyRegistryDeployment)
            .mockImplementationOnce(async () => {
              controller.abort(reason);
            });
          break;

        case 'consumers':
          vi.mocked(validateQuicknetConsumers)
            .mockImplementationOnce(async () => {
              controller.abort(reason);
              return VALIDATED_CONSUMERS;
            });
          break;

        case 'signer':
          signerRuntimeMocks.openBeaconSubmitter
            .mockImplementationOnce(async () => {
              controller.abort(reason);
              return submitter;
            });
          break;

        case 'checkpoint-open':
          // Preserve the existing fixture's correctly typed store result.
          vi.mocked(FileCheckpointStore.open)
            .mockImplementationOnce(async (...args) => {
              const store = await FileCheckpointStore.open(...args);
              controller.abort(reason);
              return store;
            });
          break;

        case 'checkpoint-load':
          checkpointStoreMocks.load.mockImplementationOnce(async () => {
            controller.abort(reason);
            return 123_500n;
          });
          break;

        case 'summary':
          vi.mocked(collectDaemonStartupSummary)
            .mockImplementationOnce(async () => {
              controller.abort(reason);
              return STARTUP_SUMMARY;
            });
          break;
      }

      await expect(runDaemonCommand({
        source: SOURCE,
        signal: controller.signal,
        onStartup,
      })).rejects.toBe(reason);

      expectNotCalled(onStartup, vi.mocked(runDaemon));

      switch (stage) {
        case 'configuration':
          expect(createRelayerLog).not.toHaveBeenCalled();
          expect(verifyRegistryDeployment).not.toHaveBeenCalled();
          break;

        case 'deployment':
          expect(validateQuicknetConsumers).not.toHaveBeenCalled();
          break;

        case 'consumers':
          expect(signerRuntimeMocks.openBeaconSubmitter)
            .not.toHaveBeenCalled();
          break;

        case 'signer':
          expect(FileCheckpointStore.open).not.toHaveBeenCalled();
          break;

        case 'checkpoint-open':
          expect(checkpointStoreMocks.load).not.toHaveBeenCalled();
          break;

        case 'checkpoint-load':
          expect(checkpointStoreMocks.load)
            .toHaveBeenCalledExactlyOnceWith(CONSUMER_A);
          expect(collectDaemonStartupSummary).not.toHaveBeenCalled();
          break;

        case 'summary':
          expect(collectDaemonStartupSummary).toHaveBeenCalledOnce();
          break;
      }
    },
  );

  it('does not enter the daemon when the startup callback cancels', async () => {
    const controller = new AbortController();
    const reason = new Error('Startup cancelled');

    const onStartup = vi.fn(() => {
      controller.abort(reason);
    });

    await expect(runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
      onStartup,
    })).rejects.toBe(reason);

    expect(onStartup).toHaveBeenCalledExactlyOnceWith(STARTUP_SUMMARY);
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('preserves a deployment failure after cancellation is requested', async () => {
    const controller = new AbortController();
    const reason = new Error('Startup cancelled');
    const failure = new Error('Deployment verification failed.');

    vi.mocked(verifyRegistryDeployment)
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw failure;
      });

    await expect(runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
    })).rejects.toBe(failure);

    expectNotCalled(
      vi.mocked(validateQuicknetConsumers),
      signerRuntimeMocks.openBeaconSubmitter,
      vi.mocked(FileCheckpointStore.open),
      vi.mocked(runDaemon),
    );
  });

  it('publishes startup and cycle snapshots with the logger run ID', async () => {
    enableStatusObservation();

    vi.mocked(runDaemon).mockImplementationOnce(async ({ onCycle }) => {
      await onCycle?.({ consumers: [] }, { cycle: 1 });
    });

    await runDaemonCommand({ source: SOURCE });

    expect(writeDaemonStatusFile).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(writeDaemonStatusFile).mock.calls;
    const startup = calls[0]![0];
    const completed = calls[1]![0];

    const loggerOptions =
      vi.mocked(createRelayerLog).mock.calls[0]![0];

    expect(isUuidV4(loggerOptions.runId)).toBe(true);
    expect(startup.snapshot.runId).toBe(loggerOptions.runId);
    expect(completed.snapshot.runId).toBe(loggerOptions.runId);

    expect(startup.identity).toEqual({
      chainId: DAEMON_CONFIG.chain.id,
      signer: ACCOUNT.address,
    });

    expect(startup.env?.QUICKNET_STATE_DIR)
      .toBe(VERIFIED_STATE_DIRECTORY);

    expect(startup.snapshot.lastCompletedCycle).toBeNull();

    expect(startup.snapshot.lastRetryObservation).toEqual({
      observedAt: expect.any(String),
      retryDelayMs: null,
    });

    expect(completed.snapshot.lastCompletedCycle).toEqual({
      cycle: 1,
      completedAt: expect.any(String),
    });

    // No further recovery ran in this mocked cycle.
    expect(completed.snapshot.lastRetryObservation)
      .toEqual(startup.snapshot.lastRetryObservation);

    expect(
      firstInvocationOrder(signerRuntimeMocks.openBeaconSubmitter),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(writeDaemonStatusFile)),
    );

    expect(
      firstInvocationOrder(vi.mocked(writeDaemonStatusFile)),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(runDaemon)),
    );
  });

  it('does not publish when signer initialization fails', async () => {
    const failure = new Error('Signer initialization failed');

    signerRuntimeMocks.openBeaconSubmitter
      .mockRejectedValueOnce(failure);

    await expect(runDaemonCommand({
      source: SOURCE,
    })).rejects.toBe(failure);

    expect(writeDaemonStatusFile).not.toHaveBeenCalled();
  });

  it('awaits startup publication before entering the daemon', async () => {
    enableStatusObservation();

    let release!: () => void;

    vi.mocked(writeDaemonStatusFile).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const pending = runDaemonCommand({ source: SOURCE });

    try {
      await vi.waitFor(() => {
        expect(writeDaemonStatusFile).toHaveBeenCalledOnce();
      });

      expect(runDaemon).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }

    expect(runDaemon).toHaveBeenCalledOnce();
  });

  it('awaits cycle publication before returning from the cycle callback', async () => {
    enableStatusObservation();

    // The first publication is startup; hold the second publication.
    vi.mocked(writeDaemonStatusFile).mockResolvedValueOnce(undefined);

    let release!: () => void;

    vi.mocked(writeDaemonStatusFile).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let cycleReturned = false;

    vi.mocked(runDaemon).mockImplementationOnce(async ({ onCycle }) => {
      await onCycle?.({ consumers: [] }, { cycle: 1 });
      cycleReturned = true;
    });

    const pending = runDaemonCommand({ source: SOURCE });

    try {
      await vi.waitFor(() => {
        expect(writeDaemonStatusFile).toHaveBeenCalledTimes(2);
      });

      expect(cycleReturned).toBe(false);
    } finally {
      release();
      await pending;
    }

    expect(cycleReturned).toBe(true);
  });

  it.each([false, true])(
    'continues after publication failure when diagnostic delivery throws: %s',
    async (loggingThrows) => {
      enableStatusObservation();

      const failure = new Error('Status write failed');

      vi.mocked(writeDaemonStatusFile).mockRejectedValueOnce(failure);

      if (loggingThrows) {
        relayerLogMocks.statusPublicationFailed.mockImplementationOnce(
          () => {
            throw new Error('Diagnostic delivery failed');
          },
        );
      }

      vi.mocked(runDaemon).mockImplementationOnce(async ({ onCycle }) => {
        await onCycle?.({ consumers: [] }, { cycle: 1 });
      });

      await expect(runDaemonCommand({
        source: SOURCE,
      })).resolves.toBeUndefined();

      expect(relayerLogMocks.statusPublicationFailed)
        .toHaveBeenCalledExactlyOnceWith({
          signer: ACCOUNT.address,
          error: failure,
        });

      expect(runDaemon).toHaveBeenCalledOnce();
      expect(writeDaemonStatusFile).toHaveBeenCalledTimes(2);
    },
  );

  it('publishes fresh cumulative measurements from the clients collector', async () => {
    enableStatusObservation();

    const metrics = createRpcMetrics();
    const initial = metrics.snapshot();

    const startupMetrics: ReturnType<typeof metrics.snapshot> = {
      ...initial,
      logical: [{
        client: 'public',
        method: 'eth_call',
        started: 2,
        succeeded: 1,
        failed: 0,
        inFlight: 1,
        durationMs: 4.25,
      }],
      http: [],
    };

    const cycleMetrics: ReturnType<typeof metrics.snapshot> = {
      ...initial,
      logical: [{
        client: 'public',
        method: 'eth_call',
        started: 2,
        succeeded: 1,
        failed: 1,
        inFlight: 0,
        durationMs: 10.75,
      }],
      http: [],
    };

    const capture = vi.fn<typeof metrics.snapshot>()
      .mockReturnValueOnce(startupMetrics)
      .mockReturnValue(cycleMetrics);

    vi.mocked(createRelayerClients).mockReturnValueOnce({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      rpcMetrics: {
        ...metrics,
        snapshot: capture,
      },
    });

    vi.mocked(runDaemon).mockImplementationOnce(async ({ onCycle }) => {
      expect(capture).toHaveBeenCalledOnce();
      await onCycle?.({ consumers: [] }, { cycle: 1 });
    });

    await runDaemonCommand({ source: SOURCE });

    expect(capture).toHaveBeenCalledTimes(3);
    expect(writeDaemonStatusFile).toHaveBeenCalledTimes(2);
    expect(relayerLogMocks.statusPublicationFailed).not.toHaveBeenCalled();

    const calls = vi.mocked(writeDaemonStatusFile).mock.calls;
    const startup = calls[0]![0].snapshot;
    const completed = calls[1]![0].snapshot;

    expect(startup.rpcUsage).toEqual({
      collectorId: initial.collectorId,
      startedAt: initial.startedAt,
      observedAt: startup.observedAt,
      logical: [{
        client: 'public',
        method: 'eth_call',
        started: 2,
        completed: 1,
        failed: 0,
        inFlight: 1,
        durationMs: 4.25,
      }],
      http: [],
    });

    expect(completed.rpcUsage).toEqual({
      collectorId: initial.collectorId,
      startedAt: initial.startedAt,
      observedAt: completed.observedAt,
      logical: [{
        client: 'public',
        method: 'eth_call',
        started: 2,
        completed: 2,
        failed: 1,
        inFlight: 0,
        durationMs: 10.75,
      }],
      http: [],
    });

    // Later capture must not change the already-published observation.
    expect(startup.rpcUsage?.logical[0]?.completed).toBe(1);
  });

  it('continues after RPC capture failure and includes usage in later publications', async () => {
    enableStatusObservation();

    const metrics = createRpcMetrics();
    const initial = metrics.snapshot();
    const failure = new Error('RPC snapshot capture failed');

    const capture = vi.fn<typeof metrics.snapshot>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(initial);

    vi.mocked(createRelayerClients).mockReturnValueOnce({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      rpcMetrics: {
        ...metrics,
        snapshot: capture,
      },
    });

    vi.mocked(runDaemon).mockImplementationOnce(async ({ onCycle }) => {
      await onCycle?.({ consumers: [] }, { cycle: 1 });
    });

    await expect(runDaemonCommand({
      source: SOURCE,
    })).resolves.toBeUndefined();

    expect(runDaemon).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledTimes(3);
    expect(writeDaemonStatusFile).toHaveBeenCalledTimes(2);

    expect(relayerLogMocks.statusPublicationFailed)
      .toHaveBeenCalledExactlyOnceWith({
        signer: ACCOUNT.address,
        error: failure,
      });

    const calls = vi.mocked(writeDaemonStatusFile).mock.calls;
    const startup = calls[0]![0].snapshot;
    const completed = calls[1]![0].snapshot;

    expect(Object.hasOwn(startup, 'rpcUsage')).toBe(false);
    expect(startup.journalInitialized).toBe(true);
    expect(startup.lastObservedGate.open).toBe(true);

    expect(completed.rpcUsage).toEqual({
      collectorId: initial.collectorId,
      startedAt: initial.startedAt,
      observedAt: completed.observedAt,
      logical: [],
      http: [],
    });

    expect(completed.lastCompletedCycle?.cycle).toBe(1);
  });

  it('reports at cycle boundaries and emits a final interval', async () => {
    let monotonicMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);

    enableStatusObservation();

    vi.mocked(runDaemon).mockImplementationOnce(async ({ onCycle }) => {
      monotonicMs = 59_999;
      await onCycle?.({ consumers: [] }, { cycle: 1 });

      expect(relayerLogMocks.rpcUsage).not.toHaveBeenCalled();

      monotonicMs = 60_000;
      await onCycle?.({ consumers: [] }, { cycle: 2 });

      expect(relayerLogMocks.rpcUsage).toHaveBeenCalledOnce();
      expect(relayerLogMocks.rpcUsage.mock.calls[0]![0].report.interval)
        .toEqual({
          available: false,
          reason: 'no-baseline',
        });

      monotonicMs = 135_000;
      await onCycle?.({ consumers: [] }, { cycle: 3 });

      expect(relayerLogMocks.rpcUsage).toHaveBeenCalledTimes(2);
      expect(relayerLogMocks.rpcUsage.mock.calls[1]![0].report.interval)
        .toMatchObject({
          available: true,
          elapsedMs: 75_000,
        });

      monotonicMs = 135_250;
    });

    await runDaemonCommand({ source: SOURCE });

    expect(relayerLogMocks.rpcUsage).toHaveBeenCalledTimes(3);
    expect(relayerLogMocks.rpcUsage.mock.calls[2]![0].report.interval)
      .toMatchObject({
        available: true,
        elapsedMs: 250,
      });

    // Startup plus each of the three cycles still publishes status.
    expect(writeDaemonStatusFile).toHaveBeenCalledTimes(4);
    expect(relayerLogMocks.loggingFailed).not.toHaveBeenCalled();
  });

  it('emits a cumulative-only final report when the daemon ends before the threshold', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);

    await runDaemonCommand({ source: SOURCE });

    expect(relayerLogMocks.rpcUsage).toHaveBeenCalledOnce();
    expect(relayerLogMocks.rpcUsage.mock.calls[0]![0].report.interval)
      .toEqual({
        available: false,
        reason: 'no-baseline',
      });
  });

  it.each(['deployment', 'daemon'] as const)(
    'preserves a %s failure while attempting the final RPC report',
    async (stage) => {
      vi.spyOn(performance, 'now').mockReturnValue(0);

      const failure = new Error('Original command failure');

      if (stage === 'deployment') {
        vi.mocked(verifyRegistryDeployment).mockRejectedValueOnce(failure);
      } else {
        vi.mocked(runDaemon).mockRejectedValueOnce(failure);
      }

      await expect(runDaemonCommand({
        source: SOURCE,
      })).rejects.toBe(failure);

      expect(relayerLogMocks.rpcUsage).toHaveBeenCalledOnce();
      expect(relayerLogMocks.rpcUsage.mock.calls[0]![0].report.interval)
        .toEqual({
          available: false,
          reason: 'no-baseline',
        });
    },
  );

  it('emits a final report when startup is cancelled after client creation', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);

    const controller = new AbortController();
    const reason = new Error('Startup cancelled');

    vi.mocked(verifyRegistryDeployment).mockImplementationOnce(async () => {
      controller.abort(reason);
    });

    await expect(runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(runDaemon).not.toHaveBeenCalled();
    expect(relayerLogMocks.rpcUsage).toHaveBeenCalledOnce();
  });

  it('does not fabricate a final report when client creation fails', async () => {
    const failure = new Error('Client creation failed');

    vi.mocked(createRelayerClients).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(runDaemonCommand({
      source: SOURCE,
    })).rejects.toBe(failure);

    expect(relayerLogMocks.rpcUsage).not.toHaveBeenCalled();
    expect(verifyRegistryDeployment).not.toHaveBeenCalled();
  });

  it('preserves the daemon failure when final reporting and its diagnostic both throw', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);

    const daemonFailure = new Error('Daemon failed');
    const reportFailure = new Error('RPC reporting failed');

    vi.mocked(runDaemon).mockRejectedValueOnce(daemonFailure);

    relayerLogMocks.rpcUsage.mockImplementationOnce(() => {
      throw reportFailure;
    });

    relayerLogMocks.loggingFailed.mockImplementationOnce(() => {
      throw new Error('Diagnostic delivery failed');
    });

    await expect(runDaemonCommand({
      source: SOURCE,
    })).rejects.toBe(daemonFailure);

    expect(relayerLogMocks.rpcUsage).toHaveBeenCalledOnce();
    expect(relayerLogMocks.loggingFailed)
      .toHaveBeenCalledExactlyOnceWith({
        error: reportFailure,
      });
  });
});