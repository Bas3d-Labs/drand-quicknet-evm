import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  PublicClient,
} from 'viem';

const finalityMocks = vi.hoisted(() => ({
  getDurableBlockNumber: vi.fn(),
}));

vi.mock(
  '../src/finality-policy.js',
  () => ({
    getDurableBlockNumber:
      finalityMocks.getDurableBlockNumber,
  }),
);

import {
  getChainHeads,
} from '../src/chain-heads.js';
import type {
  FinalityPolicy,
} from '../src/finality-policy.js';

const FINALITY: FinalityPolicy = {
  type: 'safe',
};

interface MockPublicClient {
  publicClient: PublicClient;
  getBlockNumber: ReturnType<typeof vi.fn>;
}

function createPublicClient(): MockPublicClient {
  const getBlockNumber = vi.fn();

  const publicClient = {
    getBlockNumber,
  } as unknown as PublicClient;

  return {
    publicClient,
    getBlockNumber,
  };
}

describe('getChainHeads', () => {
  let publicClient: PublicClient;
  let getBlockNumber: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    finalityMocks
      .getDurableBlockNumber
      .mockReset();

    const client =
      createPublicClient();

    publicClient =
      client.publicClient;

    getBlockNumber =
      client.getBlockNumber;
  });

  it('returns the latest and durable block numbers', async () => {
    finalityMocks
      .getDurableBlockNumber
      .mockResolvedValue(
        1_400n,
      );

    getBlockNumber.mockResolvedValue(
      1_500n,
    );

    const result =
      await getChainHeads({
        publicClient,
        finality: FINALITY,
      });

    expect(result).toEqual({
      latestBlock: 1_500n,
      durableBlock: 1_400n,
    });
  });

  it('uses the configured finality policy', async () => {
    finalityMocks
      .getDurableBlockNumber
      .mockResolvedValue(
        1_400n,
      );

    getBlockNumber.mockResolvedValue(
      1_500n,
    );

    await getChainHeads({
      publicClient,
      finality: FINALITY,
    });

    expect(
      finalityMocks
        .getDurableBlockNumber,
    ).toHaveBeenCalledOnce();

    expect(
      finalityMocks
        .getDurableBlockNumber,
    ).toHaveBeenCalledWith(
      publicClient,
      FINALITY,
    );
  });

  it('reads the latest block once', async () => {
    finalityMocks
      .getDurableBlockNumber
      .mockResolvedValue(
        1_400n,
      );

    getBlockNumber.mockResolvedValue(
      1_500n,
    );

    await getChainHeads({
      publicClient,
      finality: FINALITY,
    });

    expect(
      getBlockNumber,
    ).toHaveBeenCalledOnce();
  });

  it('reads the durable block before the latest block', async () => {
    finalityMocks
      .getDurableBlockNumber
      .mockResolvedValue(
        1_400n,
      );

    getBlockNumber.mockResolvedValue(
      1_500n,
    );

    await getChainHeads({
      publicClient,
      finality: FINALITY,
    });

    const durableCallOrder =
      finalityMocks
        .getDurableBlockNumber
        .mock
        .invocationCallOrder[0];

    const latestCallOrder =
      getBlockNumber
        .mock
        .invocationCallOrder[0];

    expect(
      durableCallOrder,
    ).toBeDefined();

    expect(
      latestCallOrder,
    ).toBeDefined();

    if (
      durableCallOrder === undefined ||
      latestCallOrder === undefined
    ) {
      throw new Error(
        'Expected both chain head calls.'
      );
    }

    expect(
      durableCallOrder,
    ).toBeLessThan(
      latestCallOrder
    );
  });

  it('allows the durable block to equal the latest block', async () => {
    finalityMocks
      .getDurableBlockNumber
      .mockResolvedValue(
        1_500n,
      );

    getBlockNumber.mockResolvedValue(
      1_500n,
    );

    const result =
      await getChainHeads({
        publicClient,
        finality: FINALITY,
      });

    expect(result).toEqual({
      latestBlock: 1_500n,
      durableBlock: 1_500n,
    });
  });

  it('rejects a durable block ahead of the latest block', async () => {
    finalityMocks
      .getDurableBlockNumber
      .mockResolvedValue(
        1_501n,
      );

    getBlockNumber.mockResolvedValue(
      1_500n,
    );

    await expect(
      getChainHeads({
        publicClient,
        finality: FINALITY,
      }),
    ).rejects.toThrow(
      'Durable block 1501 is ahead of latest block 1500.'
    );
  });

  it('propagates durable block failures', async () => {
    const failure =
      new Error(
        'Failed to read safe block.',
      );

    finalityMocks
      .getDurableBlockNumber
      .mockRejectedValue(
        failure,
      );

    await expect(
      getChainHeads({
        publicClient,
        finality: FINALITY,
      }),
    ).rejects.toBe(
      failure,
    );

    expect(
      getBlockNumber,
    ).not.toHaveBeenCalled();
  });

  it('propagates latest block failures', async () => {
    const failure =
      new Error(
        'Failed to read latest block.',
      );

    finalityMocks
      .getDurableBlockNumber
      .mockResolvedValue(
        1_400n,
      );

    getBlockNumber.mockRejectedValue(
      failure,
    );

    await expect(
      getChainHeads({
        publicClient,
        finality: FINALITY,
      }),
    ).rejects.toBe(
      failure,
    );
  });
});