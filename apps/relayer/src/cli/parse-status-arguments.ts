import {
  parseStatusConfig,
  type StatusConfig,
} from '../config/status-config.js';

import {
  UsageError,
} from '../diagnostics/usage-error.js';

export interface StatusCommandArguments {
  readonly command: 'status';
  readonly config: StatusConfig;
}

type StatusOption =
  | '--chain-id'
  | '--signer'
  | '--source'
  | '--max-age-ms';

export function parseStatusArguments(
  args: readonly string[],
): StatusCommandArguments {
  const values = new Map<StatusOption, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (!isStatusOption(argument)) {
      throw new UsageError('UNKNOWN_ARGUMENT');
    }

    if (values.has(argument)) {
      throw new UsageError('DUPLICATE_STATUS_OPTION');
    }

    const value = args[index + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new UsageError('MISSING_STATUS_OPTION_VALUE');
    }

    values.set(argument, value);
    index += 1;
  }

  const chainId = values.get('--chain-id');
  const signer = values.get('--signer');
  const source = values.get('--source');
  const maxAgeMs = values.get('--max-age-ms');

  if (chainId === undefined) {
    throw new UsageError('MISSING_STATUS_CHAIN_ID');
  }

  if (signer === undefined) {
    throw new UsageError('MISSING_STATUS_SIGNER');
  }

  if (source === undefined) {
    throw new UsageError('MISSING_STATUS_SOURCE');
  }

  let config: StatusConfig;

  try {
    config = parseStatusConfig({
      chainId,
      signer,
      source,
      ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    });
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    throw new UsageError('INVALID_STATUS_CONFIG');
  }

  return {
    command: 'status',
    config,
  };
}

function isStatusOption(
  value: string | undefined,
): value is StatusOption {
  return (
    value === '--chain-id' ||
    value === '--signer' ||
    value === '--source' ||
    value === '--max-age-ms'
  );
}