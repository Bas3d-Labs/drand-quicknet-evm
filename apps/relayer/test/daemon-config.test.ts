import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  getAddress,
  type Address,
} from 'viem';
import {
  privateKeyToAccount,
} from 'viem/accounts';
import {
  robinhoodTestnet,
} from 'viem/chains';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

vi.mock(
  '../src/config.js',
  () => ({
    loadRelayerConfig: vi.fn(),
  }),
);

import {
  loadRelayerConfig,
  RelayerConfig,
} from '../src/config.js';

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

const CONSUMER_A = '0x1111111111111111111111111111111111111111';
const CONSUMER_B = '0x2222222222222222222222222222222222222222';
const LOWERCASE_CONSUMER =
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;

const REGISTRY_ADDRESS = '0x3333333333333333333333333333333333333333';

const RUNTIME_CODEHASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
};

const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);

const RELAYER_CONFIG: RelayerConfig = {
  network: 'robinhood-testnet' as const,
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.example.test',
  account: ACCOUNT,
  deployment: DEPLOYMENT,
  finality: {
    type: 'safe',
  },
};

describe(
  'parseConsumerAddresses',
  () => {
    it('parses one consumer address', () => {
      expect(
        parseConsumerAddresses(CONSUMER_A),
      ).toEqual([
        getAddress(CONSUMER_A),
      ]);
    });

    it('parses multiple consumer addresses', () => {
      expect(
        parseConsumerAddresses(`${CONSUMER_A},${CONSUMER_B}`),
      ).toEqual([
        getAddress(CONSUMER_A),
        getAddress(CONSUMER_B),
      ]);
    });

    it('trims whitespace around consumer addresses', () => {
      expect(
        parseConsumerAddresses(`  ${CONSUMER_A} , ${CONSUMER_B}  `),
      ).toEqual([
        getAddress(CONSUMER_A),
        getAddress(CONSUMER_B),
      ]);
    });

    it('normalizes consumer addresses', () => {
      const result =
        parseConsumerAddresses(LOWERCASE_CONSUMER);

      expect(result).toEqual([
        getAddress(LOWERCASE_CONSUMER),
      ]);
    });

    it('deduplicates identical consumer addresses', () => {
      const checksummed =
        getAddress(LOWERCASE_CONSUMER);

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
        getAddress(CONSUMER_B),
        getAddress(CONSUMER_A),
      ]);
    });

    it('rejects a missing QUICKNET_CONSUMERS value', () => {
      expect(() =>
        parseConsumerAddresses(undefined),
      ).toThrow(
        'Missing required environment variable: QUICKNET_CONSUMERS.'
      );
    });

    it('rejects an empty QUICKNET_CONSUMERS value', () => {
      expect(() =>
        parseConsumerAddresses(''),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects a whitespace-only QUICKNET_CONSUMERS value', () => {
      expect(() =>
        parseConsumerAddresses('   '),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects an empty entry between consumer addresses', () => {
      expect(() =>
        parseConsumerAddresses(`${CONSUMER_A},,${CONSUMER_B}`),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects a trailing empty consumer address', () => {
      expect(() =>
        parseConsumerAddresses(`${CONSUMER_A},`),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects a malformed consumer address', () => {
      expect(() =>
        parseConsumerAddresses('not-an-address'),
      ).toThrow(
        'Invalid Quicknet consumer address: not-an-address.'
      );
    });

    it('rejects a malformed address among valid addresses', () => {
      expect(() =>
        parseConsumerAddresses(`${CONSUMER_A},not-an-address,${CONSUMER_B}`),
      ).toThrow(
        'Invalid Quicknet consumer address: not-an-address.'
      );
    });
  },
);

describe('parseStartBlock', () => {
  it('parses a valid start block', () => {
    expect(
      parseStartBlock('123456')
    ).toBe(
      123_456n
    );
  });

  it('accepts block zero', () => {
    expect(
      parseStartBlock('0')
    ).toBe(
      0n
    );
  });

  it('accepts a large decimal start block without precision loss', () => {
    const value = '123456789012345678901234567890';

    expect(
      parseStartBlock(value)
    ).toBe(
      BigInt(value)
    );
  });

  it('accepts leading zeroes', () => {
    expect(
      parseStartBlock('000123')
    ).toBe(
      123n
    );
  });

  it('rejects a missing QUICKNET_START_BLOCK value', () => {
    expect(() =>
      parseStartBlock(undefined)
    ).toThrow(
      'Missing required environment variable: QUICKNET_START_BLOCK.'
    );
  });

  it('rejects an empty start block', () => {
    expect(() =>
      parseStartBlock('')
    ).toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });

  it('rejects a whitespace-only start block', () => {
    expect(() =>
      parseStartBlock('   ')
    ).toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });

  it('rejects a negative start block', () => {
    expect(() =>
      parseStartBlock('-1')
    ).toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });

  it('rejects a hexadecimal start block', () => {
    expect(() =>
      parseStartBlock('0x1234')
    ).toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });

  it('rejects a fractional start block', () => {
    expect(() =>
      parseStartBlock('123.5')
    ).toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });

  it('rejects a non-numeric start block', () => {
    expect(() =>
      parseStartBlock('123abc')
    ).toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });

  it('rejects a start block with surrounding whitespace', () => {
    expect(() =>
      parseStartBlock(' 123 ')
    ).toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });
});

describe('parseCheckpointFile', () => {
  it('parses a checkpoint file path', () => {
    expect(
      parseCheckpointFile('./state/robinhood-testnet.json')
    ).toBe(
      './state/robinhood-testnet.json'
    );
  });

  it('accepts an absolute checkpoint file path', () => {
    expect(
      parseCheckpointFile('/var/lib/quicknet/checkpoint.json')
    ).toBe(
      '/var/lib/quicknet/checkpoint.json'
    );
  });

  it('rejects a missing QUICKNET_CHECKPOINT_FILE value', () => {
    expect(() =>
      parseCheckpointFile(undefined)
    ).toThrow(
      'Missing required environment variable: QUICKNET_CHECKPOINT_FILE.'
    );
  });

  it('rejects an empty checkpoint file path', () => {
    expect(() =>
      parseCheckpointFile('')
    ).toThrow(
      'QUICKNET_CHECKPOINT_FILE must not be empty.'
    );
  });

  it('rejects a whitespace-only checkpoint file path', () => {
    expect(() =>
      parseCheckpointFile('   ')
    ).toThrow(
      'QUICKNET_CHECKPOINT_FILE must not be empty.'
    );
  });

  it('preserves a non-empty checkpoint file path exactly', () => {
    expect(
      parseCheckpointFile(' ./state/checkpoint.json ')
    ).toBe(
      ' ./state/checkpoint.json '
    );
  });
});

describe('parseMaxBlockRange', () => {
  it('uses the default when QUICKNET_MAX_BLOCK_RANGE is missing', () => {
    expect(
      parseMaxBlockRange(undefined)
    ).toBe(
      DEFAULT_MAX_BLOCK_RANGE
    );
  });

  it('parses a valid max block range', () => {
    expect(
      parseMaxBlockRange('5000')
    ).toBe(
      5_000n
    );
  });

  it('accepts a max block range of one', () => {
    expect(
      parseMaxBlockRange('1')
    ).toBe(
      1n
    );
  });

  it('accepts a large max block range without precision loss', () => {
    const value = '123456789012345678901234567890';

    expect(
      parseMaxBlockRange(value)
    ).toBe(
      BigInt(value)
    );
  });

  it('accepts leading zeroes', () => {
    expect(
      parseMaxBlockRange('000123')
    ).toBe(
      123n
    );
  });

  it('rejects zero', () => {
    expect(() =>
      parseMaxBlockRange('0')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects an empty max block range', () => {
    expect(() =>
      parseMaxBlockRange('')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects a whitespace-only max block range', () => {
    expect(() =>
      parseMaxBlockRange('   ')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects a negative max block range', () => {
    expect(() =>
      parseMaxBlockRange('-1')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects a hexadecimal max block range', () => {
    expect(() =>
      parseMaxBlockRange('0x100')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects a fractional max block range', () => {
    expect(() =>
      parseMaxBlockRange('100.5')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects a non-numeric max block range', () => {
    expect(() =>
      parseMaxBlockRange('100abc')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects a max block range with surrounding whitespace', () => {
    expect(() =>
      parseMaxBlockRange(' 100 ')
    ).toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });
});

describe('parsePollIntervalMs', () => {
  it('uses the default when QUICKNET_POLL_INTERVAL_MS is missing', () => {
    expect(
      parsePollIntervalMs(undefined)
    ).toBe(
      DEFAULT_POLL_INTERVAL_MS
    );
  });

  it('parses a valid poll interval', () => {
    expect(
      parsePollIntervalMs('2500')
    ).toBe(
      2_500
    );
  });

  it('accepts a poll interval of one millisecond', () => {
    expect(
      parsePollIntervalMs('1')
    ).toBe(
      1
    );
  });

  it('accepts Number.MAX_SAFE_INTEGER', () => {
    expect(
      parsePollIntervalMs(Number.MAX_SAFE_INTEGER.toString())
    ).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it('accepts leading zeroes', () => {
    expect(
      parsePollIntervalMs('001000')
    ).toBe(
      1_000
    );
  });

  it('rejects zero', () => {
    expect(() =>
      parsePollIntervalMs('0')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects an empty poll interval', () => {
    expect(() =>
      parsePollIntervalMs('')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects a whitespace-only poll interval', () => {
    expect(() =>
      parsePollIntervalMs('   ')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects a negative poll interval', () => {
    expect(() =>
      parsePollIntervalMs('-1')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects a fractional poll interval', () => {
    expect(() =>
      parsePollIntervalMs('1000.5')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects a hexadecimal poll interval', () => {
    expect(() =>
      parsePollIntervalMs('0x1000')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects a non-numeric poll interval', () => {
    expect(() =>
      parsePollIntervalMs('1000ms')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects a poll interval with surrounding whitespace', () => {
    expect(() =>
      parsePollIntervalMs(' 1000 ')
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('rejects a value larger than Number.MAX_SAFE_INTEGER', () => {
    const value =
      (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();

    expect(() =>
      parsePollIntervalMs(value)
    ).toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });
});

describe('loadDaemonConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(
      loadRelayerConfig,
    ).mockResolvedValue(
      RELAYER_CONFIG,
    );
  });

  it('loads the base relayer configuration', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await loadDaemonConfig({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });

    expect(
      loadRelayerConfig,
    ).toHaveBeenCalledOnce();

    expect(
      loadRelayerConfig,
    ).toHaveBeenCalledWith({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });
  });

  it('passes a custom network source to the relayer configuration', async () => {
    const source = {
      type: 'custom',
      configFile: './networks/example-mainnet.json',
    } as const;

    const env = {
      QUICKNET_CONSUMERS: '0x1111111111111111111111111111111111111111',
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await loadDaemonConfig({
      source,
      env,
    });

    expect(
      loadRelayerConfig,
    ).toHaveBeenCalledWith({
      source,
      env,
    });
  });

  it('adds daemon configuration with operational defaults', async () => {
    const env = {
      QUICKNET_CONSUMERS: `${CONSUMER_A},${CONSUMER_B}`,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    const result = await loadDaemonConfig({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });

    expect(result).toEqual({
      ...RELAYER_CONFIG,
      consumers: [
        getAddress(CONSUMER_A),
        getAddress(CONSUMER_B),
      ],
      startBlock: 123_456n,
      checkpointFile: './state/checkpoint.json',
      maxBlockRange: DEFAULT_MAX_BLOCK_RANGE,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    });
  });

  it('loads max block range and poll interval overrides', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
      QUICKNET_MAX_BLOCK_RANGE: '5000',
      QUICKNET_POLL_INTERVAL_MS: '2500',
    };

    const result = await loadDaemonConfig({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });

    expect(result.maxBlockRange).toBe(
      5_000n
    );

    expect(result.pollIntervalMs).toBe(
      2_500
    );
  });

  it('supports a startBlock of zero', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '0',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    const result = await loadDaemonConfig({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });

    expect(result.startBlock).toBe(
      0n
    );
  });

  it('deduplicates configured consumers', async () => {
    const checksummed = getAddress(LOWERCASE_CONSUMER);
    const env = {
      QUICKNET_CONSUMERS: `${LOWERCASE_CONSUMER},${checksummed}`,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    const result = await loadDaemonConfig({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });

    expect(
      result.consumers,
    ).toEqual([
      checksummed,
    ]);
  });

  it('rejects daemon configuration with no consumers', async () => {
    const env = {
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await expect(
      loadDaemonConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env,
      }),
    ).rejects.toThrow(
      'Missing required environment variable: QUICKNET_CONSUMERS.'
    );
  });

  it('rejects daemon configuration with no start block', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await expect(
      loadDaemonConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env,
      }),
    ).rejects.toThrow(
      'Missing required environment variable: QUICKNET_START_BLOCK.'
    );
  });

  it('rejects daemon configuration with no checkpoint file', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
    };

    await expect(
      loadDaemonConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env,
      }),
    ).rejects.toThrow(
      'Missing required environment variable: QUICKNET_CHECKPOINT_FILE.'
    );
  });

  it('rejects daemon configuration with an invalid start block', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '-1',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await expect(
      loadDaemonConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env,
      })
    ).rejects.toThrow(
      'QUICKNET_START_BLOCK must be a non-negative decimal integer.'
    );
  });

  it('rejects daemon configuration with an invalid max block range', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
      QUICKNET_MAX_BLOCK_RANGE: '0',
    };

    await expect(
      loadDaemonConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env,
      })
    ).rejects.toThrow(
      'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.'
    );
  });

  it('rejects daemon configuration with an invalid poll interval', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
      QUICKNET_POLL_INTERVAL_MS: '0',
    };

    await expect(
      loadDaemonConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env,
      })
    ).rejects.toThrow(
      'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.'
    );
  });

  it('propagates base relayer configuration failures', async () => {
    vi.mocked(
      loadRelayerConfig,
    ).mockRejectedValue(
      new Error('Relayer configuration failed.'),
    );

    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await expect(
      loadDaemonConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env,
      }),
    ).rejects.toThrow('Relayer configuration failed.');
  });
});