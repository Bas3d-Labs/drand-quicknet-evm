#!/usr/bin/env node

import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

// Type queries are erased and do not evaluate application modules.
type SummarizeError =
  typeof import('./diagnostics/error-summary.js').summarizeError;

type RenderDiagnostic =
  typeof import('./diagnostics/diagnostics.js').renderDiagnostic;

const WRITE_BUDGET_MS = 250;
const MAX_WRITE_ATTEMPTS = 128;

const backoff = new Int32Array(new SharedArrayBuffer(4));

// Identity distinguishes output failure after main() unwinds its cleanup.
const outputFailure = new Error('CLI output failed.');

let handlingFatal = false;

let summarizeError: SummarizeError = () => ({
  name: 'UnknownError',
  message: 'Operation failed; details redacted.',
});

let renderDiagnostic: RenderDiagnostic | undefined;

function retryableWrite(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  try {
    const field = Object.getOwnPropertyDescriptor(error, 'code');
    if (
      field === undefined ||
      !Object.hasOwn(field, 'value')
    ) {
      return false;
    }

    return field.value === 'EAGAIN' || field.value === 'EINTR';
  } catch {
    // A throwing Proxy is not a recognized retryable write failure.
    return false;
  }
}

// The deadline bounds retries. It cannot interrupt a blocking OS write.
function writeLine(
  fd: number,
  line: string,
): void {
  const bytes = Buffer.from(line + '\n');
  if (bytes.length > 32_768) {
    throw new Error('CLI output exceeds limit.');
  }

  const deadline = performance.now() + WRITE_BUDGET_MS;

  let offset = 0;
  let lastFailure: unknown;

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0 && performance.now() >= deadline) {
      break;
    }

    let written = 0;

    try {
      written = writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
      );
    } catch (error) {
      if (!retryableWrite(error)) {
        throw error;
      }

      lastFailure = error;

      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        break;
      }

      Atomics.wait(
        backoff,
        0,
        0,
        Math.min(5, remaining),
      );

      continue;
    }

    if (written <= 0) {
      throw new Error('CLI output made no progress.');
    }

    offset += written;

    if (offset === bytes.length) {
      return;
    }
  }

  if (offset > 0) {
    // Written bytes cannot be retracted. The syscall error is a cause,
    // while budget exhaustion after partial progress is the outcome.
    throw new Error(
      'CLI output retry budget exhausted after partial progress',
      { cause: lastFailure },
    );
  }

  if (lastFailure !== undefined) {
    throw lastFailure;
  }

  throw new Error('CLI output retry budget exhausted.');
}

function fatal(
  event: 'uncaught_exception' | 'unhandled_rejection',
  error: unknown,
): never {
  if (handlingFatal) {
    process.exit(1);
  }

  handlingFatal = true;

  try {
    const line = JSON.stringify({
      event,
      time: Date.now(),
      err: summarizeError(error),
    });
    writeLine(2, line);
  } catch {
    // Reporting is best effort if stderr itself is unavailable.
  }

  process.exit(1);
}

// Install both handlers before evaluating any application module.
process.on('uncaughtException', (error) => {
  fatal('uncaught_exception', error);
})

process.on('unhandledRejection', (error) => {
  fatal('unhandled_rejection', error);
});

try {
  // Upgrade the fixed fallback before loading more application code.
  const errors = await import('./diagnostics/error-summary.js');
  summarizeError = errors.summarizeError;

  const diagnostics = await import('./diagnostics/diagnostics.js');
  renderDiagnostic = diagnostics.renderDiagnostic;

  const {
    renderCliOutput,
    renderOutputFailure,
  } = await import('./cli/cli-output.js');

  const { main } = await import('./cli/cli.js');

  await main(process.argv.slice(2), (record) => {
    try {
      writeLine(1, renderCliOutput(record));
    } catch (error) {
      try {
        writeLine(2, renderOutputFailure(record, error));
      } catch {
        // Exit status still identifies output failure if stderr fails.
      }

      throw outputFailure;
    }
  });
} catch (error) {
  if (error === outputFailure) {
    process.exitCode = 2;
  } else {
    process.exitCode = 1;

    try {
      if (renderDiagnostic === undefined) {
        const line = JSON.stringify({
          event: 'cli_failed',
          kind: 'bootstrap',
          err: summarizeError(error),
        })
        writeLine(2, line);
      } else {
        writeLine(2, renderDiagnostic(error));
      }
    } catch {
      // Preserve failure status even if stderr cannot be written.
    }
  }
}