import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

export interface WaitingRoundResult {
  status: 'waiting';
  reason: 'round-not-released';
  round: bigint;
  releaseTime: bigint;
}

/** Keep distant release times out of JavaScript numbers and timers. */
export function waitingRound(
  round: bigint,
  now: () => number = Date.now,
): WaitingRoundResult | undefined {
  if (round <= 0n) {
    return undefined;
  }

  const releaseTime = roundScheduledTime(round);

  if (releaseTime * 1000n <= BigInt(now())) {
    return undefined;
  }

  return {
    status: 'waiting',
    reason: 'round-not-released',
    round,
    releaseTime,
  };
}
