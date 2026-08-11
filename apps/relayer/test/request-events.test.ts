import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import {
  QUICKNET_RANDOMNESS_REQUESTED_EVENT,
} from '../src/consumer-abi.js';
import {
  getQuicknetRandomnessRequests,
} from '../src/request-events.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';

const TRANSACTION_HASH_A: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const TRANSACTION_HASH_B: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const TRANSACTION_HASH_C: Hex =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

interface MockPublicClient {
  publicClient: PublicClient;
  getLogs: ReturnType<typeof vi.fn>;
}

function createPublicClient(): MockPublicClient {
  const getLogs = vi.fn();
  const publicClient = {
    getLogs,
  } as unknown as PublicClient;

  return {
    publicClient,
    getLogs,
  };
}

function createRequestLog(
  options: {
    consumer?: Address;
    round?: bigint;
    blockNumber?: bigint | null;
    transactionHash?: Hex | null;
    logIndex?: number | null;
  } = {},
) {
  return {
    address: options.consumer ?? CONSUMER_A,
    args: {
      round: options.round ?? 31_192_648n,
    },
    blockNumber:
      options.blockNumber ===
      undefined
        ? 1_000n
        : options.blockNumber,
    transactionHash:
      options.transactionHash ===
      undefined
        ? TRANSACTION_HASH_A
        : options.transactionHash,
    logIndex:
      options.logIndex ===
      undefined
        ? 0
        : options.logIndex,
  };
}

