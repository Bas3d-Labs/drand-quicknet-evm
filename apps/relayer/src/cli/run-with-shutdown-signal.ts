import process from 'node:process';

import type {
  CliOutcome,
} from './cli-types.js';

export async function runWithShutdownSignal(
  run: (signal: AbortSignal) => Promise<CliOutcome>,
  interruptedOutcome: 'success' | 'interrupted',
): Promise<CliOutcome> {
  const controller = new AbortController();

  const handleShutdown = (): void => {
    controller.abort();
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (
      !controller.signal.aborted ||
      error !== controller.signal.reason
    ) {
      throw error;
    }

    return interruptedOutcome;
  } finally {
    process.removeListener('SIGINT', handleShutdown);
    process.removeListener('SIGTERM', handleShutdown);
  }
}