import { roundScheduledTime } from "@based-labs/drand-quicknet";

export interface WaitForQuicknetRoundOptions {
  round: bigint;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
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

  await sleep(Number(delayMilliseconds));
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise(
    (resolve) => {
      setTimeout(resolve, milliseconds);
    }
  );
}