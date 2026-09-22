import {
  summarizeError,
} from './error-summary.js';

import {
  isFixedHex,
} from './hex.js';

import type {
  DaemonStartupSummary,
} from './daemon-startup.js';

import type {
  ImportQuicknetRoundResult,
} from './import-round.js';

export type CliOutput =
  | {
      type: 'help' | 'daemon-help'
    }
  | {
      type: 'import-result';
      round: bigint;
      result: ImportQuicknetRoundResult;
    }
  | {
      type: 'daemon-startup';
      summary: DaemonStartupSummary;
    };

export type CliOutputHandler = (output: CliOutput) => void;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_STARTUP_CONSUMERS = 25;

const HELP = [
  'Usage:',
  '  relayer <command> [options]',
  '',
  'Commands:',
  '  import                 Import an exact Quicknet round immediately.',
  '  import-when-available   Wait for and import an exact Quicknet round.',
  '  daemon                 Watch consumers and relay requested rounds.',
  '',
  'Network selection:',
  '  --network <preset>       Use an official network preset.',
  '  --network-config <file>  Use a custom network configuration.',
  '',
  'Exactly one network selection option is required for import, ' +
    'import-when-available, and daemon.',
  '',
  'Run relayer daemon --help for daemon-specific usage.',
].join('\n');

const DAEMON_HELP = [
  'Usage:',
  '  relayer daemon --network <preset>',
  '  relayer daemon --network-config <file>',
  '',
  'Network options:',
  '  --network <preset>       Use an official network preset.',
  '  --network-config <file>  Use a custom network configuration.',
  '',
  'Exactly one network option is required.',
  '',
  'Required daemon environment variables:',
  '  QUICKNET_CONSUMERS',
  '  QUICKNET_START_BLOCK',
  '  QUICKNET_CHECKPOINT_FILE',
  '',
  'Custom network environment:',
  '  QUICKNET_RPC_URL',
  '',
  'Optional environment variables:',
  '  QUICKNET_MAX_BLOCK_RANGE',
  '  QUICKNET_POLL_INTERVAL_MS',
].join('\n');

function own(
  input: unknown,
  key: string,
): unknown {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Invalid CLI output.');
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw new TypeError('Invalid CLI output field.');
  }

  return descriptor.value;
}

function uint(
  value: unknown,
): string {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > MAX_UINT256
  ) {
    throw new TypeError('Invalid CLI integer.');
  }

  return value.toString();
}

function hex(
  value: unknown,
  bytes: number,
): string {
  if (!isFixedHex(value, bytes)) {
    throw new TypeError('Invalid CLI hex value.');
  }

  return value;
}

function positiveInteger(
  value: unknown,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError('Invalid CLI number.');
  }

  return value;
}

function finality(
  value: unknown,
): string {
  const type = own(value, 'type');
  if (type === 'safe' || type === 'finalized') {
    return type;
  }

  if (type === 'confirmations') {
    return uint(own(value, 'confirmations')) + ' confirmations';
  }

  throw new TypeError('Invalid CLI finality policy.');
}

function consumerLines(
  summary: unknown,
): string[] {
  const consumers = own(summary, 'consumers');
  if (!Array.isArray(consumers)) {
    throw new TypeError('Invalid CLI consumers.');
  }

  const length = own(consumers, 'length');
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new TypeError('Invalid CLI consumers.');
  }

  const checkpoints = own(summary, 'durableNextBlocks');

  // The collector supplies a Map. Validate its brand and avoid invoking
  // a supplied get method, including when the consumer array is empty.
  Map.prototype.has.call(checkpoints, '');

  const count = Math.min(length, MAX_STARTUP_CONSUMERS);
  const lines = ['Consumers:'];

  for (let index = 0; index < count; index += 1) {
    const consumer = hex(own(consumers, String(index)), 20);
    const nextBlock = Map.prototype.get.call(checkpoints, consumer);

    let line = '  - ' + consumer;

    if (nextBlock !== undefined) {
      line += ' (next durable block: ' + uint(nextBlock) + ')';
    }

    lines.push(line);
  }

  if (length > count) {
    lines.push('  Additional consumers omitted: ' + (length - count));
  }

  return lines;
}

// Construct and validate the complete output before any writer receives it.
export function renderCliOutput(
  output: CliOutput,
): string {
  const type = own(output, 'type');
  if (type === 'help') {
    return HELP;
  }

  if (type === 'daemon-help') {
    return DAEMON_HELP;
  }

  if (type === 'import-result') {
    const round = uint(own(output, 'round'));
    const result = own(output, 'result');

    const randomness = hex(own(result, 'randomness'), 32);
    const status = own(result, 'status');

    if (status === 'already-stored') {
      return [
        'Quicknet round ' + round + ' is already stored.',
        'Randomness: ' + randomness,
      ].join('\n');
    }

    if (status === 'imported') {
      const hash = hex(own(result, 'transactionHash'), 32);

      return [
        'Imported Quicknet round ' + round + '.',
        'Randomness: ' + randomness,
        'Transaction: ' + hash,
      ].join('\n');
    }

    throw new TypeError('Invalid import outcome.');
  }

  if (type === 'daemon-startup') {
    const summary = own(output, 'summary');

    return [
      'Relayer daemon starting',
      'Chain ID: ' + positiveInteger(own(summary, 'chainId')),
      'Signer: ' + hex(own(summary, 'signer'), 20),
      'Signer balance (wei): ' + uint(own(summary, 'signerBalance')),
      'Registry: ' + hex(own(summary, 'registry'), 20),
      'Registry codehash: ' +
        hex(own(summary, 'registryRuntimeCodehash'), 32),
      'Finality: ' + finality(own(summary, 'finality')),
      'Checkpoint: QUICKNET_CHECKPOINT_FILE (set)',
      'Latest head: ' + uint(own(summary, 'latestHead')),
      'Durable head: ' + uint(own(summary, 'durableHead')),
      'Start block: ' + uint(own(summary, 'startBlock')),
      'Max block range: ' + uint(own(summary, 'maxBlockRange')),
      'Poll interval (ms): ' +
        positiveInteger(own(summary, 'pollIntervalMs')),
      ...consumerLines(summary),
    ].join('\n');
  }

  throw new TypeError('Invalid CLI output type.');
}

// Perserve a known import outcome if rendering or writing its output fails.
export function renderOutputFailure(
  output: CliOutput,
  error: unknown,
): string {
  let context: Record<string, unknown> = {
    output: 'unknown',
  };

  try {
    const type = own(output, 'type');

    if (
      type === 'help' ||
      type === 'daemon-help' ||
      type === 'daemon-startup'
    ) {
      context = { output: type };
    } else if (type === 'import-result') {
      const round = uint(own(output, 'round'));
      const result = own(output, 'result');
      const status = own(result, 'status');
      const randomness = hex(own(result, 'randomness'), 32);

      if (status === 'imported') {
        const transactionHash = hex(own(result, 'transactionHash'), 32);

        context = {
          output: type,
          round,
          status,
          randomness,
          transactionHash,
        };
      } else if (status === 'already-stored') {
        context = {
          output: type,
          round,
          status,
          randomness,
        };
      }
    }
  } catch {
    // Invalid output fields must not appear in the failure diagnostic.
  }

  return JSON.stringify({
    event: 'output_failed',
    code: 'CLI_OUTPUT_FAILED',
    ...context,
    err: summarizeError(error),
  });
}