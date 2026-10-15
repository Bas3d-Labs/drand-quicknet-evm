
import {
  roundScheduledTime
} from "@based-labs/drand-quicknet";

import {
  sleepFor,
} from '../shared/sleep-for.js';

export interface WaitForQuicknetRoundOptions {
  round: bigint;
  now?: () => number;
  signal?: AbortSignal;
  sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export async function waitForQuicknetRound(
  options: WaitForQuicknetRoundOptions
): Promise<void> {
  const {
    round,
    now = Date.now,
    sleep = sleepFor,
  } = options;

  if (round <= 0n) {
    throw new RangeError('Quicknet round must be greater than zero.');
  }

  options.signal?.throwIfAborted();

  const scheduledTimestamp = roundScheduledTime(round);
  const scheduledMilliseconds = scheduledTimestamp * 1000n;
  const nowMilliseconds = BigInt(now());

  if (scheduledMilliseconds <= nowMilliseconds) {
    return;
  }

  const delayMilliseconds = scheduledMilliseconds - nowMilliseconds;
  if (delayMilliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Quicknet round ${round} is too far in the future to wait for safely.`);
  }

  if (options.signal === undefined) {
    await sleep(Number(delayMilliseconds));
  } else {
    await sleep(Number(delayMilliseconds), options.signal);
  }

  options.signal?.throwIfAborted();
}