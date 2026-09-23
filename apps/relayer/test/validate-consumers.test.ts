import {
  beforeEach,
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

vi.mock(
  '../src/consumers/consumer.js',
  () => ({
    validateQuicknetConsumer:
      vi.fn(),
  }),
);

import {
  validateQuicknetConsumer,
} from '../src/consumers/consumer.js';
import {
  validateQuicknetConsumers,
} from '../src/consumers/validate-consumers.js';

const CONSUMER_A = '0x1111111111111111111111111111111111111111';
const CONSUMER_B = '0x2222222222222222222222222222222222222222';
const CONSUMER_C = '0x3333333333333333333333333333333333333333';

const CHAIN_ID = 12345;

const REGISTRY_ADDRESS: Address =
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

const PUBLIC_CLIENT =
  {} as PublicClient;

function validatedConsumer(
  address: Address,
) {
  return {
    address: getAddress(address),
    registry: getAddress(REGISTRY_ADDRESS),
  };
}

describe(
  'validateQuicknetConsumers',
  () => {
    beforeEach(() => {
      vi.mocked(
        validateQuicknetConsumer,
      ).mockReset();
    });

    it('validates every configured consumer', async () => {
      vi.mocked(
        validateQuicknetConsumer,
      )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_A,
          ),
        )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_B,
          ),
        );

      const result =
        await validateQuicknetConsumers({
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumers: [
            CONSUMER_A,
            CONSUMER_B,
          ],
        });

      expect(result).toEqual([
        validatedConsumer(
          CONSUMER_A,
        ),
        validatedConsumer(
          CONSUMER_B,
        ),
      ]);

      expect(
        validateQuicknetConsumer,
      ).toHaveBeenCalledTimes(2);
    });

    it('passes the same public client and deployment to every validation', async () => {
      vi.mocked(
        validateQuicknetConsumer,
      )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_A,
          ),
        )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_B,
          ),
        );

      await validateQuicknetConsumers({
        publicClient: PUBLIC_CLIENT,
        deployment: DEPLOYMENT,
        consumers: [
          CONSUMER_A,
          CONSUMER_B,
        ],
      });

      expect(
        validateQuicknetConsumer,
      ).toHaveBeenNthCalledWith(
        1,
        {
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumer: CONSUMER_A,
        },
      );

      expect(
        validateQuicknetConsumer,
      ).toHaveBeenNthCalledWith(
        2,
        {
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumer: CONSUMER_B,
        },
      );
    });

    it('preserves configured consumer order', async () => {
      vi.mocked(
        validateQuicknetConsumer,
      )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_B,
          ),
        )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_A,
          ),
        );

      const result =
        await validateQuicknetConsumers({
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumers: [
            CONSUMER_B,
            CONSUMER_A,
          ],
        });

      expect(result).toEqual([
        validatedConsumer(
          CONSUMER_B,
        ),
        validatedConsumer(
          CONSUMER_A,
        ),
      ]);
    });

    it('returns an empty array for an empty consumer list', async () => {
      const result =
        await validateQuicknetConsumers({
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumers: [],
        });

      expect(result).toEqual([]);

      expect(
        validateQuicknetConsumer,
      ).not.toHaveBeenCalled();
    });

    it('propagates a consumer validation failure', async () => {
      const failure = new Error('Consumer uses the wrong registry.');

      vi.mocked(
        validateQuicknetConsumer,
      )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_A,
          ),
        )
        .mockRejectedValueOnce(
          failure,
        );

      await expect(
        validateQuicknetConsumers({
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumers: [
            CONSUMER_A,
            CONSUMER_B,
          ],
        }),
      ).rejects.toBe(
        failure,
      );
    });

    it('stops validating after the first failure', async () => {
      vi.mocked(
        validateQuicknetConsumer,
      )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_A,
          ),
        )
        .mockRejectedValueOnce(
          new Error('Invalid consumer.'),
        );

      await expect(
        validateQuicknetConsumers({
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumers: [
            CONSUMER_A,
            CONSUMER_B,
            CONSUMER_C,
          ],
        }),
      ).rejects.toThrow(
        'Invalid consumer.',
      );

      expect(
        validateQuicknetConsumer,
      ).toHaveBeenCalledTimes(2);

      expect(
        validateQuicknetConsumer,
      ).not.toHaveBeenCalledWith({
        publicClient: PUBLIC_CLIENT,
        deployment: DEPLOYMENT,
        consumer: CONSUMER_C,
      });
    });

    it('validates consumers sequentially', async () => {
      let resolveFirst:
        | ((
            value: ReturnType<
              typeof validatedConsumer
            >,
          ) => void)
        | undefined;

      const first =
        new Promise<
          ReturnType<
            typeof validatedConsumer
          >
        >((resolve) => {
          resolveFirst =
            resolve;
        });

      vi.mocked(
        validateQuicknetConsumer,
      )
        .mockReturnValueOnce(
          first,
        )
        .mockResolvedValueOnce(
          validatedConsumer(
            CONSUMER_B,
          ),
        );

      const validation =
        validateQuicknetConsumers({
          publicClient: PUBLIC_CLIENT,
          deployment: DEPLOYMENT,
          consumers: [
            CONSUMER_A,
            CONSUMER_B,
          ],
        });

      await Promise.resolve();

      expect(
        validateQuicknetConsumer,
      ).toHaveBeenCalledTimes(1);

      if (resolveFirst === undefined) {
        throw new Error('Expected first consumer validation promise to be initialized.');
      }

      resolveFirst(
        validatedConsumer(
          CONSUMER_A,
        ),
      );

      await validation;

      expect(
        validateQuicknetConsumer,
      ).toHaveBeenCalledTimes(2);
    });
  },
);
