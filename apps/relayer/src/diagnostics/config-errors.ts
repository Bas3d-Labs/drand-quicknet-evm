import {
  configMessage
} from './diagnostic-messages.js';

const SETTINGS = [
  'PRIVATE_KEY',
  'ROBINHOOD_TESTNET_RPC_URL',
  'QUICKNET_RPC_URL',
  'QUICKNET_CONSUMERS',
  'QUICKNET_START_BLOCK',
  'QUICKNET_CHECKPOINT_FILE',
  'QUICKNET_MAX_BLOCK_RANGE',
  'QUICKNET_POLL_INTERVAL_MS',
] as const;

const CODES = [
  'MISSING_REQUIRED_SETTING',
  'INVALID_RPC_URL',
  'UNSUPPORTED_RPC_PROTOCOL',
  'INVALID_PRIVATE_KEY',
  'EMPTY_CONSUMER',
  'INVALID_CONSUMER',
  'INVALID_START_BLOCK',
  'EMPTY_CHECKPOINT_FILE',
  'INVALID_BLOCK_RANGE',
  'INVALID_POLL_INTERVAL',
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