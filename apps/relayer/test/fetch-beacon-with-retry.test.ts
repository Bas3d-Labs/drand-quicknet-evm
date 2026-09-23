// apps/relayer/test/fetch-beacon-with-retry.test.ts

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  CompressedSignature,
  QuicknetBeacon,
} from '@based-labs/drand-quicknet';

const quicknetMocks = vi.hoisted(() => ({
  fetchBeacon: vi.fn(),
}));

vi.mock(
  '@based-labs/drand-quicknet',
  () => quicknetMocks,
);

import {
  fetchQuicknetBeaconWithRetry,
} from '../src/rounds/fetch-beacon-with-retry.js';

const ROUND = 31_089_008n;

const COMPRESSED_SIGNATURE =
  `0x${'11'.repeat(48)}` as CompressedSignature;

const BEACON: QuicknetBeacon = {
  round: ROUND,
  signature: COMPRESSED_SIGNATURE,
};

describe('fetchQuicknetBeaconWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    quicknetMocks.fetchBeacon
      .mockResolvedValue(BEACON);
  });

  it('rejects round zero without fetching', async () => {
    const sleep = vi.fn();

    await expect(
      fetchQuicknetBeaconWithRetry({
        round: 0n,
        sleep,
      }),
    ).rejects.toThrow(
      'Quicknet round must be greater than zero.',
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative round without fetching', async () => {
    const sleep = vi.fn();

    await expect(
      fetchQuicknetBeaconWithRetry({
        round: -1n,
        sleep,
      }),
    ).rejects.toThrow(
      RangeError,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('returns the beacon on the first successful attempt', async () => {
    const sleep = vi.fn();

    const result =
      await fetchQuicknetBeaconWithRetry({
        round: ROUND,
        sleep,
      });

    expect(result).toBe(
      BEACON,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledOnce();

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledWith(
      ROUND,
    );

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('retries after a fetch failure and returns the beacon', async () => {
    const firstError =
      new Error(
        'Round not available yet.',
      );

    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        firstError,
      )
      .mockResolvedValueOnce(
        BEACON,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    const result =
      await fetchQuicknetBeaconWithRetry({
        round: ROUND,
        sleep,
      });

    expect(result).toBe(
      BEACON,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledTimes(2);

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenNthCalledWith(
      1,
      ROUND,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenNthCalledWith(
      2,
      ROUND,
    );

    expect(
      sleep,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      250,
    );
  });

  it('retries the same exact round on every attempt', async () => {
    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        new Error('First failure.'),
      )
      .mockRejectedValueOnce(
        new Error('Second failure.'),
      )
      .mockResolvedValueOnce(
        BEACON,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    await fetchQuicknetBeaconWithRetry({
      round: ROUND,
      sleep,
    });

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledTimes(3);

    for (
      const call of
      quicknetMocks.fetchBeacon.mock.calls
    ) {
      expect(call).toEqual([
        ROUND,
      ]);
    }
  });

  it('uses the configured retry delay', async () => {
    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        new Error('Not ready.'),
      )
      .mockResolvedValueOnce(
        BEACON,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    await fetchQuicknetBeaconWithRetry({
      round: ROUND,
      retryDelayMs: 125,
      sleep,
    });

    expect(
      sleep,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      125,
    );
  });

  it('allows a retry delay of zero', async () => {
    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        new Error('Not ready.'),
      )
      .mockResolvedValueOnce(
        BEACON,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    await fetchQuicknetBeaconWithRetry({
      round: ROUND,
      retryDelayMs: 0,
      sleep,
    });

    expect(
      sleep,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      0,
    );
  });

  it('sleeps only between attempts', async () => {
    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        new Error('First failure.'),
      )
      .mockRejectedValueOnce(
        new Error('Second failure.'),
      )
      .mockResolvedValueOnce(
        BEACON,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    await fetchQuicknetBeaconWithRetry({
      round: ROUND,
      maxAttempts: 3,
      sleep,
    });

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledTimes(3);

    expect(
      sleep,
    ).toHaveBeenCalledTimes(2);
  });

  it('stops retrying immediately after a successful attempt', async () => {
    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        new Error('First failure.'),
      )
      .mockResolvedValueOnce(
        BEACON,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    await fetchQuicknetBeaconWithRetry({
      round: ROUND,
      maxAttempts: 8,
      sleep,
    });

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledTimes(2);

    expect(
      sleep,
    ).toHaveBeenCalledOnce();
  });

  it('fails after the configured maximum number of attempts', async () => {
    const lastError =
      new Error(
        'Still unavailable.',
      );

    quicknetMocks.fetchBeacon
      .mockRejectedValue(
        lastError,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 3,
        sleep,
      }),
    ).rejects.toThrow(
      `Failed to fetch Quicknet round ${ROUND} after 3 attempts.`,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledTimes(3);

    expect(
      sleep,
    ).toHaveBeenCalledTimes(2);
  });

  it('preserves the final fetch error as the cause', async () => {
    const firstError =
      new Error('First failure.');

    const finalError =
      new Error('Final failure.');

    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        firstError,
      )
      .mockRejectedValueOnce(
        finalError,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    let thrown: unknown;

    try {
      await fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 2,
        sleep,
      });
    } catch (error) {
      thrown = error;
    }

    expect(
      thrown,
    ).toBeInstanceOf(
      Error,
    );

    if (!(thrown instanceof Error)) {
      throw new Error(
        'Expected fetch to throw an Error.',
      );
    }

    expect(
      thrown.message,
    ).toBe(
      `Failed to fetch Quicknet round ${ROUND} after 2 attempts.`,
    );

    expect(
      thrown.cause,
    ).toBe(
      finalError,
    );
  });

  it('does not sleep after the final failed attempt', async () => {
    quicknetMocks.fetchBeacon
      .mockRejectedValue(
        new Error('Unavailable.'),
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 4,
        sleep,
      }),
    ).rejects.toThrow();

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledTimes(4);

    expect(
      sleep,
    ).toHaveBeenCalledTimes(3);
  });

  it('does not retry when maxAttempts is one', async () => {
    const error =
      new Error(
        'Unavailable.',
      );

    quicknetMocks.fetchBeacon
      .mockRejectedValue(
        error,
      );

    const sleep = vi.fn();

    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 1,
        sleep,
      }),
    ).rejects.toThrow(
      `Failed to fetch Quicknet round ${ROUND} after 1 attempts.`,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('treats a mismatched returned round as a failed attempt', async () => {
    const wrongBeacon: QuicknetBeacon = {
      ...BEACON,
      round: ROUND + 1n,
    };

    quicknetMocks.fetchBeacon
      .mockResolvedValueOnce(
        wrongBeacon,
      )
      .mockResolvedValueOnce(
        BEACON,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    const result =
      await fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 2,
        sleep,
      });

    expect(result).toBe(
      BEACON,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledTimes(2);

    expect(
      sleep,
    ).toHaveBeenCalledOnce();
  });

  it('preserves a final round mismatch as the failure cause', async () => {
    const wrongRound =
      ROUND + 1n;

    const wrongBeacon: QuicknetBeacon = {
      ...BEACON,
      round: wrongRound,
    };

    quicknetMocks.fetchBeacon
      .mockResolvedValue(
        wrongBeacon,
      );

    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    let thrown: unknown;

    try {
      await fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 2,
        sleep,
      });
    } catch (error) {
      thrown = error;
    }

    expect(
      thrown,
    ).toBeInstanceOf(
      Error,
    );

    if (!(thrown instanceof Error)) {
      throw new Error(
        'Expected fetch to throw an Error.',
      );
    }

    expect(
      thrown.cause,
    ).toBeInstanceOf(
      Error,
    );

    const cause =
      thrown.cause;

    if (!(cause instanceof Error)) {
      throw new Error(
        'Expected failure cause to be an Error.',
      );
    }

    expect(
      cause.message,
    ).toBe(
      `Quicknet round mismatch: requested ${ROUND}, received ${wrongRound}.`,
    );
  });

  it('propagates sleep failures without making another fetch attempt', async () => {
    quicknetMocks.fetchBeacon
      .mockRejectedValueOnce(
        new Error('Not ready.'),
      );

    const sleepError =
      new Error(
        'Sleep interrupted.',
      );

    const sleep =
      vi.fn().mockRejectedValue(
        sleepError,
      );

    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        sleep,
      }),
    ).rejects.toBe(
      sleepError,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).toHaveBeenCalledOnce();
  });

  it('rejects maxAttempts zero without fetching', async () => {
    const sleep = vi.fn();

    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 0,
        sleep,
      }),
    ).rejects.toThrow(
      'maxAttempts must be a positive safe integer.',
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });

  it('rejects a fractional maxAttempts', async () => {
    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts: 1.5,
      }),
    ).rejects.toThrow(
      'maxAttempts must be a positive safe integer.',
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });

  it('rejects an unsafe maxAttempts', async () => {
    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        maxAttempts:
          Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow(
      'maxAttempts must be a positive safe integer.',
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative retryDelayMs', async () => {
    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        retryDelayMs: -1,
      }),
    ).rejects.toThrow(
      'retryDelayMs must be a non-negative safe integer.',
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });

  it('rejects a fractional retryDelayMs', async () => {
    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        retryDelayMs: 1.5,
      }),
    ).rejects.toThrow(
      'retryDelayMs must be a non-negative safe integer.',
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });

  it('rejects an unsafe retryDelayMs', async () => {
    await expect(
      fetchQuicknetBeaconWithRetry({
        round: ROUND,
        retryDelayMs:
          Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow(
      'retryDelayMs must be a non-negative safe integer.',
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });
});