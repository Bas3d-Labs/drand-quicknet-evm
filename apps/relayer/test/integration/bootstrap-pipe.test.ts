import {
  execFileSync,
  spawn,
} from 'node:child_process';

import {
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';

import {
  dirname,
  join,
} from 'node:path';

import process from 'node:process';

import {
  fileURLToPath,
} from 'node:url';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderCliOutput,
} from '../../src/cli/cli-output.js';

const APP = fileURLToPath(
  new URL('../..', import.meta.url),
);

const EXPECTED_OUTPUT = Buffer.from(
  renderCliOutput({ type: 'help' }) + '\n',
);

const MODULE_PATHS = {
  bootstrap: 'bootstrap.js',
  'error-summary': 'diagnostics/error-summary.js',
  'diagnostic-messages': 'diagnostics/diagnostic-messages.js',
  'usage-error': 'diagnostics/usage-error.js',
  'config-errors': 'diagnostics/config-errors.js',
  diagnostics: 'diagnostics/diagnostics.js',
  'cli-output': 'cli/cli-output.js',
  cli: 'cli/cli.js',
  hex: 'shared/hex.js',
  'network-presets': 'config/network-presets.js',
} as const;

interface PipeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: Buffer;
  fillerBytes: number;
  eagainCount: number;
  outputCompleted: boolean;
  timedOut: boolean;
}

function isAgain(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return Object.getOwnPropertyDescriptor(
    error,
    'code',
  )?.value === 'EAGAIN';
}

