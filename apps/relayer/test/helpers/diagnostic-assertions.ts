import {
  expect,
} from 'vitest';

import {
  configDiagnostic,
  RelayerConfigError,
  type ConfigCode,
  type ConfigSetting,
} from '../../src/diagnostics/config-errors.js';

import {
  usageCode,
  UsageError,
  type UsageCode,
} from '../../src/diagnostics/usage-error.js';

function captureThrown(
  action: () => unknown,
): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the action to throw.');
}

function assertConfigDiagnostic(
  error: unknown,
  code: ConfigCode,
  setting: ConfigSetting,
): void {
  expect(error).toBeInstanceOf(RelayerConfigError);

  expect(configDiagnostic(error)).toEqual({
    code,
    setting,
  });
}

export function expectUsageError(
  action: () => unknown,
  code: UsageCode,
): void {
  const error = captureThrown(action);

  expect(error).toBeInstanceOf(UsageError);
  expect(usageCode(error)).toBe(code);
}

export function expectConfigError(
  action: () => unknown,
  code: ConfigCode,
  setting: ConfigSetting,
): void {
  assertConfigDiagnostic(
    captureThrown(action),
    code,
    setting,
  );
}

export async function expectConfigRejection(
  promise: Promise<unknown>,
  code: ConfigCode,
  setting: ConfigSetting,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('Expected the promise to reject.');
    },
    (failure: unknown) => failure,
  );

  assertConfigDiagnostic(error, code, setting);
}