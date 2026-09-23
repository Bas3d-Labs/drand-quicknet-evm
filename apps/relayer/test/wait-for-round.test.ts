import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  waitForQuicknetRound,
} from '../src/rounds/wait-for-round.js';

const ROUND = 31_089_008n;

const SCHEDULED_MILLISECONDS = roundScheduledTime(ROUND) * 1_000n;

describe('waitForQuicknetRound', () => {
  it('rejects round zero', async () => {
    const sleep = vi.fn();

    await expect(
      waitForQuicknetRound({
        round: 0n,
        sleep,
      }),
    ).rejects.toThrow(
      'Quicknet round must be greater than zero.',
    );

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative round', async () => {
    const sleep = vi.fn();

    await expect(
      waitForQuicknetRound({
        round: -1n,
        sleep,
      }),
    ).rejects.toThrow(
      RangeError,
    );

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('returns immediately when the round is already in the past', async () => {
    const sleep = vi.fn();

    const now =
      vi.fn().mockReturnValue(
        Number(
          SCHEDULED_MILLISECONDS +
            10_000n,
        ),
      );

    await waitForQuicknetRound({
      round: ROUND,
      now,
      sleep,
    });

    expect(
      now,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('returns immediately at the exact scheduled time', async () => {
    const sleep = vi.fn();

    const now =
      vi.fn().mockReturnValue(
        Number(
          SCHEDULED_MILLISECONDS,
        ),
      );

    await waitForQuicknetRound({
      round: ROUND,
      now,
      sleep,
    });

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('waits for the exact remaining time when the round is in the future', async () => {
    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    const remainingMilliseconds =
      2_250;

    const now =
      vi.fn().mockReturnValue(
        Number(
          SCHEDULED_MILLISECONDS -
            BigInt(
              remainingMilliseconds,
            ),
        ),
      );

    await waitForQuicknetRound({
      round: ROUND,
      now,
      sleep,
    });

    expect(
      sleep,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      remainingMilliseconds,
    );
  });

  it('waits for one millisecond when one millisecond early', async () => {
    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    const now =
      vi.fn().mockReturnValue(
        Number(
          SCHEDULED_MILLISECONDS -
            1n,
        ),
      );

    await waitForQuicknetRound({
      round: ROUND,
      now,
      sleep,
    });

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      1,
    );
  });

  it('does not add an arbitrary publication buffer', async () => {
    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    const remainingMilliseconds =
      500;

    const now =
      vi.fn().mockReturnValue(
        Number(
          SCHEDULED_MILLISECONDS -
            BigInt(
              remainingMilliseconds,
            ),
        ),
      );

    await waitForQuicknetRound({
      round: ROUND,
      now,
      sleep,
    });

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      remainingMilliseconds,
    );

    expect(
      sleep,
    ).not.toHaveBeenCalledWith(
      remainingMilliseconds + 500,
    );
  });

  it('propagates sleep failures', async () => {
    const error =
      new Error(
        'Sleep interrupted.',
      );

    const sleep =
      vi.fn().mockRejectedValue(
        error,
      );

    const now =
      vi.fn().mockReturnValue(
        Number(
          SCHEDULED_MILLISECONDS -
            1_000n,
        ),
      );

    await expect(
      waitForQuicknetRound({
        round: ROUND,
        now,
        sleep,
      }),
    ).rejects.toBe(
      error,
    );

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      1_000,
    );
  });

  it('reads the current time only once', async () => {
    const sleep =
      vi.fn().mockResolvedValue(
        undefined,
      );

    const now =
      vi.fn().mockReturnValue(
        Number(
          SCHEDULED_MILLISECONDS -
            1_000n,
        ),
      );

    await waitForQuicknetRound({
      round: ROUND,
      now,
      sleep,
    });

    expect(
      now,
    ).toHaveBeenCalledOnce();
  });

  it('rejects a wait duration larger than Number.MAX_SAFE_INTEGER', async () => {
    const sleep = vi.fn();

    const now =
      vi.fn().mockReturnValue(0);

    const veryDistantRound =
      10_000_000_000_000_000n;

    await expect(
      waitForQuicknetRound({
        round:
          veryDistantRound,
        now,
        sleep,
      }),
    ).rejects.toThrow(
      `Quicknet round ${veryDistantRound} is too far in the future to wait for safely.`,
    );

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });
});