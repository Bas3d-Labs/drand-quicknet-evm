import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodTestnet } from 'viem/chains';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

vi.mock('../src/config.js', () => ({
  loadRelayerConfig: vi.fn(),
}));

import {
  loadRelayerConfig,
  type RelayerConfig,
} from '../src/config.js';

import {
  configDiagnostic,
  RelayerConfigError,
  type ConfigCode,
  type ConfigSetting,
} from '../src/config-errors.js';

import {
  DEFAULT_MAX_BLOCK_RANGE,
  DEFAULT_POLL_INTERVAL_MS,
  loadDaemonConfig,
  parseCheckpointFile,
  parseConsumerAddresses,
  parseMaxBlockRange,
  parsePollIntervalMs,
  parseStartBlock,
} from '../src/daemon-config.js';

const SOURCE = {
  type: 'preset',
  network: 'robinhood-testnet',
} as const;

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const LOWERCASE_CONSUMER: Address =
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const REGISTRY_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const VERIFIER_ADDRESS: Address =
  '0x5555555555555555555555555555555555555555';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ACCOUNT = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);

const DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
};

const RELAYER_CONFIG: RelayerConfig = {
  network: 'robinhood-testnet',
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.example.test',
  account: ACCOUNT,
  deployment: DEPLOYMENT,
  finality: { type: 'safe' },
};

function createEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    QUICKNET_CONSUMERS: CONSUMER_A,
    QUICKNET_START_BLOCK: '123456',
    QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    ...overrides,
  };
}

function assertConfigDiagnostic(
  error: unknown,
  code: ConfigCode,
  setting: ConfigSetting,
): void {
  expect(error).toBeInstanceOf(RelayerConfigError);
  expect(configDiagnostic(error)).toEqual({ code, setting });
}

function expectConfigError(
  action: () => unknown,
  code: ConfigCode,
  setting: ConfigSetting,
): void {
  let thrown: unknown;

  try {
    action();
  } catch (error) {
    thrown = error;
  }

  assertConfigDiagnostic(thrown, code, setting);
}

async function expectConfigRejection(
  promise: Promise<unknown>,
  code: ConfigCode,
  setting: ConfigSetting,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('Expected the promise to reject.');
    },
    (failure: unknown) => failure,
  );

  assertConfigDiagnostic(error, code, setting);
}

describe('parseConsumerAddresses', () => {
  it('parses one consumer address', () => {
    expect(parseConsumerAddresses(CONSUMER_A)).toEqual([
      CONSUMER_A,
    ]);
  });

  it('parses multiple consumer addresses', () => {
    expect(
      parseConsumerAddresses(`${CONSUMER_A},${CONSUMER_B}`),
    ).toEqual([
      CONSUMER_A,
      CONSUMER_B,
    ]);
  });

  it('trims whitespace around consumer addresses', () => {
    expect(
      parseConsumerAddresses(`  ${CONSUMER_A} , ${CONSUMER_B}  `),
    ).toEqual([
      CONSUMER_A,
      CONSUMER_B,
    ]);
  });

  it('normalizes consumer addresses', () => {
    expect(
      parseConsumerAddresses(LOWERCASE_CONSUMER),
    ).toEqual([
      getAddress(LOWERCASE_CONSUMER),
    ]);
  });

  it('deduplicates identical consumer addresses', () => {
    const checksummed = getAddress(LOWERCASE_CONSUMER);

    expect(
      parseConsumerAddresses(`${LOWERCASE_CONSUMER},${checksummed}`),
    ).toEqual([
      checksummed,
    ]);
  });

  it('preserves first-seen consumer order when deduplicating', () => {
    expect(
      parseConsumerAddresses(
        `${CONSUMER_B},${CONSUMER_A},${CONSUMER_B}`,
      ),
    ).toEqual([
      CONSUMER_B,
      CONSUMER_A,
    ]);
  });

  it('rejects a missing QUICKNET_CONSUMERS value', () => {
    expectConfigError(
      () => parseConsumerAddresses(undefined),
      'MISSING_REQUIRED_SETTING',
      'QUICKNET_CONSUMERS',
    );
  });

  it.each([
    {
      name: 'empty value',
      value: '',
    },
    {
      name: 'whitespace-only value',
      value: '   ',
    },
    {
      name: 'empty entry between addresses',
      value: `${CONSUMER_A},,${CONSUMER_B}`,
    },
    {
      name: 'trailing empty address',
      value: `${CONSUMER_A},`,
    },
  ])('rejects $name', ({ value }) => {
    expectConfigError(
      () => parseConsumerAddresses(value),
      'EMPTY_CONSUMER',
      'QUICKNET_CONSUMERS',
    );
  });

  it.each([
    'not-an-address',
    `${CONSUMER_A},not-an-address,${CONSUMER_B}`,
  ])('rejects a malformed address in %j', (value) => {
    expectConfigError(
      () => parseConsumerAddresses(value),
      'INVALID_CONSUMER',
      'QUICKNET_CONSUMERS',
    );
  });
});

