import process from 'node:process';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
  WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  robinhoodTestnet,
} from 'viem/chains';

vi.mock('../../src/rounds/create-beacon-submitter.js', () => ({
  createBeaconSubmitter: vi.fn(),
}));

vi.mock('../../src/cli/open-signer-runtime.js', () => ({
  openSignerRuntime: vi.fn(),
}));

vi.mock('../../src/cli/wait-for-signer-journal.js', () => ({
  waitForSignerJournal: vi.fn(),
}));

import {
  openBeaconSubmitter,
  type OpenBeaconSubmitterOptions,
} from '../../src/cli/open-beacon-submitter.js';

import {
  openSignerRuntime,
} from '../../src/cli/open-signer-runtime.js';

import {
  waitForSignerJournal,
} from '../../src/cli/wait-for-signer-journal.js';

import {
  createBeaconSubmitter,
  type BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  RelayerConfig,
} from '../../src/config/config.js';

import type {
  ScopedRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

const ACCOUNT = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);

const ERROR_SUMMARY = {
  scrubText(text: string) {
    return { text, removed: false };
  },
};

const CREATE_ERROR_SUMMARY = () => ERROR_SUMMARY;

const CONFIG: RelayerConfig = {
  network: 'robinhood-testnet',
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.example.test',
  account: ACCOUNT,
  deployment: {
    chainId: robinhoodTestnet.id,
    address: '0x2222222222222222222222222222222222222222',
    runtimeCodehash:
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    verifierAddress: '0x3333333333333333333333333333333333333333',
    verifierRuntimeCodehash:
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  finality: { type: 'safe' },
  broadcastRetry: {
    initialDelayMs: 5_000,
    maxDelayMs: 60_000,
  },
  errorSummary: ERROR_SUMMARY,
  createErrorSummary: CREATE_ERROR_SUMMARY,
};

type SignerRuntime = Awaited<ReturnType<typeof openSignerRuntime>>;

function fixture() {
  // These dependencies are only forwarded by this composition layer.
  const runtime = {
    coordinator: {} as SignerRuntime['coordinator'],
    recovery: {} as SignerRuntime['recovery'],
  };

  const submitter: BeaconSubmitter = {
    findRetainedWork: vi.fn<BeaconSubmitter['findRetainedWork']>()
      .mockReturnValue(null),
    recover: vi.fn<BeaconSubmitter['recover']>(),
    submit: vi.fn<BeaconSubmitter['submit']>(),
  };

  const readChainHeads =
    vi.fn<OpenBeaconSubmitterOptions['readChainHeads']>();

  const controller = new AbortController();

  const env: NodeJS.ProcessEnv = {
    QUICKNET_STATE_DIR: '/test/signer-state',
  };

  const options: OpenBeaconSubmitterOptions = {
    config: CONFIG,
    publicClient: {} as PublicClient,
    walletClient: {} as WalletClient,
    log: {} as ScopedRelayerLog,
    readChainHeads,
    maxBlockRange: 250n,
    checkpointFile: '/test/signer-state/checkpoint.json',
    signal: controller.signal,
    env,
  };

  vi.mocked(openSignerRuntime).mockResolvedValue(runtime);
  vi.mocked(createBeaconSubmitter).mockReturnValue(submitter);

  return {
    options,
    runtime,
    submitter,
    readChainHeads,
    env,
  };
}

describe('openBeaconSubmitter', () => {
  beforeEach(() => {
    vi.mocked(openSignerRuntime).mockReset();
    vi.mocked(createBeaconSubmitter).mockReset();
    vi.mocked(waitForSignerJournal)
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it('opens the configured runtime and returns its bound submitter', async () => {
    const {
      options,
      runtime,
      submitter,
      readChainHeads,
      env,
    } = fixture();

    const result = await openBeaconSubmitter(options);

    expect(openSignerRuntime).toHaveBeenCalledExactlyOnceWith({
      identity: {
        chainId: CONFIG.chain.id,
        signer: ACCOUNT.address,
      },
      log: options.log,
      createErrorSummary: CREATE_ERROR_SUMMARY,
      retry: CONFIG.broadcastRetry,
      checkpointFile: options.checkpointFile,
      env,
    });

    expect(createBeaconSubmitter).toHaveBeenCalledExactlyOnceWith({
      publicClient: options.publicClient,
      walletClient: options.walletClient,
      account: ACCOUNT,
      coordinator: runtime.coordinator,
      recovery: runtime.recovery,
      readChainHeads,
      maxBlockRange: 250n,
      signal: options.signal,
    });

    expect(waitForSignerJournal).not.toHaveBeenCalled();

    const openedWith = vi.mocked(openSignerRuntime).mock.calls[0]![0];
    const boundWith = vi.mocked(createBeaconSubmitter).mock.calls[0]![0];

    expect(openedWith.env).toBe(env);
    expect(openedWith.log).toBe(options.log);
    expect(openedWith.retry).toBe(CONFIG.broadcastRetry);
    expect(openedWith.createErrorSummary).toBe(CREATE_ERROR_SUMMARY);

    expect(boundWith.coordinator).toBe(runtime.coordinator);
    expect(boundWith.recovery).toBe(runtime.recovery);
    expect(boundWith.readChainHeads).toBe(readChainHeads);
    expect(boundWith.signal).toBe(options.signal);

    expect(result).toBe(submitter);
    expect(readChainHeads).not.toHaveBeenCalled();
    expect(submitter.recover).not.toHaveBeenCalled();
    expect(submitter.submit).not.toHaveBeenCalled();
  });

  it('defaults to the process environment when none is supplied', async () => {
    const { options } = fixture();

    await openBeaconSubmitter({
      ...options,
      env: undefined,
      signal: undefined,
    });

    expect(openSignerRuntime).toHaveBeenCalledOnce();

    const openedWith = vi.mocked(openSignerRuntime).mock.calls[0]![0];

    expect(openedWith.env).toBe(process.env);

    expect(createBeaconSubmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: undefined,
      }),
    );
  });

  it.each([
    'broadcastRetry',
    'createErrorSummary',
  ] as const)(
    'rejects missing %s before opening the runtime',
    async (setting) => {
      const { options, readChainHeads } = fixture();

      const config: RelayerConfig = {
        ...CONFIG,
      };

      delete config[setting];

      await expect(
        openBeaconSubmitter({
          ...options,
          config,
        }),
      ).rejects.toThrow('Signer runtime configuration is missing.');

      expect(openSignerRuntime).not.toHaveBeenCalled();
      expect(createBeaconSubmitter).not.toHaveBeenCalled();
      expect(readChainHeads).not.toHaveBeenCalled();
    },
  );

  it('preserves runtime-opening failure without creating a submitter', async () => {
    const { options, readChainHeads } = fixture();
    const failure = new Error('Signer runtime opening failed.');

    vi.mocked(openSignerRuntime).mockRejectedValueOnce(failure);

    await expect(openBeaconSubmitter(options)).rejects.toBe(failure);

    expect(openSignerRuntime).toHaveBeenCalledOnce();
    expect(createBeaconSubmitter).not.toHaveBeenCalled();
    expect(readChainHeads).not.toHaveBeenCalled();
  });

  it('waits for journal initialization before returning the submitter', async () => {
    const t = fixture();

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.mocked(waitForSignerJournal).mockReturnValueOnce(waiting);

    let returned = false;

    const pending = openBeaconSubmitter({
      ...t.options,
      startupPollIntervalMs: 100,
    }).then((result) => {
      returned = true;
      return result;
    });

    try {
      await vi.waitFor(() => {
        expect(waitForSignerJournal).toHaveBeenCalledExactlyOnceWith({
          coordinator: t.runtime.coordinator,
          submitter: t.submitter,
          pollIntervalMs: 100,
          signal: t.options.signal,
        });
      });

      expect(returned).toBe(false);
    } finally {
      release();
      await pending;
    }

    expect(await pending).toBe(t.submitter);
  });

  it('propagates cancellation from the journal wait', async () => {
    const t = fixture();
    const controller = new AbortController();
    const reason = new Error('Startup cancelled');

    vi.mocked(waitForSignerJournal).mockImplementationOnce(
      async ({ signal }) => {
        controller.abort(reason);
        signal!.throwIfAborted();
      },
    );

    await expect(openBeaconSubmitter({
      ...t.options,
      signal: controller.signal,
      startupPollIntervalMs: 100,
    })).rejects.toBe(reason);

    expect(t.submitter.submit).not.toHaveBeenCalled();
  });

  it('forwards the recovery observer to the bound submitter', async () => {
    const t = fixture();
    const onRecoveryCompleted = vi.fn();

    await openBeaconSubmitter({
      ...t.options,
      onRecoveryCompleted,
    });

    expect(createBeaconSubmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        onRecoveryCompleted,
      }),
    );
  });

  it('does not expose an initialized reader for a missing journal', async () => {
    const t = fixture();
    const onInitialized = vi.fn();

    Object.defineProperty(t.runtime.coordinator, 'journalInitialized', {
      value: false,
    });

    await expect(openBeaconSubmitter({
      ...t.options,
      onInitialized,
    })).resolves.toBe(t.submitter);

    expect(onInitialized).not.toHaveBeenCalled();
  });

  it('provides a live read-only observation after initialization', async () => {
    const t = fixture();

    let open = true;

    Object.defineProperties(t.runtime.coordinator, {
      journalInitialized: {
        get: () => true,
      },
      status: {
        get: () => ({
          open,
          primaryReason: null,
          blockers: [],
          recoveryComplete: true,
          inclusionChecksComplete: true,
          persistenceState: 'idle',
          blockedSince: null,
        }),
      },
      attempts: {
        get: () => [],
      },
    });

    const onInitialized = vi.fn<
      NonNullable<OpenBeaconSubmitterOptions['onInitialized']>
    >();

    await openBeaconSubmitter({
      ...t.options,
      onInitialized,
    });

    expect(onInitialized).toHaveBeenCalledOnce();

    const readObservation = onInitialized.mock.calls[0]![0];
    const first = readObservation();

    expect(first.journalInitialized).toBe(true);
    expect(first.status.open).toBe(true);
    expect(first.attempts).toEqual([]);

    open = false;

    const second = readObservation();

    expect(second.status.open).toBe(false);
    expect(first.status.open).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);

    expect(t.readChainHeads).not.toHaveBeenCalled();
    expect(t.submitter.recover).not.toHaveBeenCalled();
    expect(t.submitter.submit).not.toHaveBeenCalled();
  });

  it('provides the reader only after startup initialization finishes', async () => {
    const t = fixture();
    let initialized = false;

    Object.defineProperty(t.runtime.coordinator, 'journalInitialized', {
      get: () => initialized,
    });

    let finish!: () => void;

    vi.mocked(waitForSignerJournal).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = () => {
          initialized = true;
          resolve();
        };
      }),
    );

    const onInitialized = vi.fn();

    const pending = openBeaconSubmitter({
      ...t.options,
      startupPollIntervalMs: 100,
      onInitialized,
    });

    try {
      await vi.waitFor(() => {
        expect(waitForSignerJournal).toHaveBeenCalledOnce();
      });

      expect(onInitialized).not.toHaveBeenCalled();
    } finally {
      finish();
      await pending;
    }

    expect(onInitialized).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
    );

    expect(await pending).toBe(t.submitter);
  });

  it('does not provide a reader when startup initialization fails', async () => {
    const t = fixture();
    const failure = new Error('Initialization failed');
    const onInitialized = vi.fn();

    vi.mocked(waitForSignerJournal).mockRejectedValueOnce(failure);

    await expect(openBeaconSubmitter({
      ...t.options,
      startupPollIntervalMs: 100,
      onInitialized,
    })).rejects.toBe(failure);

    expect(onInitialized).not.toHaveBeenCalled();
  });

  it('preserves successful opening when the initialization observer throws', async () => {
    const t = fixture();

    Object.defineProperty(t.runtime.coordinator, 'journalInitialized', {
      value: true,
    });

    await expect(openBeaconSubmitter({
      ...t.options,
      onInitialized() {
        throw new Error('Diagnostic setup failed');
      },
    })).resolves.toBe(t.submitter);

    expect(t.submitter.recover).not.toHaveBeenCalled();
    expect(t.submitter.submit).not.toHaveBeenCalled();
  });
});