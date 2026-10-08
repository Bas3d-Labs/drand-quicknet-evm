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

vi.mock('../../src/cli/open-signer-runtime.js', () => ({
  openSignerRuntime: vi.fn(),
}));

vi.mock('../../src/rounds/create-beacon-submitter.js', () => ({
  createBeaconSubmitter: vi.fn(),
}));

import {
  openBeaconSubmitter,
  type OpenBeaconSubmitterOptions,
} from '../../src/cli/open-beacon-submitter.js';

import {
  openSignerRuntime,
} from '../../src/cli/open-signer-runtime.js';

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
});