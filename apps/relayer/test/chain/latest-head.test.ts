import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  readLatestHead,
} from '../../src/chain/latest-head.js';

describe('readLatestHead', () => {
  it('reads an uncached latest height and timestamps the completed read', async () => {
    const order: string[] = [];

    const getBlockNumber = vi.fn(async () => {
      order.push('head');

      return 12n;
    });

    const observationClock = () => {
      order.push('clock');

      return 1_000;
    };

    const result = await readLatestHead({
      publicClient: { getBlockNumber },
      observationClock,
    });

    expect(result).toEqual({
      latestBlock: 12n,
      latestBlockObservedAt: '1970-01-01T00:00:01.000Z',
    });
    expect(getBlockNumber).toHaveBeenCalledExactlyOnceWith({ cacheTime: 0 });
    expect(order).toEqual(['head', 'clock']);
  });

  it.each([
    undefined,
    () => NaN,
    () => { throw new Error('clock failed'); },
  ])('does not replace a height when the diagnostic clock is unavailable', async (clock) => {
    const result = await readLatestHead({
      publicClient: { getBlockNumber: vi.fn(async () => 12n) },
      observationClock: clock,
    });

    expect(result).toEqual({ latestBlock: 12n });
  });

  it('propagates a head failure without sampling the observation clock', async () => {
    const failure = new Error('head unavailable');

    const observationClock = vi.fn(() => 1_000);

    await expect(readLatestHead({
      publicClient: { getBlockNumber: vi.fn().mockRejectedValue(failure) },
      observationClock,
    })).rejects.toBe(failure);

    expect(observationClock).not.toHaveBeenCalled();
  });
});
