import {
  constants,
} from 'node:fs';

import {
  open,
  realpath,
} from 'node:fs/promises';

import {
  dirname,
  isAbsolute,
  resolve,
} from 'node:path';

import {
  createDiagnosticTrace,
  type DiagnosticTrace,
  type DiagnosticTraceOptions,
} from './diagnostic-trace.js';

/** The parent must already exist and be controlled by the operator. */
export async function openDiagnosticTrace(
  path: string,
  options: Omit<DiagnosticTraceOptions, 'writer' | 'limits'>,
): Promise<DiagnosticTrace> {
  let handle;

  try {
    if (!isAbsolute(path) || path.length > 4096) {
      throw new Error('Invalid trace path.');
    }

    const parent = dirname(resolve(path));

    if ((await realpath(parent)) !== parent) {
      throw new Error('Indirect trace parent.');
    }

    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );

    const stat = await handle.stat();

    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Invalid trace file.');
    }
    // A permissive umask must not expose trace data.
    await handle.chmod(0o600);

    const file = handle;

    return createDiagnosticTrace({
      ...options,
      writer: {
        async write(bytes) {
          let offset = 0;

          while (offset < bytes.length) {
            const result = await file.write(
              bytes,
              offset,
              bytes.length - offset,
            );

            if (result.bytesWritten <= 0) {
              throw new Error('Diagnostic write made no progress.');
            }

            offset += result.bytesWritten;
          }
        },
        async close() {
          await file.close();
        },
      },
    });
  } catch {
    try {
      await handle?.close();
    } catch {
      // Do not leak the pathname or replace the sanitized startup failure.
    }

    throw new Error('Cannot open diagnostic trace file.');
  }
}
