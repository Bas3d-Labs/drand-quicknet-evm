import {
  configMessage
} from './diagnostic-messages.js';

const SETTINGS = [
  'PRIVATE_KEY',
  'ROBINHOOD_TESTNET_RPC_URL',
  'QUICKNET_BROADCAST_RETRY_INITIAL_MS',
  'QUICKNET_BROADCAST_RETRY_MAX_MS',
  'QUICKNET_CHECKPOINT_FILE',
  'QUICKNET_CONSUMERS',
  'QUICKNET_FETCH_TIMEOUT_MS',
  'QUICKNET_MAX_BLOCK_RANGE',
  'QUICKNET_POLL_INTERVAL_MS',
  'QUICKNET_RECEIPT_TIMEOUT_MS',
  'QUICKNET_RPC_URL',
  'QUICKNET_START_BLOCK',
] as const;

const CODES = [
  'EMPTY_CONSUMER',
  'EMPTY_CHECKPOINT_FILE',
  'INVALID_BLOCK_RANGE',
  'INVALID_BROADCAST_RETRY_DELAY',
  'INVALID_BROADCAST_RETRY_RANGE',
  'INVALID_CONSUMER',
  'INVALID_FETCH_TIMEOUT',
  'INVALID_POLL_INTERVAL',
  'INVALID_PRIVATE_KEY',
  'INVALID_RECEIPT_TIMEOUT',
  'INVALID_RPC_URL',
  'INVALID_START_BLOCK',
  'MISSING_REQUIRED_SETTING',
  'UNSUPPORTED_RPC_PROTOCOL',
] as const;

export type ConfigSetting = (typeof SETTINGS)[number];
export type ConfigCode = (typeof CODES)[number];

interface ConfigDiagnostic {
  code: ConfigCode;
  setting: ConfigSetting;
}

const diagnostics = new WeakMap<object, ConfigDiagnostic>();

export class RelayerConfigError extends Error {
  readonly code: ConfigCode;
  readonly setting: ConfigSetting;

  constructor(
    code: ConfigCode,
    setting: ConfigSetting,
    options?: ErrorOptions,
  ) {
    if (!CODES.includes(code) || !SETTINGS.includes(setting)) {
      throw new TypeError('Invalid configuration diagnostic.');
    }

    super(configMessage(code, setting), options);

    this.code = code;
    this.setting = setting;

    diagnostics.set(this, { code, setting });
  }
}

export function configDiagnostic(
  error: unknown,
): ConfigDiagnostic | undefined {
  if (!(error instanceof RelayerConfigError)) {
    return undefined;
  }

  const value = diagnostics.get(error);
  if (value === undefined) {
    return undefined;
  }

  return {
    code: value.code,
    setting: value.setting,
  };
}