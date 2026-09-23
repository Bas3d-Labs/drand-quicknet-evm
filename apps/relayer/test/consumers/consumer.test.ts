import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  getAddress,
  Hex,
  type Address,
  type PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  QUICKNET_RANDOMNESS_CONSUMER_ABI,
} from '../../src/consumers/consumer-abi.js';
import {
  validateQuicknetConsumer,
} from '../../src/consumers/consumer.js';

const CONSUMER_ADDRESS: Address =
  '0x1111111111111111111111111111111111111111';

const CHAIN_ID = 12345;

const REGISTRY_ADDRESS: Address =
  '0x2222222222222222222222222222222222222222';

const OTHER_REGISTRY_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_ADDRESS: Address =
  '0x5555555555555555555555555555555555555555';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const DEPLOYMENT: RegistryDeployment = {
  chainId: CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
};

interface MockPublicClient {
  publicClient: PublicClient;
  getCode: ReturnType<typeof vi.fn>;
  readContract: ReturnType<typeof vi.fn>;
}

function createPublicClient(): MockPublicClient {
  const getCode =
    vi.fn();

  const readContract =
    vi.fn();

  const publicClient = {
    getCode,
    readContract,
  } as unknown as PublicClient;

  return {
    publicClient,
    getCode,
    readContract,
  };
}

describe(
  'validateQuicknetConsumer',
  () => {
    it('validates a consumer using the configured registry', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockResolvedValue(
        REGISTRY_ADDRESS,
      );

      const result =
        await validateQuicknetConsumer({
          publicClient,
          consumer: CONSUMER_ADDRESS,
          deployment: DEPLOYMENT,
        });

      expect(result).toEqual({
        address: getAddress(CONSUMER_ADDRESS),
        registry: getAddress(REGISTRY_ADDRESS),
      });
    });

    it('checks that the consumer has deployed code', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockResolvedValue(
        REGISTRY_ADDRESS,
      );

      await validateQuicknetConsumer({
        publicClient,
        consumer: CONSUMER_ADDRESS,
        deployment: DEPLOYMENT,
      });

      expect(
        getCode,
      ).toHaveBeenCalledOnce();

      expect(
        getCode,
      ).toHaveBeenCalledWith({
        address: getAddress(CONSUMER_ADDRESS)
      });
    });

    it('reads quicknetBeaconRegistry from the consumer', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockResolvedValue(
        REGISTRY_ADDRESS,
      );

      await validateQuicknetConsumer({
        publicClient,
        consumer: CONSUMER_ADDRESS,
        deployment: DEPLOYMENT,
      });

      expect(
        readContract,
      ).toHaveBeenCalledOnce();

      expect(
        readContract,
      ).toHaveBeenCalledWith({
        address: getAddress(CONSUMER_ADDRESS),
        abi: QUICKNET_RANDOMNESS_CONSUMER_ABI,
        functionName: 'quicknetBeaconRegistry',
      });
    });

    it('rejects a consumer with no deployed code', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        undefined,
      );

      await expect(
        validateQuicknetConsumer({
          publicClient,
          consumer:
            CONSUMER_ADDRESS,
          deployment:
            DEPLOYMENT,
        }),
      ).rejects.toThrow(
        `Quicknet consumer ${getAddress(CONSUMER_ADDRESS)} has no deployed code.`
      );

      expect(
        readContract,
      ).not.toHaveBeenCalled();
    });

    it('rejects a consumer with empty deployed code', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        '0x',
      );

      await expect(
        validateQuicknetConsumer({
          publicClient,
          consumer:
            CONSUMER_ADDRESS,
          deployment:
            DEPLOYMENT,
        }),
      ).rejects.toThrow(
        `Quicknet consumer ${getAddress(CONSUMER_ADDRESS)} has no deployed code.`
      );

      expect(
        readContract,
      ).not.toHaveBeenCalled();
    });

    it('rejects a consumer using a different registry', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockResolvedValue(
        OTHER_REGISTRY_ADDRESS,
      );

      await expect(
        validateQuicknetConsumer({
          publicClient,
          consumer:
            CONSUMER_ADDRESS,
          deployment:
            DEPLOYMENT,
        }),
      ).rejects.toThrow(
        `Quicknet consumer ${getAddress(CONSUMER_ADDRESS)} uses registry ` +
          `${getAddress(OTHER_REGISTRY_ADDRESS)}, but relayer is configured ` +
          `for ${getAddress(REGISTRY_ADDRESS)}.`
      );
    });

    it('propagates a quicknetBeaconRegistry read failure', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockRejectedValue(
        new Error('Contract read failed.'),
      );

      await expect(
        validateQuicknetConsumer({
          publicClient,
          consumer:
            CONSUMER_ADDRESS,
          deployment:
            DEPLOYMENT,
        }),
      ).rejects.toThrow('Contract read failed.');
    });

    it('normalizes the consumer address', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      const consumer =
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockResolvedValue(
        REGISTRY_ADDRESS,
      );

      const result =
        await validateQuicknetConsumer({
          publicClient,
          consumer,
          deployment:
            DEPLOYMENT,
        });

      expect(
        result.address,
      ).toBe(
        getAddress(consumer),
      );

      expect(
        getCode,
      ).toHaveBeenCalledWith({
        address:
          getAddress(consumer),
      });

      expect(
        readContract,
      ).toHaveBeenCalledWith({
        address:
          getAddress(consumer),
        abi:
          QUICKNET_RANDOMNESS_CONSUMER_ABI,
        functionName:
          'quicknetBeaconRegistry',
      });
    });

    it('normalizes the registry returned by the consumer', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      const lowercaseRegistry =
        REGISTRY_ADDRESS.toLowerCase() as Address;

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockResolvedValue(
        lowercaseRegistry,
      );

      const result =
        await validateQuicknetConsumer({
          publicClient,
          consumer:
            CONSUMER_ADDRESS,
          deployment:
            DEPLOYMENT,
        });

      expect(
        result.registry,
      ).toBe(
        getAddress(
          REGISTRY_ADDRESS,
        ),
      );
    });

    it('checks deployed code before reading the registry', async () => {
      const {
        publicClient,
        getCode,
        readContract,
      } = createPublicClient();

      getCode.mockResolvedValue(
        '0x6001600055',
      );

      readContract.mockResolvedValue(
        REGISTRY_ADDRESS,
      );

      await validateQuicknetConsumer({
        publicClient,
        consumer:
          CONSUMER_ADDRESS,
        deployment:
          DEPLOYMENT,
      });

      const getCodeOrder =
        getCode.mock
          .invocationCallOrder[0];

      const readContractOrder =
        readContract.mock
          .invocationCallOrder[0];

      expect(
        getCodeOrder,
      ).toBeDefined();

      expect(
        readContractOrder,
      ).toBeDefined();

      if (
        getCodeOrder === undefined ||
        readContractOrder ===
          undefined
      ) {
        throw new Error('Expected both client methods to have been called.');
      }

      expect(
        getCodeOrder,
      ).toBeLessThan(
        readContractOrder,
      );
    });
  },
);
