import {
  summarizeError,
  type ErrorSummary,
  type SummarizeErrorOptions,
} from './error-summary.js';

const MAX_ERROR_SUMMARY_BYTES = 8_192;

export function summarizeErrorForOutput(
  error: unknown,
  options?: SummarizeErrorOptions,
): ErrorSummary {
  const summary = summarizeError(error, options);
  fitErrorSummary(summary);

  return summary;
}

function fitErrorSummary(
  summary: ErrorSummary,
): void {
  let maxTextLength = 2_048;

  while (
    Buffer.byteLength(JSON.stringify(summary)) > MAX_ERROR_SUMMARY_BYTES
  ) {
    shortenErrorText(summary, maxTextLength);
    maxTextLength = Math.floor(maxTextLength / 2);

    if (maxTextLength === 0) {
      throw new RangeError('Error summary too large.');
    }
  }
}

// Only visits the fresh, bounded summary produced by summarizeError.
function shortenErrorText(
  summary: ErrorSummary,
  maxTextLength: number,
): void {
  function shorten(value: string): string {
    if (value.length <= maxTextLength) {
      return value;
    }

    summary.textModified = true;

    const suffix = ' [truncated]';

    if (maxTextLength <= suffix.length) {
      return '[truncated]';
    }

    let end = maxTextLength - suffix.length;
    const lastCode = value.charCodeAt(end - 1);

    // Avoid splitting a UTF-16 surrogate pair at the cut.
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      end -= 1;
    }

    return value.slice(0, end) + suffix;
  }

  for (const key of ['name', 'message', 'code'] as const) {
    const value = summary[key];
    if (typeof value === 'string') {
      summary[key] = shorten(value);
    }
  }

  const revert = summary.revert;
  if (revert !== undefined) {
    for (const key of ['name', 'reason'] as const) {
      const value = revert[key];
      if (typeof value === 'string') {
        revert[key] = shorten(value);
      }
    }

    if (revert.args !== undefined) {
      for (let index = 0; index < revert.args.length; index += 1) {
        const value = revert.args[index];
        if (typeof value === 'string') {
          revert.args[index] = shorten(value);
        }
      }
    }
  }

  if (summary.cause !== undefined) {
    shortenErrorText(summary.cause, maxTextLength);
  }

  for (const child of summary.errors ?? []) {
    shortenErrorText(child, maxTextLength);
  }
}