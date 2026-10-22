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

import {
  serviceLockReason
} from '../state/service-lock.js';

import {
  isPriorSignerStateError,
} from './signer-journal-errors.js';
import { journalBoundsViolations } from '../state/journal-bounds-error.js';

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

    const reason = serviceLockReason(error);
    if (reason !== undefined) {
      return JSON.stringify({
        event: 'cli_failed',
        kind: 'service-lock',
        code: 'SERVICE_LOCK_NOT_HELD',
        reason,
        message:
          'The required service lock could not be verified. ' +
          'Use the relayer launcher with util-linux flock on Linux. ' +
          'For daemon mode, the checkpoint must be a direct ' +
          'child of the configured state directory.',
      });
    }

    const violations = journalBoundsViolations(error);
    if (violations !== undefined) {
      return JSON.stringify({
        event: 'cli_failed',
        kind: 'signer-journal',
        code: 'journal-bounds-exceeded',
        message:
          'Retained journal state exceeds the configured runtime bounds. ' +
          'Inspect the journal before restarting. Do not delete it ' +
          'or initialize a replacement.',
        violations: violations.map((violation) => ({
          bound: violation.bound,
          maximum: violation.maximum,
          observed: violation.observed,
          attemptId: violation.attemptId,
        })),
      });
    }

    if (isPriorSignerStateError(error)) {
      return JSON.stringify({
        event: 'cli_failed',
        kind: 'signer-journal',
        code: 'prior-state-present',
        message:
          'Cannot automatically initialize a missing signer journal ' +
          'because the state directory contains other entries. ' +
          'Verify the configured directory and restore the matching ' +
          'journal if available. ' +
          'Remove entries only after establishing they are unrelated ' +
          'to prior relayer state.'
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

export function isJournalBoundsFailure(
  error: unknown,
): boolean {
  return journalBoundsViolations(error) !== undefined;
}