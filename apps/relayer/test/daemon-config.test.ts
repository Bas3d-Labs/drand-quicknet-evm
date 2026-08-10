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
} from '../src/config.js';
import {
  loadDaemonConfig,
  parseConsumerAddresses,
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

const RELAYER_CONFIG = {
  network: 'robinhood-testnet' as const,
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.example.test',
  account: ACCOUNT,
  deployment: DEPLOYMENT,
};

describe(
  'parseConsumerAddresses',
  () => {
    it('parses one consumer address', () => {
      expect(
        parseConsumerAddresses(
          CONSUMER_A,
        ),
      ).toEqual([
        getAddress(
          CONSUMER_A,
        ),
      ]);
    });

    it('parses multiple consumer addresses', () => {
      expect(
        parseConsumerAddresses(
          `${CONSUMER_A},${CONSUMER_B}`,
        ),
      ).toEqual([
        getAddress(
          CONSUMER_A,
        ),
        getAddress(
          CONSUMER_B,
        ),
      ]);
    });

    it('trims whitespace around consumer addresses', () => {
      expect(
        parseConsumerAddresses(
          `  ${CONSUMER_A} , ${CONSUMER_B}  `,
        ),
      ).toEqual([
        getAddress(
          CONSUMER_A,
        ),
        getAddress(
          CONSUMER_B,
        ),
      ]);
    });

    it('normalizes consumer addresses', () => {
      const result =
        parseConsumerAddresses(
          LOWERCASE_CONSUMER,
        );

      expect(result).toEqual([
        getAddress(
          LOWERCASE_CONSUMER,
        ),
      ]);
    });

    it('deduplicates identical consumer addresses', () => {
      const checksummed =
        getAddress(
          LOWERCASE_CONSUMER,
        );

      expect(
        parseConsumerAddresses(
          `${LOWERCASE_CONSUMER},${checksummed}`,
        ),
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
        getAddress(
          CONSUMER_B,
        ),
        getAddress(
          CONSUMER_A,
        ),
      ]);
    });

    it('rejects a missing QUICKNET_CONSUMERS value', () => {
      expect(() =>
        parseConsumerAddresses(
          undefined,
        ),
      ).toThrow(
        'Missing required environment variable: QUICKNET_CONSUMERS.'
      );
    });

    it('rejects an empty QUICKNET_CONSUMERS value', () => {
      expect(() =>
        parseConsumerAddresses(
          '',
        ),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects a whitespace-only QUICKNET_CONSUMERS value', () => {
      expect(() =>
        parseConsumerAddresses(
          '   ',
        ),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects an empty entry between consumer addresses', () => {
      expect(() =>
        parseConsumerAddresses(
          `${CONSUMER_A},,${CONSUMER_B}`,
        ),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects a trailing empty consumer address', () => {
      expect(() =>
        parseConsumerAddresses(
          `${CONSUMER_A},`,
        ),
      ).toThrow(
        'QUICKNET_CONSUMERS contains an empty consumer address.'
      );
    });

    it('rejects a malformed consumer address', () => {
      expect(() =>
        parseConsumerAddresses(
          'not-an-address',
        ),
      ).toThrow(
        'Invalid Quicknet consumer address: not-an-address.'
      );
    });

    it('rejects a malformed address among valid addresses', () => {
      expect(() =>
        parseConsumerAddresses(
          `${CONSUMER_A},not-an-address,${CONSUMER_B}`,
        ),
      ).toThrow(
        'Invalid Quicknet consumer address: not-an-address.'
      );
    });
  },
);

describe(
  'loadDaemonConfig',
  () => {
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
      };

      await loadDaemonConfig({
        network: 'robinhood-testnet',
        env,
      });

      expect(
        loadRelayerConfig,
      ).toHaveBeenCalledOnce();

      expect(
        loadRelayerConfig,
      ).toHaveBeenCalledWith({
        network: 'robinhood-testnet',
        env,
      });
    });

    it('adds parsed consumers to the relayer configuration', async () => {
      const env = {
        QUICKNET_CONSUMERS: `${CONSUMER_A},${CONSUMER_B}`
      };

      const result =
        await loadDaemonConfig({
          network: 'robinhood-testnet',
          env,
        });

      expect(result).toEqual({
        ...RELAYER_CONFIG,
        consumers: [
          getAddress(
            CONSUMER_A,
          ),
          getAddress(
            CONSUMER_B,
          ),
        ],
      });
    });

    it('deduplicates configured consumers', async () => {
      const checksummed = getAddress(LOWERCASE_CONSUMER);
      const env = {
        QUICKNET_CONSUMERS: `${LOWERCASE_CONSUMER},${checksummed}`,
      };

      const result =
        await loadDaemonConfig({
          network: 'robinhood-testnet',
          env,
        });

      expect(
        result.consumers,
      ).toEqual([
        checksummed,
      ]);
    });

    it('rejects daemon configuration with no consumers', async () => {
      const env = {};

      await expect(
        loadDaemonConfig({
          network: 'robinhood-testnet',
          env,
        }),
      ).rejects.toThrow(
        'Missing required environment variable: QUICKNET_CONSUMERS.'
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
      };

      await expect(
        loadDaemonConfig({
          network: 'robinhood-testnet',
          env,
        }),
      ).rejects.toThrow('Relayer configuration failed.');
    });
  },
);