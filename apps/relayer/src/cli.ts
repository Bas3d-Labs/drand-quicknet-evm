import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { 
  loadRelayerConfig, 
  parseRelayerNetwork, 
  type RelayerNetwork 
} from './config.js';
import { createRelayerClients } from './clients.js';
import { 
  importQuicknetRound,
  type ImportQuicknetRoundResult,
} from './import-round.js';
import {
  importQuicknetRoundWhenAvailable,
} from './import-round-when-available.js'

const MAX_UINT64 = (1n << 64n) - 1n;

export type CliCommand =
  | {
      kind: 'help';
    }
  | {
      kind: 'import';
      network: RelayerNetwork;
      round: bigint;
    }
  | {
      kind: 'import-when-available';
      network: RelayerNetwork;
      round: bigint;
    };

async function main(): Promise<void> {
  try {
    const command = parseCliArgs(process.argv.slice(2));

    switch (command.kind) {
      case 'help':
        printHelp();
        return;
      
      case 'import':
        await runImportCommand(command);
        return;

      case 'import-when-available':
        await runImportWhenAvailable(command);
        return;
    }
  } catch(error) {
    console.error(`Error: ${formatError(error)}`);

    process.exitCode = -1;
  }
}

async function runImportCommand(
  command: Extract<CliCommand, {kind: 'import'}>
): Promise<void> {
  const config = await loadRelayerConfig({
    network: command.network,
  });

  const {
    publicClient,
    walletClient,
  } = createRelayerClients(config);

  const result = await importQuicknetRound({
    publicClient,
    walletClient,
    account: config.account,
    deployment: config.deployment,
    round: command.round,
  });

  if (result.status === 'already-stored') {
    console.log(`Quicknet round ${result.round} is already stored.`);
    console.log(`Randomness: ${result.randomness}`);
    return;
  }

  printImportResult(result);
}

async function runImportWhenAvailable(
  command: Extract<CliCommand, { kind: 'import-when-available'; }>
): Promise<void> {
  const config = await loadRelayerConfig({
    network: command.network,
  });

  const {
    publicClient,
    walletClient,
  } = createRelayerClients(config);

  const result = await importQuicknetRoundWhenAvailable({
    publicClient,
    walletClient,
    account: config.account,
    deployment: config.deployment,
    round: command.round,
  });

  printImportResult(result);
}

export function parseCliArgs(
  args: readonly string[],
): CliCommand {
  const normalizedArgs =
    args[0] === '--'
      ? args.slice(1)
      : args;

  if (
    normalizedArgs.length === 0 ||
    normalizedArgs[0] === '--help' ||
    normalizedArgs[0] === '-h' ||
    normalizedArgs[0] === 'help'
  ) {
    return {
      kind: 'help',
    };
  }

  if (
    normalizedArgs.length === 2 &&
    (
      normalizedArgs[1] === '--help' ||
      normalizedArgs[1] === '-h'
    ) &&
    (
      normalizedArgs[0] === 'import' ||
      normalizedArgs[0] === 'import-when-available'
    )
  ) {
    return {
      kind: 'help',
    };
  }

  const command = normalizedArgs[0];
  if (
    command !== 'import' &&
    command !== 'import-when-available'
  ) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = parseImportOptions(normalizedArgs.slice(1));
  return {
    kind: command,
    ...options,
  };
}

interface ParsedImportOptions {
  network: RelayerNetwork;
  round: bigint;
}

function parseImportOptions(
  args: readonly string[],
): ParsedImportOptions {
  let networkValue: string | undefined;
  let roundValue: string | undefined;

  for (let i=0; i < args.length;i++) {
    const argument = args[i];
    if (argument === '--network') {
      if (networkValue !== undefined) {
        throw new Error('Option --network may only be specified once.');
      }

      networkValue = readOptionValue(args, i, '--network');
      i++;
      continue;
    }

    if (argument === '--round') {
      if (roundValue !== undefined) {
        throw new Error('Option --round may only be specified once.');
      }

      roundValue = readOptionValue(args, i, '--round');
      i++;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  if (networkValue === undefined) {
    throw new Error('Missing required option: --network');
  }

  if (roundValue === undefined) {
    throw new Error('Missing required option: --round');
  }

  return {
    network: parseRelayerNetwork(networkValue),
    round: parseRound(roundValue),
  };
}

function printImportResult(result: ImportQuicknetRoundResult): void {
  if (result.status === 'already-stored') {
    console.log(`Quicknet round ${result.round} is already stored.`);
    console.log(`Randomness: ${result.randomness}`);
    return;
  }

  console.log(`Imported Quicknet round ${result.round}.`);
  console.log(`Randomness: ${result.randomness}`);
  console.log(`Transaction: ${result.transactionHash}`);
}

function readOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];

  if (
    value === undefined ||
    value.length === 0 ||
    value.startsWith('--')
  ) {
    throw new Error(`Missing value for ${option}`);
  }

  return value;
}

function parseRound(
  value: string,
): bigint {
  if (
    value.length === 0 ||
    !isDecimalInteger(value)
  ) {
    throw new Error(`Invalid Quicknet round: ${value}`);
  }

  const round = BigInt(value);
  if (round <= 0n) {
    throw new Error('Quicknet round must be greater than zero.');
  }

  if (round > MAX_UINT64) {
    throw new Error('Quicknet round must fit within uint64.');
  }

  return round;
}

function isDecimalInteger(
  value: string,
): boolean {
  for (const character of value) {
    if (character < '0' || character > '9') {
      return false;
    }
  }

  return true;
}

function formatError(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function printHelp(): void {
  console.log(`
drand-quicknet-relayer

Usage:
  drand-quicknet-relayer import --network <network> --round <round>
  drand-quicknet-relayer import-when-available --network <network> --round <round>

Commands:
  import
    Import one exact drand Quicknet round immediately.

  import-when-available
    Wait for one exact drand Quicknet round to be published,
    retry fetching it for a bounded period, then import it.

Options:
  --network <network>    Target network.
  --round <round>        Exact Quicknet round to import.
  -h, --help             Show this help.

Examples:
  drand-quicknet-relayer import \\
    --network robinhood-testnet \\
    --round 31089008

  drand-quicknet-relayer import-when-available \\
    --network robinhood-testnet \\
    --round 31089008
`.trim());
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}