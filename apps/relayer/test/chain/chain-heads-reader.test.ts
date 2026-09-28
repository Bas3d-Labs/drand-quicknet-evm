import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import {
  createChainHeadsReader,
} from '../../src/chain/chain-heads-reader.js';

import type {
  FinalityPolicy,
} from '../../src/chain/finality-policy.js';

function setup(
  finality: FinalityPolicy = { type: 'safe' },
) {
  let now = 0;

  const getBlock = vi.fn().mockResolvedValue({
    number: 100n,
  });

  const getBlockNumber = vi.fn().mockResolvedValue(120n);

  const publicClient = {
    getBlock,
    getBlockNumber,
  } as unknown as PublicClient;

  const read = createChainHeadsReader({
    publicClient,
    finality,
    durableHeadPollIntervalMs: 30_000,
    now: () => now,
  });

  return {
    read,
    getBlock,
    getBlockNumber,
    setTime(value: number): void {
      now = value;
    },
  };
}

describe('createChainHeadsReader', () => {
  it.each(['safe', 'finalized'] as const)(
    'refreshes %s at expiration without extending it on hits',
    async (type) => {
      const client = setup({ type });

      await expect(client.read()).resolves.toEqual({
        latestBlock: 120n,
        durableBlock: 100n,
      });

      client.getBlock.mockResolvedValue({ number: 110n });
      client.getBlockNumber.mockResolvedValue(130n);
      client.setTime(29_999);

      await expect(client.read()).resolves.toEqual({
        latestBlock: 130n,
        durableBlock: 100n,
      });

      expect(client.getBlock).toHaveBeenCalledOnce();

      client.setTime(30_000);

      await expect(client.read()).resolves.toEqual({
        latestBlock: 130n,
        durableBlock: 110n,
      });

      expect(client.getBlock).toHaveBeenCalledTimes(2);
      expect(client.getBlock).toHaveBeenCalledWith({
        blockTag: type,
      });
      expect(client.getBlockNumber).toHaveBeenCalledTimes(3);
    },
  );

  it('returns a lower durable head after refresh', async () => {
    const client = setup();

    await client.read();

    client.setTime(30_000);
    client.getBlock.mockResolvedValue({ number: 90n });

    await expect(client.read()).resolves.toEqual({
      latestBlock: 120n,
      durableBlock: 90n,
    });
  });

  it('propagates refresh failure and retries on the next read', async () => {
    const client = setup();
    const failure = new Error('Safe head unavailable.');

    await client.read();

    client.setTime(30_000);
    client.getBlock.mockRejectedValueOnce(failure);

    await expect(client.read()).rejects.toBe(failure);

    client.getBlock.mockResolvedValue({ number: 110n });

    await expect(client.read()).resolves.toEqual({
      latestBlock: 120n,
      durableBlock: 110n,
    });

    expect(client.getBlock).toHaveBeenCalledTimes(3);
  });

  it('invalidates cached data when latest falls below durable', async () => {
    const client = setup();

    await client.read();

    client.getBlockNumber.mockResolvedValue(90n);

    await expect(client.read()).rejects.toThrow(
      'Durable block 100 is ahead of latest block 90.',
    );

    client.getBlock.mockResolvedValue({ number: 80n });

    await expect(client.read()).resolves.toEqual({
      latestBlock: 90n,
      durableBlock: 80n,
    });

    expect(client.getBlock).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached data after a latest-head failure', async () => {
    const client = setup();
    const failure = new Error('Latest head unavailable.');

    await client.read();

    client.getBlockNumber.mockRejectedValueOnce(failure);

    await expect(client.read()).rejects.toBe(failure);

    client.getBlock.mockResolvedValue({ number: 110n });

    await expect(client.read()).resolves.toEqual({
      latestBlock: 120n,
      durableBlock: 110n,
    });

    expect(client.getBlock).toHaveBeenCalledTimes(2);
  });

  it('does not cache an inconsistent refresh', async () => {
    const client = setup();

    client.getBlock.mockResolvedValueOnce({ number: 130n });

    await expect(client.read()).rejects.toThrow(
      'Durable block 130 is ahead of latest block 120.',
    );

    await expect(client.read()).resolves.toEqual({
      latestBlock: 120n,
      durableBlock: 100n,
    });

    expect(client.getBlock).toHaveBeenCalledTimes(2);
  });

  it('measures expiration from the start of the refresh', async () => {
    const client = setup();

    client.getBlock.mockImplementationOnce(async () => {
      client.setTime(30_000);
      return { number: 100n };
    });

    await client.read();

    client.getBlock.mockResolvedValue({ number: 110n });

    await expect(client.read()).resolves.toEqual({
      latestBlock: 120n,
      durableBlock: 110n,
    });

    expect(client.getBlock).toHaveBeenCalledTimes(2);
  });

  it('does not cache confirmation-based durable heads', async () => {
    const client = setup({
      type: 'confirmations',
      confirmations: 20n,
    });

    await expect(client.read()).resolves.toEqual({
      latestBlock: 120n,
      durableBlock: 100n,
    });

    client.getBlockNumber.mockResolvedValue(140n);

    await expect(client.read()).resolves.toEqual({
      latestBlock: 140n,
      durableBlock: 120n,
    });

    expect(client.getBlock).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid interval: %s', (intervalMs) => {
    expect(() => createChainHeadsReader({
      publicClient: {} as PublicClient,
      finality: { type: 'safe' },
      durableHeadPollIntervalMs: intervalMs,
    })).toThrow(
      'durableHeadPollIntervalMs must be a positive safe integer.',
    );
  });
});