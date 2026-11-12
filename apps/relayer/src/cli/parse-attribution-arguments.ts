import type {
  Hash,
} from 'viem';

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
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

export type AttributionCommandArguments = {
  readonly command: 'attribute-transaction';
  readonly source: NetworkSource;
} & (
  | {
      readonly mode: 'apply';
      readonly ticketPath: string;
    }
  | {
      readonly mode: 'dry-run';
      readonly attemptId: string;
      readonly transactionHash: Hash;
      readonly operator: string;
      readonly blockNumber?: bigint;
    }
);

export function parseAttributionArguments(
  args: readonly string[],
): AttributionCommandArguments {
  const values = new Map<string, string>();

  const flags = new Set<string>();

  const valueOptions = [
    '--network',
    '--network-config',
    '--attempt-id',
    '--tx-hash',
    '--operator',
    '--block-number',
    '--ticket',
  ];

  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;

    if (values.has(option) || flags.has(option)) {
      throw new UsageError('INVALID_ATTRIBUTION_ARGUMENTS');
    }

    if (option === '--apply' || option === '--dry-run') {
      flags.add(option);
      continue;
    }

    const value = args[index + 1];

    if (
      !valueOptions.includes(option) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith('--')
    ) {
      throw new UsageError('INVALID_ATTRIBUTION_ARGUMENTS');
    }

    values.set(option, value);
    index++;
  }

  const preset = values.get('--network');

  const configFile = values.get('--network-config');

  if ((preset === undefined) === (configFile === undefined)) {
    throw new UsageError('INVALID_ATTRIBUTION_ARGUMENTS');
  }

  let source: NetworkSource;

  if (preset !== undefined) {
    source = {
      type: 'preset',
      network: parseRelayerNetworkPreset(preset),
    };
  } else {
    source = {
      type: 'custom',
      configFile: configFile!,
    };
  }

  if (flags.has('--apply')) {
    const ticketPath = values.get('--ticket');

    if (flags.has('--dry-run') || ticketPath === undefined || values.size !== 2) {
      throw new UsageError('INVALID_ATTRIBUTION_ARGUMENTS');
    }

    return {
      command: 'attribute-transaction',
      source,
      mode: 'apply',
      ticketPath,
    };
  }

  const attemptId = values.get('--attempt-id');

  const transactionHash = values.get('--tx-hash');

  const operator = values.get('--operator');

  if (
    values.has('--ticket') ||
    !isUuidV4(attemptId) ||
    !isFixedHex(transactionHash, 32) ||
    operator === undefined
  ) {
    throw new UsageError('INVALID_ATTRIBUTION_ARGUMENTS');
  }

  let blockNumber: bigint | undefined;

  const height = values.get('--block-number');

  if (height !== undefined) {
    if (height.length > 78 || !isDecimalInteger(height)) {
      throw new UsageError('INVALID_ATTRIBUTION_ARGUMENTS');
    }

    blockNumber = BigInt(height);

    if (blockNumber > MAX_UINT256) {
      throw new UsageError('INVALID_ATTRIBUTION_ARGUMENTS');
    }
  }

  return {
    command: 'attribute-transaction',
    source,
    mode: 'dry-run',
    attemptId: attemptId.toLowerCase(),
    transactionHash: transactionHash.toLowerCase() as Hash,
    operator,
    ...(blockNumber === undefined ? {} : {
      blockNumber,
    }),
  };
}
