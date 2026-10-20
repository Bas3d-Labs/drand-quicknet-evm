import {
  type NetworkSource,
} from '../config/config.js';

import {
  assertServiceLockHeld,
} from '../state/service-lock.js';

import type {
  CliOptions,
  CliOutcome,
} from './cli-types.js';

import {
  parseCommandArguments,
} from './parse-command-arguments.js';

import {
  runWithShutdownSignal,
} from './run-with-shutdown-signal.js';

import {
  runDaemonCommand,
} from './commands/daemon-command.js';

import {
  runRoundImportCommand,
} from './commands/round-import-command.js';

import {
  runStatusCommand,
} from './commands/status-command.js';

import {
  runSyncNonceCommand,
} from './commands/sync-nonce-command.js';

import type {
  CliOutputHandler,
} from './output/cli-output.js';

export async function main(
  args: readonly string[],
  output: CliOutputHandler,
  options: CliOptions = {},
): Promise<CliOutcome> {
  const normalizedArgs = normalizeArguments(args);
  const command = parseCommandArguments(normalizedArgs);

  switch (command.command) {
    case 'import':
    case 'import-when-available':
      assertServiceLockHeld();
      return runWithShutdownSignal(
        (signal) => runRoundImportCommand(
          command,
          output,
          options,
          signal,
        ),
        'interrupted',
      );
    
    case 'daemon':
      return runDaemonCli(command.source, output, options);  
      
    case 'daemon-help':
      output({ type: 'daemon-help' });
      return 'success';

    case 'sync-nonce':
      assertServiceLockHeld();
      return runWithShutdownSignal(
        (signal) => runSyncNonceCommand(
          command,
          output,
          options,
          signal,
        ),
        'interrupted',
      );

    case 'status':
      return runWithShutdownSignal(
        (signal) => runStatusCommand(
          command,
          output,
          signal,
        ),
        'interrupted',
      );

    case 'help':
      output({ type: 'help' });
      return 'success';
  }
}

async function runDaemonCli(
  source: NetworkSource,
  output: CliOutputHandler,
  options: CliOptions,
): Promise<CliOutcome> {
  return runWithShutdownSignal(async (signal) => {
    await runDaemonCommand({
      source,
      signal,
      onStartup(summary) {
        output({
          type: 'daemon-startup',
          summary,
        });
      },
      onDiagnostics(policy) {
        options.onDiagnostics?.(policy);
      },
    });

    return 'success';
  }, 'success');
}

function normalizeArguments(
  args: readonly string[],
): readonly string[] {
  if (args[0] === '--') {
    return args.slice(1);
  }

  return args;
}