describe(
  'getQuicknetRandomnessRequests',
  () => {
    let publicClient: PublicClient;
    let getLogs: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const client = createPublicClient();
      publicClient = client.publicClient;
      getLogs = client.getLogs;
    });

    it('returns one Quicknet randomness request', async () => {
      getLogs.mockResolvedValue([
        createRequestLog({
          consumer: CONSUMER_A,
          round: 31_192_648n,
          blockNumber: 1_234n,
          transactionHash: TRANSACTION_HASH_A,
          logIndex: 7,
        }),
      ]);

      const result =
        await getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 1_200n,
          toBlock: 1_300n,
        });

      expect(result).toEqual([
        {
          consumer: CONSUMER_A,
          round: 31_192_648n,
          blockNumber: 1_234n,
          transactionHash: TRANSACTION_HASH_A,
          logIndex: 7,
        },
      ]);
    });

    it('queries only the configured consumers and requested block range', async () => {
      getLogs.mockResolvedValue(
        [],
      );

      await getQuicknetRandomnessRequests({
        publicClient,
        consumers: [
          CONSUMER_A,
          CONSUMER_B,
        ],
        fromBlock: 5_000n,
        toBlock: 5_100n,
      });

      expect(
        getLogs,
      ).toHaveBeenCalledOnce();

      expect(
        getLogs,
      ).toHaveBeenCalledWith({
        address: [
          CONSUMER_A,
          CONSUMER_B,
        ],
        event: QUICKNET_RANDOMNESS_REQUESTED_EVENT,
        fromBlock: 5_000n,
        toBlock: 5_100n,
        strict: true,
      });
    });

    it('returns requests from multiple consumers', async () => {
      getLogs.mockResolvedValue([
        createRequestLog({
          consumer: CONSUMER_A,
          round: 100n,
          blockNumber: 1_000n,
          transactionHash: TRANSACTION_HASH_A,
          logIndex: 0,
        }),
        createRequestLog({
          consumer: CONSUMER_B,
          round: 101n,
          blockNumber: 1_001n,
          transactionHash: TRANSACTION_HASH_B,
          logIndex: 1,
        }),
      ]);

      const result =
        await getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
            CONSUMER_B,
          ],
          fromBlock: 1_000n,
          toBlock: 1_001n,
        });

      expect(result).toEqual([
        {
          consumer: CONSUMER_A,
          round: 100n,
          blockNumber: 1_000n,
          transactionHash: TRANSACTION_HASH_A,
          logIndex: 0,
        },
        {
          consumer: CONSUMER_B,
          round: 101n,
          blockNumber: 1_001n,
          transactionHash: TRANSACTION_HASH_B,
          logIndex: 1,
        },
      ]);
    });

    it('preserves multiple requests for the same round', async () => {
      getLogs.mockResolvedValue([
        createRequestLog({
          consumer: CONSUMER_A,
          round: 200n,
          blockNumber: 1_000n,
          transactionHash: TRANSACTION_HASH_A,
          logIndex: 0,
        }),
        createRequestLog({
          consumer: CONSUMER_B,
          round: 200n,
          blockNumber: 1_001n,
          transactionHash: TRANSACTION_HASH_B,
          logIndex: 0,
        }),
        createRequestLog({
          consumer: CONSUMER_A,
          round: 200n,
          blockNumber: 1_002n,
          transactionHash: TRANSACTION_HASH_C,
          logIndex: 4,
        }),
      ]);

      const result =
        await getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
            CONSUMER_B,
          ],
          fromBlock:
            1_000n,
          toBlock:
            1_002n,
        });

      expect(result).toHaveLength(3);

      expect(
        result.map(
          (request) => request.round,
        ),
      ).toEqual([
        200n,
        200n,
        200n,
      ]);

      expect(
        result.map(
          (request) => request.consumer,
        ),
      ).toEqual([
        CONSUMER_A,
        CONSUMER_B,
        CONSUMER_A,
      ]);
    });

    it('preserves log order returned by the client', async () => {
      getLogs.mockResolvedValue([
        createRequestLog({
          round: 300n,
          blockNumber: 1_003n,
          transactionHash: TRANSACTION_HASH_C,
          logIndex: 2,
        }),
        createRequestLog({
          round: 100n,
          blockNumber: 1_001n,
          transactionHash: TRANSACTION_HASH_A,
          logIndex: 0,
        }),
        createRequestLog({
          round: 200n,
          blockNumber: 1_002n,
          transactionHash: TRANSACTION_HASH_B,
          logIndex: 1,
        }),
      ]);

      const result =
        await getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 1_000n,
          toBlock: 1_010n,
        });

      expect(
        result.map(
          (request) => request.round,
        ),
      ).toEqual([
        300n,
        100n,
        200n,
      ]);
    });

    it('returns an empty array when no matching logs exist', async () => {
      getLogs.mockResolvedValue(
        [],
      );

      const result =
        await getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 1_000n,
          toBlock: 2_000n,
        });

      expect(result).toEqual(
        [],
      );
    });

    it('returns an empty array without querying RPC when no consumers are configured', async () => {
      const result =
        await getQuicknetRandomnessRequests({
          publicClient,
          consumers: [],
          fromBlock: 1_000n,
          toBlock: 2_000n,
        });

      expect(result).toEqual(
        [],
      );

      expect(
        getLogs,
      ).not.toHaveBeenCalled();
    });

    it('rejects a block range where fromBlock is greater than toBlock', async () => {
      await expect(
        getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 2_001n,
          toBlock: 2_000n,
        }),
      ).rejects.toThrow('fromBlock must not be greater than toBlock.');

      expect(
        getLogs,
      ).not.toHaveBeenCalled();
    });

    it('accepts a single-block range', async () => {
      getLogs.mockResolvedValue(
        [],
      );

      await getQuicknetRandomnessRequests({
        publicClient,
        consumers: [
          CONSUMER_A,
        ],
        fromBlock: 2_000n,
        toBlock: 2_000n,
      });

      expect(
        getLogs,
      ).toHaveBeenCalledWith({
        address: [
          CONSUMER_A,
        ],
        event: QUICKNET_RANDOMNESS_REQUESTED_EVENT,
        fromBlock: 2_000n,
        toBlock: 2_000n,
        strict: true,
      });
    });

    it('propagates getLogs failures', async () => {
      const failure = new Error('RPC request failed.');

      getLogs.mockRejectedValue(
        failure,
      );

      await expect(
        getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 1_000n,
          toBlock: 2_000n,
        }),
      ).rejects.toBe(
        failure,
      );
    });

    it('rejects a log without a block number', async () => {
      getLogs.mockResolvedValue([
        createRequestLog({
          blockNumber: null,
        }),
      ]);

      await expect(
        getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 1_000n,
          toBlock: 2_000n,
        }),
      ).rejects.toThrow(
        'Quicknet randomness request log is missing canonical log metadata.'
      );
    });

    it('rejects a log without a transaction hash', async () => {
      getLogs.mockResolvedValue([
        createRequestLog({
          transactionHash: null,
        }),
      ]);

      await expect(
        getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 1_000n,
          toBlock: 2_000n,
        }),
      ).rejects.toThrow(
        'Quicknet randomness request log is missing canonical log metadata.'
      );
    });

    it('rejects a log without a log index', async () => {
      getLogs.mockResolvedValue([
        createRequestLog({
          logIndex:
            null,
        }),
      ]);

      await expect(
        getQuicknetRandomnessRequests({
          publicClient,
          consumers: [
            CONSUMER_A,
          ],
          fromBlock: 1_000n,
          toBlock: 2_000n,
        }),
      ).rejects.toThrow(
        'Quicknet randomness request log is missing canonical log metadata.'
      );
    });
  },
);