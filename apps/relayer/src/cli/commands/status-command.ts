import type {
  CliOutcome,
} from '../cli-types.js';

import type {
  CliOutputHandler,
} from '../output/cli-output.js';

import type {
  StatusCommandArguments,
} from '../parse-status-arguments.js';

import {
  readRelayerStatus,
} from '../read-relayer-status.js';

export async function runStatusCommand(
  command: StatusCommandArguments,
  output: CliOutputHandler,
  signal: AbortSignal,
): Promise<CliOutcome> {
  const result = await readRelayerStatus({
    ...command.config,
    signal,
  });

  output({
    type: 'relayer-status',
    result,
  });

  return 'success';
}