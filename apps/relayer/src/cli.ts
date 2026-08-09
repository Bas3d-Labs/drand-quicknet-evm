import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { 
  loadRelayerConfig, 
  parseRelayerNetwork, 
  type RelayerNetwork 
} from './config.js';
import { createRelayerClients } from './clients.js';
import { importQuicknetRound } from './import-round.js';

export type CliCommand =
  | {
      kind: 'help';
    }
  | {
      kind: 'import';
      network: RelayerNetwork;
      round: bigint;
    }

async function main(): Promise<void> {
  try {
    const command = parseCliArgs(process.argv.slice(2));
    if (command.kind === 'help') {
      printHelp();
      return;
    }

    await runImportCommand(command);
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

  console.log(`Import Quicknet round ${result.round}.`);
  console.log(`Randomness: ${result.randomness}`);
  console.log(`Transaction: ${result.transactionHash}`);
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

  const command = normalizedArgs[0];

  if (command !== 'import') {
    throw new Error(`Unknown command: ${command}`);
  }

  let networkValue:
    string | undefined;

  let roundValue:
    string | undefined;

  for (
    let index = 1;
    index < args.length;
    index++
  ) {
    const argument = args[index];

    if (
      argument === '--help' ||
      argument === '-h'
    ) {
      return {
        kind: 'help',
      };
    }

    if (argument === '--network') {
      if (
        networkValue !== undefined
      ) {
        throw new Error('Option --network may only be specified once.');
      }

      networkValue =
        readOptionValue(
          args,
          index,
          '--network',
        );

      index++;
      continue;
    }

    if (argument === '--round') {
      if (
        roundValue !== undefined
      ) {
        throw new Error('Option --round may only be specified once.');
      }

      roundValue =
        readOptionValue(
          args,
          index,
          '--round',
        );

      index++;
      continue;
    }

    throw new Error(
      `Unknown option: ${argument}`,
    );
  }

  if (networkValue === undefined) {
    throw new Error(
      'Missing required option: --network',
    );
  }

  if (roundValue === undefined) {
    throw new Error('Missing required option: --round');
  }

  return {
    kind: 'import',
    network: parseRelayerNetwork(networkValue),
    round: parseRound(roundValue),
  };
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

  return round;
}

function isDecimalInteger(
  value: string,
): boolean {
  for (const character of value) {
    if (
      character < '0' ||
      character > '9'
    ) {
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

    Commands:
      import    Import one exact drand Quicknet round into the registry.

    Options:
      --network <network>    Target network.
      --round <round>        Exact Quicknet round to import.
      -h, --help             Show this help.

    Example:
      drand-quicknet-relayer import \\
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