describe('parseStartBlock', () => {
  it.each([
    ['123456', 123_456n],
    ['0', 0n],
    [
      '123456789012345678901234567890',
      123456789012345678901234567890n,
    ],
    ['000123', 123n],
  ] as const)('parses %s without precision loss', (value, expected) => {
    expect(parseStartBlock(value)).toBe(expected);
  });

  it('identifies QUICKNET_START_BLOCK when its value is missing', () => {
    expectConfigError(
      () => parseStartBlock(undefined),
      'MISSING_REQUIRED_SETTING',
      'QUICKNET_START_BLOCK',
    );
  });

  it.each([
    '',
    '   ',
    '-1',
    '0x1234',
    '123.5',
    '123abc',
    ' 123 ',
  ])('rejects invalid start block %j', (value) => {
    expectConfigError(
      () => parseStartBlock(value),
      'INVALID_START_BLOCK',
      'QUICKNET_START_BLOCK',
    );
  });
});

describe('parseCheckpointFile', () => {
  it.each([
    './state/robinhood-testnet.json',
    '/var/lib/quicknet/checkpoint.json',
    ' ./state/checkpoint.json ',
  ])('preserves a non-empty path exactly: %j', (value) => {
    expect(parseCheckpointFile(value)).toBe(value);
  });

  it('rejects a missing QUICKNET_CHECKPOINT_FILE value', () => {
    expectConfigError(
      () => parseCheckpointFile(undefined),
      'MISSING_REQUIRED_SETTING',
      'QUICKNET_CHECKPOINT_FILE',
    );
  });

  it.each([
    '',
    '   ',
  ])('rejects an empty checkpoint path: %j', (value) => {
    expectConfigError(
      () => parseCheckpointFile(value),
      'EMPTY_CHECKPOINT_FILE',
      'QUICKNET_CHECKPOINT_FILE',
    );
  });
});

describe('parseMaxBlockRange', () => {
  it('uses the default when QUICKNET_MAX_BLOCK_RANGE is missing', () => {
    expect(
      parseMaxBlockRange(undefined),
    ).toBe(DEFAULT_MAX_BLOCK_RANGE);
  });

  it.each([
    ['5000', 5_000n],
    ['1', 1n],
    [
      '123456789012345678901234567890',
      123456789012345678901234567890n,
    ],
    ['000123', 123n],
  ] as const)('parses %s without precision loss', (value, expected) => {
    expect(parseMaxBlockRange(value)).toBe(expected);
  });

  it.each([
    '0',
    '',
    '   ',
    '-1',
    '0x100',
    '100.5',
    '100abc',
    ' 100 ',
  ])('rejects invalid max block range %j', (value) => {
    expectConfigError(
      () => parseMaxBlockRange(value),
      'INVALID_BLOCK_RANGE',
      'QUICKNET_MAX_BLOCK_RANGE',
    );
  });
});

