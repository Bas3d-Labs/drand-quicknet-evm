import {
  configDiagnostic,
} from './config-errors.js';

import {
  configMessage,
  USAGE_MESSAGES,
} from './diagnostic-messages.js';

import {
  summarizeError,
} from './error-summary.js';

import {
  usageCode,
} from './usage-error.js';

export function renderDiagnostic(
  error: unknown,
): string {
  try {
    const code = usageCode(error);
    if (code !== undefined) {
      return JSON.stringify({
        event: 'cli_failed',
        kind: 'usage',
        code,
        message: USAGE_MESSAGES[code],
      });
    }

    const config = configDiagnostic(error);
    if (config !== undefined) {
      return JSON.stringify({
        event: 'cli_failed',
        kind: 'configuration',
        code: config.code,
        setting: config.setting,
        message: configMessage(config.code, config.setting),
      });
    }
  } catch {
    // Unexpected diagnostic rendering failures use the generic summary.
  }

  return JSON.stringify({
    event: 'cli_failed',
    kind: 'operation',
    err: summarizeError(error),
  });
}