// This fixture relies on Linux FIFO and nonblocking descriptor behavior.
// Controlled retry tests remain portable in bootstrap.test.ts.
describe.skipIf(process.platform !== 'linux')(
  'bootstrap with a full nonblocking pipe',
  () => {
    let fixture: string;

    beforeAll(() => {
      execFileSync(
        'pnpm',
        ['exec', 'tsc', '-p', 'tsconfig.json'],
        {
          cwd: APP,
          stdio: 'pipe',
          timeout: 30_000,
        },
      );

      fixture = mkdtempSync(
        join(APP, '.bootstrap-pipe-'),
      );

      const dist = join(fixture, 'dist');

      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ type: 'module' }),
      );

      // Preserve the compiled directory structure and relative imports.
      for (const [name, relativePath] of Object.entries(MODULE_PATHS)) {
        if (name === 'cli') {
          continue;
        }

        const destination = join(dist, relativePath);

        mkdirSync(dirname(destination), {
          recursive: true,
        });

        copyFileSync(
          join(APP, 'dist', relativePath),
          destination,
        );
      }

      // Observe errors from the real OS write, then rethrow unchanged.
      // No fake clock, injected EAGAIN, or replacement write result.
      writeFileSync(
        join(fixture, 'observe.cjs'),
        `
          const fs = require('node:fs');

          const {
            syncBuiltinESMExports,
          } = require('node:module');

          const originalWrite = fs.writeSync;

          fs.writeSync = function (...args) {
            try {
              return originalWrite(...args);
            } catch (error) {
              if (args[0] === 1 && error.code === 'EAGAIN') {
                process.send({ event: 'write_eagain' });
              }

              throw error;
            }
          };

          syncBuiltinESMExports();
        `,
      );

      const cli = join(dist, MODULE_PATHS.cli);

      mkdirSync(dirname(cli), {
        recursive: true,
      });

      // Reaching the IPC message proves the output callback returned.
      writeFileSync(
        cli,
        `
          export async function main(args, output) {
            output({ type: 'help' });
            process.send({ event: 'output_completed' });
          }
        `,
      );
    }, 35_000);

    afterAll(() => {
      if (fixture !== undefined) {
        rmSync(fixture, {
          recursive: true,
          force: true,
        });
      }
    });

    async function runWithFullPipe(
      recover: boolean,
    ): Promise<PipeResult> {
      const directory = mkdtempSync(
        join(fixture, 'pipe-'),
      );

      const fifo = join(directory, 'stdout');

      let reader: number | undefined;
      let writer: number | undefined;

      try {
        execFileSync('mkfifo', [fifo], {
          timeout: 5_000,
        });

        reader = openSync(
          fifo,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );

        writer = openSync(
          fifo,
          constants.O_WRONLY | constants.O_NONBLOCK,
        );

        // Track every filler byte to compare the complete stream.
        let fillerBytes = 0;
        const filler = Buffer.alloc(4096, 'F');
        const finalByte = Buffer.from('F');
        let full = false;

        for (let attempt = 0; attempt < 4096; attempt += 1) {
          try {
            fillerBytes += writeSync(writer, filler);
          } catch (error) {
            if (!isAgain(error)) {
              throw error;
            }

            // A rejected large write need not mean zero capacity.
            try {
              fillerBytes += writeSync(writer, finalByte);
            } catch (probeError) {
              if (!isAgain(probeError)) {
                throw probeError;
              }

              full = true;
              break;
            }
          }
        }

        expect(full).toBe(true);

        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NODE_ENV: 'production',
        };

        delete env.NODE_OPTIONS;

        const child = spawn(
          process.execPath,
          [
            '--require',
            join(fixture, 'observe.cjs'),
            join(fixture, 'dist', MODULE_PATHS.bootstrap),
          ],
          {
            cwd: APP,
            env,
            stdio: ['ignore', writer, 'pipe', 'ipc'],
          },
        );

        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(8192);
        const readFd = reader;

        let stderr = '';
        let eagainCount = 0;
        let outputCompleted = false;
        let timedOut = false;
        let drainFailure: unknown;

        let drainTimer:
          | ReturnType<typeof setInterval>
          | undefined;

        function drain(): void {
          // Bound each turn so a faulty child cannot monopolize the test.
          for (let attempt = 0; attempt < 4096; attempt += 1) {
            try {
              const count = readSync(readFd, buffer);

              if (count === 0) {
                return;
              }

              chunks.push(
                Buffer.from(buffer.subarray(0, count)),
              );
            } catch (error) {
              if (isAgain(error)) {
                return;
              }

              drainFailure = error;
              child.kill('SIGKILL');
              return;
            }
          }
        }

        child.stderr?.setEncoding('utf8');

        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });

        child.on('message', (message) => {
          if (
            typeof message !== 'object' ||
            message === null
          ) {
            return;
          }

          const event = Object.getOwnPropertyDescriptor(
            message,
            'event',
          )?.value;

          if (event === 'write_eagain') {
            eagainCount += 1;

            if (recover && drainTimer === undefined) {
              // Drain only after the child actually hits a full pipe.
              drain();
              drainTimer = setInterval(drain, 2);
            }
          }

          if (event === 'output_completed') {
            outputCompleted = true;
          }
        });

        // A watchdog is a test failure, never a successful bounded exit.
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 5_000);

        try {
          const result = await new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
          }>((resolve, reject) => {
            child.on('error', reject);

            child.on('close', (code, signal) => {
              resolve({ code, signal });
            });
          });

          // For the failure case, keep the pipe full until the child
          // exits, then inspect it without enabling recovery.
          drain();

          if (drainFailure !== undefined) {
            throw drainFailure;
          }

          return {
            ...result,
            stderr,
            stdout: Buffer.concat(chunks),
            fillerBytes,
            eagainCount,
            outputCompleted,
            timedOut,
          };
        } finally {
          clearTimeout(timeout);
          clearInterval(drainTimer);
        }
      } finally {
        if (writer !== undefined) {
          closeSync(writer);
        }

        if (reader !== undefined) {
          closeSync(reader);
        }

        rmSync(directory, {
          recursive: true,
          force: true,
        });
      }
    }

    it('completes exact output after the full pipe drains', async () => {
      const result = await runWithFullPipe(true);

      expect(result.eagainCount, result.stderr).toBeGreaterThan(0);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr).toBe(0);
      expect(result.outputCompleted).toBe(true);
      expect(result.stderr).toBe('');

      expect(result.stdout).toEqual(
        Buffer.concat([
          Buffer.alloc(result.fillerBytes, 'F'),
          EXPECTED_OUTPUT,
        ]),
      );
    }, 10_000);

    it('exits with code 2 when the pipe remains full', async () => {
      const result = await runWithFullPipe(false);

      expect(result.eagainCount, result.stderr).toBeGreaterThan(0);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr).toBe(2);
      expect(result.outputCompleted).toBe(false);

      expect(result.stdout).toEqual(
        Buffer.alloc(result.fillerBytes, 'F'),
      );

      expect(result.stderr.endsWith('\n')).toBe(true);

      expect(
        result.stderr.trimEnd().split('\n'),
      ).toHaveLength(1);

      expect(JSON.parse(result.stderr)).toMatchObject({
        event: 'output_failed',
        code: 'CLI_OUTPUT_FAILED',
        output: 'help',
        err: {
          code: 'EAGAIN',
        },
      });
    }, 10_000);
  },
);