describe('parsePollIntervalMs', () => {
  it('uses the default when QUICKNET_POLL_INTERVAL_MS is missing', () => {
    expect(
      parsePollIntervalMs(undefined),
    ).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it.each([
    ['2500', 2_500],
    ['1', 1],
    [
      Number.MAX_SAFE_INTEGER.toString(),
      Number.MAX_SAFE_INTEGER,
    ],
    ['001000', 1_000],
  ] as const)('parses poll interval %s', (value, expected) => {
    expect(parsePollIntervalMs(value)).toBe(expected);
  });

  it.each([
    '0',
    '',
    '   ',
    '-1',
    '1000.5',
    '0x1000',
    '1000ms',
    ' 1000 ',
  ])('rejects invalid poll interval %j', (value) => {
    expectConfigError(
      () => parsePollIntervalMs(value),
      'INVALID_POLL_INTERVAL',
      'QUICKNET_POLL_INTERVAL_MS',
    );
  });

  it('rejects a value larger than Number.MAX_SAFE_INTEGER', () => {
    const value =
      (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();

    expectConfigError(
      () => parsePollIntervalMs(value),
      'INVALID_POLL_INTERVAL',
      'QUICKNET_POLL_INTERVAL_MS',
    );
  });
});

describe('loadDaemonConfig', () => {
  beforeEach(() => {
    vi.mocked(loadRelayerConfig)
      .mockReset()
      .mockResolvedValue(RELAYER_CONFIG);
  });

  it('loads the base relayer configuration', async () => {
    const env = createEnvironment();

    await loadDaemonConfig({
      source: SOURCE,
      env,
    });

    expect(loadRelayerConfig).toHaveBeenCalledExactlyOnceWith({
      source: SOURCE,
      env,
    });
  });

  it('passes a custom network source to the relayer configuration', async () => {
    const source = {
      type: 'custom',
      configFile: './networks/example-mainnet.json',
    } as const;

    const env = createEnvironment();

    await loadDaemonConfig({
      source,
      env,
    });

    expect(loadRelayerConfig).toHaveBeenCalledExactlyOnceWith({
      source,
      env,
    });
  });

  it('adds daemon configuration with operational defaults', async () => {
    const env = createEnvironment({
      QUICKNET_CONSUMERS: `${CONSUMER_A},${CONSUMER_B}`,
    });

    const result = await loadDaemonConfig({
      source: SOURCE,
      env,
    });

    expect(result).toEqual({
      ...RELAYER_CONFIG,
      consumers: [
        CONSUMER_A,
        CONSUMER_B,
      ],
      startBlock: 123_456n,
      checkpointFile: './state/checkpoint.json',
      maxBlockRange: DEFAULT_MAX_BLOCK_RANGE,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    });
  });

  it('loads max block range and poll interval overrides', async () => {
    const env = createEnvironment({
      QUICKNET_MAX_BLOCK_RANGE: '5000',
      QUICKNET_POLL_INTERVAL_MS: '2500',
    });

    const result = await loadDaemonConfig({
      source: SOURCE,
      env,
    });

    expect(result.maxBlockRange).toBe(5_000n);
    expect(result.pollIntervalMs).toBe(2_500);
  });

  it('supports a startBlock of zero', async () => {
    const env = createEnvironment({
      QUICKNET_START_BLOCK: '0',
    });

    const result = await loadDaemonConfig({
      source: SOURCE,
      env,
    });

    expect(result.startBlock).toBe(0n);
  });

  it('deduplicates configured consumers', async () => {
    const checksummed = getAddress(LOWERCASE_CONSUMER);

    const env = createEnvironment({
      QUICKNET_CONSUMERS: `${LOWERCASE_CONSUMER},${checksummed}`,
    });

    const result = await loadDaemonConfig({
      source: SOURCE,
      env,
    });

    expect(result.consumers).toEqual([
      checksummed,
    ]);
  });

  it.each([
    'QUICKNET_CONSUMERS',
    'QUICKNET_START_BLOCK',
    'QUICKNET_CHECKPOINT_FILE',
  ] as const)(
    'identifies missing required setting %s',
    async (setting) => {
      const env = createEnvironment();
      delete env[setting];

      await expectConfigRejection(
        loadDaemonConfig({
          source: SOURCE,
          env,
        }),
        'MISSING_REQUIRED_SETTING',
        setting,
      );
    },
  );

  it.each([
    {
      setting: 'QUICKNET_START_BLOCK',
      value: '-1',
      code: 'INVALID_START_BLOCK',
    },
    {
      setting: 'QUICKNET_MAX_BLOCK_RANGE',
      value: '0',
      code: 'INVALID_BLOCK_RANGE',
    },
    {
      setting: 'QUICKNET_POLL_INTERVAL_MS',
      value: '0',
      code: 'INVALID_POLL_INTERVAL',
    },
  ] as const)(
    'rejects invalid $setting',
    async ({ setting, value, code }) => {
      const env = createEnvironment({
        [setting]: value,
      });

      await expectConfigRejection(
        loadDaemonConfig({
          source: SOURCE,
          env,
        }),
        code,
        setting,
      );
    },
  );

  it('propagates base relayer configuration failures unchanged', async () => {
    const failure = new Error('Relayer configuration failed.');

    vi.mocked(loadRelayerConfig).mockRejectedValue(failure);

    await expect(
      loadDaemonConfig({
        source: SOURCE,
        env: createEnvironment(),
      }),
    ).rejects.toBe(failure);
  });
});