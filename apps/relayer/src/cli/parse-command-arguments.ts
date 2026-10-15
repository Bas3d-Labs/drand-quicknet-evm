import {
  parseRelayerNetworkPreset,
  type NetworkSource,
} from '../config/config.js';

import {
  UsageError,
} from '../diagnostics/usage-error.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  MAX_UINT64,
} from '../shared/uint.js';

import {
  parseStatusArguments,
  type StatusCommandArguments,
} from './parse-status-arguments.js';

export interface ImportCommandArguments {
  command: 'import';
  source: NetworkSource;
  round: bigint;
}

export interface ImportWhenAvailableCommandArguments {
  command: 'import-when-available';
  source: NetworkSource;
  round: bigint;
}

interface DaemonCommandArguments {
  command: 'daemon';
  source: NetworkSource;
}

interface DaemonHelpCommandArguments {
  command: 'daemon-help';
}

interface HelpCommandArguments {
  command: 'help';
}

export interface SyncNonceCommandArguments {
  command: 'sync-nonce';
  source: NetworkSource;
  apply: boolean;
}

type CommandArguments =
  | ImportCommandArguments
  | ImportWhenAvailableCommandArguments
  | DaemonCommandArguments
  | SyncNonceCommandArguments
  | StatusCommandArguments
  | DaemonHelpCommandArguments
  | HelpCommandArguments;

export function parseCommandArguments(
  args: readonly string[],
): CommandArguments {
  const command = args[0];

  if (args.includes('--help') || args.includes('-h')) {
    if (command === 'daemon') {
      return { command: 'daemon-help' };
    }

    return { command: 'help' };
  }

  if (
    command === undefined ||
    command === 'help'
  ) {
    return { command: 'help' };
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case 'import':
      return parseImportArguments(commandArgs);

    case 'import-when-available':
      return parseImportWhenAvailableArguments(commandArgs);

    case 'daemon':
      return parseDaemonArguments(commandArgs);
      
    case 'sync-nonce':
      return parseSyncNonceArguments(commandArgs);
    
    case 'status':
      return parseStatusArguments(commandArgs);

    default:
      throw new UsageError('UNKNOWN_COMMAND');
  }
}

function parseImportArguments(
  args: readonly string[],
): ImportCommandArguments {
  const parsed = parseRoundCommandOptions(args);

  return {
    command: 'import',
    source: parsed.source,
    round: parsed.round,
  };
}

function parseImportWhenAvailableArguments(
  args: readonly string[],
): ImportWhenAvailableCommandArguments {
  const parsed = parseRoundCommandOptions(args);

  return {
    command: 'import-when-available',
    source: parsed.source,
    round: parsed.round,
  };
}

function parseDaemonArguments(
  args: readonly string[],
):
  | DaemonCommandArguments
  | DaemonHelpCommandArguments {
  let source: NetworkSource | undefined;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new UsageError('EXPECTED_ARGUMENT');
    }

    if (argument === '--help' || argument === '-h') {
      return { command: 'daemon-help' };
    }

    const networkArgument = parseNetworkSourceArgument(args, i, source);
    if (networkArgument !== undefined) {
      source = networkArgument.source;
      i = networkArgument.nextIndex;
      
      continue;
    }

    throw new UsageError('UNKNOWN_ARGUMENT');
  }

  if (source === undefined) {
    throw new UsageError('MISSING_NETWORK');
  }

  return {
    command: 'daemon',
    source,
  };
}

function parseSyncNonceArguments(
  args: readonly string[],
): SyncNonceCommandArguments {
  let source: NetworkSource | undefined;
  let apply = false;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new UsageError('EXPECTED_ARGUMENT');
    }

    const networkArgument = parseNetworkSourceArgument(args, i, source);
    if (networkArgument !== undefined) {
      source = networkArgument.source;
      i = networkArgument.nextIndex;
      continue;
    }

    if (argument === '--apply') {
      if (apply) {
        throw new UsageError('DUPLICATE_APPLY');
      }

      apply = true;
      continue;
    }

    throw new UsageError('UNKNOWN_ARGUMENT');
  }

  if (source === undefined) {
    throw new UsageError('MISSING_NETWORK');
  }

  return {
    command: 'sync-nonce',
    source,
    apply,
  };
}

interface RoundCommandOptions {
  source: NetworkSource;
  round: bigint;
}

function parseRoundCommandOptions(
  args: readonly string[],
): RoundCommandOptions {
  let source: NetworkSource | undefined;
  let round: bigint | undefined;
  
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new UsageError('EXPECTED_ARGUMENT');
    }

    const networkArgument = parseNetworkSourceArgument(args, i, source);
    if (networkArgument !== undefined) {
      source = networkArgument.source;
      i = networkArgument.nextIndex;

      continue;
    }

    if (argument === '--round') {
      if (round !== undefined) {
        throw new UsageError('DUPLICATE_ROUND');
      }

      const value = args[i + 1];
      if (value === undefined) {
        throw new UsageError('MISSING_ROUND_VALUE');
      }

      round = parseRound(value);
      i += 1;

      continue;
    }

    throw new UsageError('UNKNOWN_ARGUMENT');
  }

  if (source === undefined) {
    throw new UsageError('MISSING_NETWORK');
  }

  if (round === undefined) {
    throw new UsageError('MISSING_ROUND');
  }

  return {
    source,
    round,
  };
}

interface ParsedNetworkSourceArgument {
  source: NetworkSource;
  nextIndex: number;
}

function parseNetworkSourceArgument(
  args: readonly string[],
  index: number,
  currentSource: NetworkSource | undefined,
): ParsedNetworkSourceArgument | undefined {
  const argument = args[index];
  if (argument !== '--network' && argument !== '--network-config') {
    return undefined;
  }

  if (currentSource !== undefined) {
    if (argument === '--network' && currentSource.type === 'preset') {
      throw new UsageError('DUPLICATE_NETWORK');
    }

    if (argument === '--network-config' && currentSource.type === 'custom') {
      throw new UsageError('DUPLICATE_NETWORK_CONFIG');
    }

    throw new UsageError('CONFLICTING_NETWORK');
  }

  const value = args[index + 1];
  if (value === undefined) {
    if (argument === '--network') {
      throw new UsageError('MISSING_NETWORK_VALUE');
    }

    throw new UsageError('MISSING_NETWORK_CONFIG_VALUE');
  }

  if (argument === '--network') {
    return {
      source: {
        type: 'preset',
        network: parseRelayerNetworkPreset(value)
      },
      nextIndex: index + 1,
    };
  }

  return {
    source: {
      type: 'custom',
      configFile: value,
    },
    nextIndex: index + 1,
  };
}

function parseRound(
  value: string,
): bigint {
  if (
    value.length === 0 ||
    !isDecimalInteger(value)
  ) {
    throw new UsageError('INVALID_ROUND');
  }

  const round = BigInt(value);
  if (round <= 0n) {
    throw new UsageError('ZERO_ROUND');
  }

  if (round > MAX_UINT64) {
    throw new UsageError('ROUND_OVERFLOW');
  }

  return round;
}