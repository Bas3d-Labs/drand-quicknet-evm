import {
  configDiagnostic,
} from './config-errors.js';

import {
  configMessage,
  USAGE_MESSAGES,
} from './diagnostic-messages.js';

import type {
  SummarizeErrorOptions,
} from './error-summary.js';

import {
  summarizeErrorForOutput,
} from './error-output.js';

import {
  usageCode,
} from './usage-error.js';

import {
  projectRoundImportProgress,
  type RoundImportDiagnostic,
  type RoundImportProgress,
} from './operation-context.js';

export function renderDiagnostic(
  error: unknown,
  errorSummary?: SummarizeErrorOptions,
  importProgress?: RoundImportProgress,
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

  let operation:
    | (RoundImportDiagnostic & { name: 'import-round' })
    | undefined;

  let operationOmitted: true | undefined;

  if (importProgress !== undefined) {
    try {
      operation = {
        ...projectRoundImportProgress(importProgress),
        name: 'import-round',
      };
    } catch {
      // Invalid context must not suppress the original error diagnostic.
      operationOmitted = true;
    }
  }

  return JSON.stringify({
    event: 'cli_failed',
    kind: 'operation',
    operation,
    operationOmitted,
    err: summarizeErrorForOutput(error, errorSummary),
  });
}