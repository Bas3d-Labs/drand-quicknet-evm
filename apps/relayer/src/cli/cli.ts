import {
  type NetworkSource,
} from '../config/config.js';

import type {
  SummarizeErrorOptions,
} from '../diagnostics/error-summary.js';

import type {
  RoundImportProgress,
} from '../diagnostics/operation-context.js';

import {
  assertServiceLockHeld,
} from '../state/service-lock.js';

import type {
  CliOutputHandler,
} from './cli-output.js';

import {
  runDaemonCommand,
} from './daemon-command.js';

import {
  parseCommandArguments,
} from './parse-command-arguments.js';

import {
  readRelayerStatus,
} from './read-relayer-status.js';

import {
  runRoundImportCommand,
} from './run-round-import-command.js';

import {
  runSyncNonceCommand,
} from './run-sync-nonce-command.js';

import {
  runWithShutdownSignal,
} from './run-with-shutdown-signal.js';

export interface CliOptions {
  onDiagnostics?: (
    policy: SummarizeErrorOptions | undefined,
  ) => void;
  onImportFailure?: (
    error: unknown,
    progress: RoundImportProgress,
  ) => void;
}

export type CliOutcome =
  | 'success'
  | 'failure'
  | 'pending'
  | 'deferred'
  | 'interrupted';

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
      return runWithShutdownSignal(async (signal) => {
        const result = await readRelayerStatus({
          ...command.config,
          signal,
        });

        output({
          type: 'relayer-status',
          result,
        });

        return 'success';
      }, 'interrupted');

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