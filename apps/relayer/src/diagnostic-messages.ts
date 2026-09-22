import type {
  ConfigCode,
  ConfigSetting,
} from './config-errors.js';

export const USAGE_MESSAGES = {
  UNKNOWN_COMMAND: 'Unknown command. Run relayer --help.',
  UNKNOWN_ARGUMENT: 'Unknown argument. Run relayer --help.',
  EXPECTED_ARGUMENT: 'Expected a command argument.',
  DUPLICATE_ROUND: 'Duplicate argument: --round.',
  DUPLICATE_NETWORK: 'Duplicate argument: --network.',
  DUPLICATE_NETWORK_CONFIG: 'Duplicate argument: --network-config',
  MISSING_ROUND_VALUE: 'Missing value for --round.',
  MISSING_NETWORK_VALUE: 'Missing value for --network.',
  MISSING_NETWORK_CONFIG_VALUE: 'Missing value for --network-config.',
  MISSING_NETWORK: 'Missing required argument: --network or --network-config.',
  MISSING_ROUND: 'Missing required argument: --round.',
  CONFLICTING_NETWORK: 'Arguments --network and --network-config are mutually exclusive',
  INVALID_ROUND: 'Round must be a positive decimal integer',
  ZERO_ROUND: 'Round must be greater than zero',
  ROUND_OVERFLOW: 'Round must fit in uint64',
  UNSUPPORTED_NETWORK: 'Unsupported network preset.',
} as const;

export function configMessage(
  code: ConfigCode,
  setting: ConfigSetting,
): string {
  switch(code) {
    case 'MISSING_REQUIRED_SETTING':
      return `Missing required environment variable: ${setting}.`;

    case 'INVALID_RPC_URL':
      return `Invalid RPC URL. Check ${setting}.`;

    case 'UNSUPPORTED_RPC_PROTOCOL':
      return `RPC URL must use http: or https:. Check ${setting}.`;

    case 'INVALID_PRIVATE_KEY':
      return 'PRIVATE_KEY must be a valid nonzero secp256k1 private key encoded as 32 hex bytes';

    case 'EMPTY_CONSUMER':
      return 'QUICKNET_CONSUMERS contains an empty consumer address.';

    case 'INVALID_CONSUMER':
      return 'QUICKNET_CONSUMERS contains an invalid consumer address.';

    case 'INVALID_START_BLOCK':
      return 'QUICKNET_START_BLOCK must be a non-negative decimal integer.';

    case 'EMPTY_CHECKPOINT_FILE':
      return 'QUICKNET_CHECKPOINT_FILE must not be empty.';

    case 'INVALID_BLOCK_RANGE':
      return 'QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.';

    case 'INVALID_POLL_INTERVAL':
      return 'QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.';
  }
}