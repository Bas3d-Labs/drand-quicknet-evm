import {
  setTimeout as delay,
} from 'node:timers/promises';

export async function sleepFor(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    // Timer cancellation rejects with a wrapper error. Propagate
    // the signal's reason consistently with throwIfAborted().
    signal?.throwIfAborted();
    throw error;
  }
}