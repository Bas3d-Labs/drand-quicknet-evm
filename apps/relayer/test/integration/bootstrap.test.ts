import {
  execFileSync,
  spawnSync,
} from 'node:child_process';

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  beforeEach,
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

const SECRET = 'bootstrap-credential-canary';

const RPC_URL =
  `https://user:${SECRET}@rpc.example/${SECRET}?key=${SECRET}`;

// Paths relative to the application's compiled dist directory.
// Keep the fixture layout identical to the production layout.
const MODULE_PATHS = {
  bootstrap: 'bootstrap.js',
  'error-output': 'diagnostics/error-output.js',
  'error-summary': 'diagnostics/error-summary.js',
  'diagnostic-messages': 'diagnostics/diagnostic-messages.js',
  'text-scrubber': 'diagnostics/text-scrubber.js',
  'usage-error': 'diagnostics/usage-error.js',
  'config-errors': 'diagnostics/config-errors.js',
  diagnostics: 'diagnostics/diagnostics.js',
  'cli-output': 'cli/cli-output.js',
  cli: 'cli/cli.js',
  hex: 'shared/hex.js',
  'mismatch-errors': 'diagnostics/mismatch-errors.js',
  'network-presets': 'config/network-presets.js',
  'operation-context': 'diagnostics/operation-context.js',
  'service-lock': 'state/service-lock.js',
} as const;

type ModuleName = keyof typeof MODULE_PATHS;

interface LaunchOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  realCli?: boolean;
  preload?: string;
  serviceLock?: boolean;
}

interface WriteStats {
  calls: number;
  waits: number;
  clock: number;
  getters: number;
}

let fixture: string | undefined;

function fixturePath(
  ...parts: string[]
): string {
  if (fixture === undefined) {
    throw new Error('Bootstrap fixture is unavailable.');
  }

  return join(fixture, ...parts);
}

function modulePath(
  name: ModuleName,
): string {
  return fixturePath('dist', MODULE_PATHS[name]);
}

function setModule(
  name: ModuleName,
  source: string,
): void {
  const destination = modulePath(name);

  mkdirSync(dirname(destination), {
    recursive: true,
  });

  writeFileSync(destination, source);
}

beforeAll(() => {
  // Compile current sources before exercising the process boundary.
  execFileSync(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.json'],
    {
      cwd: APP,
      timeout: 30_000,
      stdio: 'pipe',
    },
  );

  // Keeping fixtures under APP preserves dependency resolution.
  fixture = mkdtempSync(
    join(APP, '.bootstrap-test-'),
  );

  writeFileSync(
    fixturePath('package.json'),
    JSON.stringify({
      type: 'module',
    }),
  );
}, 35_000);

beforeEach(() => {
  // Restore all supporting modules before each failure injection.
  for (const [name, relativePath] of Object.entries(MODULE_PATHS)) {
    if (name === 'cli') {
      continue;
    }

    const destination = fixturePath('dist', relativePath);

    mkdirSync(dirname(destination), {
      recursive: true,
    });

    copyFileSync(
      join(APP, 'dist', relativePath),
      destination,
    );
  }

  setModule('cli', `
    export async function main(args, output) {
      output({ type: 'help' });
    }
  `);

  rmSync(fixturePath('write-stats.json'), {
    force: true,
  });
});

afterAll(() => {
  if (fixture !== undefined) {
    rmSync(fixture, {
      recursive: true,
      force: true,
    });
  }
});

function launch(
  options: LaunchOptions = {},
) {
  let entry = modulePath('bootstrap');

  if (options.realCli === true) {
    entry = join(APP, 'dist', MODULE_PATHS.bootstrap);
  }

  const args: string[] = [];

  if (options.preload !== undefined) {
    args.push('--require', options.preload);
  }

  args.push(entry, ...(options.args ?? []));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PRIVATE_KEY: '',
    ROBINHOOD_TESTNET_RPC_URL: '',
    QUICKNET_RPC_URL: '',
    QUICKNET_LOG_LEVEL: 'info',
    ...options.env,
  };

  let executable = process.execPath;
  let launchArgs = args;

  if (options.serviceLock === true) {
    if (process.platform !== 'linux') {
      throw new Error('Locked bootstrap tests require Linux.');
    }

    const version = execFileSync(
      'flock',
      ['--version'],
      {
        encoding: 'utf8',
        timeout: 5_000,
      },
    );

    expect(version).toContain('util-linux');

    // Each locked invocation gets an isolated coordination directory.
    const stateDirectory = mkdtempSync(
      fixturePath('service-state-'),
    );

    env.QUICKNET_STATE_DIR = stateDirectory;

    executable = 'flock';
    launchArgs = [
      '--exclusive',
      '--nonblock',
      '--no-fork',
      '--conflict-exit-code',
      '75',
      join(stateDirectory, 'relayer.flock'),
      process.execPath,
      ...args,
    ];
  }

  const result = spawnSync(
    executable,
    launchArgs,
    {
      cwd: APP,
      env,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_048_576,
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();

  const output = result.stdout + result.stderr;

  expect(output).not.toContain(SECRET);
  expect(output).not.toContain(RPC_URL);
  expect(output).not.toContain(encodeURIComponent(RPC_URL));
  expect(output).not.toContain('rpc.example');

  return result;
}

function diagnostic(
  stderr: string,
): Record<string, unknown> {
  expect(stderr.endsWith('\n')).toBe(true);
  expect(stderr.trimEnd().split('\n')).toHaveLength(1);

  const value: unknown = JSON.parse(stderr);

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('Expected one diagnostic object.');
  }

  return value as Record<string, unknown>;
}

// Intercept writes in the child without exporting bootstrap internals.
// A fake monotonic clock makes retry-budget assertions deterministic.
function installWriteHook(
  body: string,
): string {
  const preload = fixturePath('write-hook.cjs');
  const statsPath = JSON.stringify(
    fixturePath('write-stats.json'),
  );

  writeFileSync(preload, `
    const fs = require('node:fs');
    const { performance } = require('node:perf_hooks');
    const { syncBuiltinESMExports } = require('node:module');

    const original = fs.writeSync;

    const stats = {
      calls: 0,
      waits: 0,
      clock: 0,
      getters: 0,
    };

    Object.defineProperty(performance, 'now', {
      value: () => stats.clock,
    });

    Atomics.wait = function(_array, _index, _value, timeout) {
      stats.waits += 1;
      stats.clock += timeout;

      return 'timed-out';
    };

    fs.writeSync = function(fd, bytes, offset, length) {
      if (fd !== 1) {
        return original(fd, bytes, offset, length);
      }

      stats.calls += 1;

      ${body}
    };

    syncBuiltinESMExports();

    process.on('exit', () => {
      fs.writeFileSync(
        ${statsPath},
        JSON.stringify(stats),
      );
    });
  `);

  return preload;
}

function writeStats(): WriteStats {
  return JSON.parse(
    readFileSync(
      fixturePath('write-stats.json'),
      'utf8',
    ),
  );
}

describe('bootstrap process boundary', () => {
  it('preserves the executable shebang in the compiled file', () => {
    const firstLine = readFileSync(
      join(APP, 'dist', MODULE_PATHS.bootstrap),
      'utf8',
    ).split('\n', 1)[0];

    expect(firstLine?.trimEnd()).toBe(
      '#!/usr/bin/env node',
    );
  });

  it('runs real CLI help without required configuration', () => {
    const result = launch({
      realCli: true,
      args: ['--help'],
    });

    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).toBe(
      renderCliOutput({ type: 'help' }) + '\n',
    );

    expect(result.stderr).toBe('');
  });

  it('renders a real usage failure without echoing argv', () => {
    const result = launch({
      realCli: true,
      args: [SECRET],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'cli_failed',
      kind: 'usage',
      code: 'UNKNOWN_COMMAND',
    });
  });

  it.skipIf(process.platform !== 'linux')(
    'renders missing configuration as an ordinary CLI failure',
    () => {
      const result = launch({
        realCli: true,
        serviceLock: true,
        args: [
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '1',
        ],
      });

      expect(result.status, result.stderr).toBe(1);

      expect(diagnostic(result.stderr)).toMatchObject({
        event: 'cli_failed',
        kind: 'configuration',
        code: 'MISSING_REQUIRED_SETTING',
        setting: 'PRIVATE_KEY',
      });
  });

  it.skipIf(process.platform !== 'linux')(
    'does not expose a rejected RPC URL from the environment',
    () => {
      const result = launch({
        realCli: true,
        serviceLock: true,
        args: [
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '1',
        ],
        env: {
          PRIVATE_KEY: '0x' + '11'.repeat(32),
          ROBINHOOD_TESTNET_RPC_URL: 'file:///' + SECRET,
        },
      });

      expect(result.status, result.stderr).toBe(1);

      expect(diagnostic(result.stderr)).toMatchObject({
        kind: 'configuration',
        code: 'UNSUPPORTED_RPC_PROTOCOL',
        setting: 'ROBINHOOD_TESTNET_RPC_URL',
      });
  });

  it.skipIf(process.platform !== 'linux')(
    'refuses a real import without service ownership',
    () => {
      const stateDirectory = mkdtempSync(
        fixturePath('unlocked-state-'),
      );

      writeFileSync(
        join(stateDirectory, 'relayer.flock'),
        '',
        { mode: 0o600 },
      );

      const result = launch({
        realCli: true,
        args: [
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '1',
        ],
        env: {
          QUICKNET_STATE_DIR: stateDirectory,
        },
      });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe('');

      expect(diagnostic(result.stderr)).toMatchObject({
        event: 'cli_failed',
        kind: 'service-lock',
        code: 'SERVICE_LOCK_NOT_HELD',
        reason: 'descriptor',
      });

      expect(result.stderr).not.toContain(stateDirectory);
  });

  it('uses the fixed fallback if the summarizer import fails', () => {
    setModule('error-summary', `
      throw new Error(${JSON.stringify(RPC_URL)});
    `);

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toEqual({
      event: 'cli_failed',
      kind: 'bootstrap',
      err: {
        name: 'UnknownError',
        message: 'Operation failed; details redacted.',
      },
    });
  });

  it('uses the loaded summarizer if the diagnostics import fails', () => {
    setModule('diagnostics', `
      throw new TypeError(${JSON.stringify(RPC_URL)});
    `);

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'cli_failed',
      kind: 'bootstrap',
      err: {
        name: 'TypeError',
      },
    });
  });

  it.each([
    'cli-output',
    'cli',
  ] as const)('contains an import failure in %s', (name) => {
    setModule(name, `
      throw new Error(${JSON.stringify(RPC_URL)});
    `);

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'cli_failed',
      kind: 'operation',
      err: {
        name: 'Error',
      },
    });
  });

  it('contains a missing application module', () => {
    rmSync(modulePath('cli'));

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'cli_failed',
      kind: 'operation',
    });
  });

  it('handles awaited main rejection as an ordinary failure', () => {
    setModule('cli', `
      export async function main() {
        throw new Error(${JSON.stringify(RPC_URL)});
      }
    `);

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'cli_failed',
      kind: 'operation',
    });
  });

  it('installs fatal handlers before the first application import evaluates', () => {
    setModule('error-summary', `
      setTimeout(() => {
        throw new Error(${JSON.stringify(RPC_URL)});
      }, 0);

      await new Promise(() => {});
    `);

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'uncaught_exception',
      err: {
        name: 'UnknownError',
        message: 'Operation failed; details redacted.',
      },
    });
  });

  it.each([
    {
      event: 'uncaught_exception',
      action: `
        throw new Error(${JSON.stringify(RPC_URL)});
      `,
    },
    {
      event: 'unhandled_rejection',
      action: `
        void Promise.reject(
          new Error(${JSON.stringify(RPC_URL)}),
        );
      `,
    },
  ])('exits on $event despite an active timer', ({ event, action }) => {
    setModule('cli', `
      export async function main() {
        setInterval(() => {}, 1000);

        setTimeout(() => {
          ${action}
        }, 0);
      }
    `);

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toMatchObject({
      event,
      err: {
        name: 'Error',
      },
    });
  });

  it('preserves an imported outcome when stdout fails', () => {
    setModule('cli', `
      import { closeSync } from 'node:fs';

      export async function main(args, output) {
        closeSync(1);

        output({
          type: 'import-result',
          round: 100n,
          result: {
            status: 'imported',
            submission: 'witness',
            round: 100n,
            randomness: '0x' + '11'.repeat(32),
            transactionHash: '0x' + '22'.repeat(32),
          },
        });
      }
    `);

    const result = launch();

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe('');

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'import-result',
      status: 'imported',
      round: '100',
      transactionHash: '0x' + '22'.repeat(32),
    });
  });

  it('reports invalid output without serializing its extra fields', () => {
    setModule('cli', `
      export async function main(args, output) {
        output({
          type: ${JSON.stringify(SECRET)},
          secret: ${JSON.stringify(RPC_URL)},
        });
      }
    `);

    const result = launch();

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe('');

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'output_failed',
      output: 'unknown',
      code: 'CLI_OUTPUT_FAILED',
    });
  });

  it('preserves operation failure status when stderr is unavailable', () => {
    setModule('cli', `
      import { closeSync } from 'node:fs';

      export async function main() {
        closeSync(2);

        throw new Error(${JSON.stringify(RPC_URL)});
      }
    `);

    const result = launch();

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
  });

  it('preserves output failure status when both output descriptors are unavailable', () => {
    setModule('cli', `
      import { closeSync } from 'node:fs';

      export async function main(args, output) {
        closeSync(1);
        closeSync(2);

        output({ type: 'help' });
      }
    `);

    const result = launch();

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});

describe('bootstrap write policy', () => {
  it.each([
    'EAGAIN',
    'EINTR',
  ])('retries transient %s and completes output', (code) => {
    const preload = installWriteHook(`
      if (stats.calls === 1) {
        throw Object.assign(
          new Error('transient'),
          { code: ${JSON.stringify(code)} },
        );
      }

      return original(fd, bytes, offset, length);
    `);

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).toBe(
      renderCliOutput({ type: 'help' }) + '\n',
    );

    expect(result.stderr).toBe('');

    expect(writeStats()).toMatchObject({
      calls: 2,
      waits: 1,
    });
  });

  it('completes short writes without duplicating or losing bytes', () => {
    const preload = installWriteHook(`
      return original(
        fd,
        bytes,
        offset,
        Math.min(16, length),
      );
    `);

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).toBe(
      renderCliOutput({ type: 'help' }) + '\n',
    );

    expect(result.stderr).toBe('');
    expect(writeStats().calls).toBeGreaterThan(1);
  });

  it('stops retrying EAGAIN at the deadline', () => {
    const preload = installWriteHook(`
      throw Object.assign(
        new Error('blocked'),
        { code: 'EAGAIN' },
      );
    `);

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe('');

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'output_failed',
      err: {
        code: 'EAGAIN',
      },
    });

    const stats = writeStats();

    expect(stats.clock).toBe(250);
    expect(stats.calls).toBeGreaterThan(1);
    expect(stats.calls).toBeLessThan(128);
  });

  it.each([
    'attempts',
    'deadline',
  ])('reports partial progress at the %s budget', (mode) => {
    const preload = installWriteHook(`
      if (stats.calls === 1) {
        throw Object.assign(
          new Error('transient'),
          { code: 'EAGAIN' },
        );
      }

      const written = original(fd, bytes, offset, 1);

      if (${JSON.stringify(mode)} === 'deadline') {
        stats.clock = 251;
      }

      return written;
    `);

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(2);

    const stats = writeStats();

    if (mode === 'attempts') {
      expect(stats.calls).toBe(128);
      expect(Buffer.byteLength(result.stdout)).toBe(127);
    } else {
      expect(stats.calls).toBe(2);
      expect(Buffer.byteLength(result.stdout)).toBe(1);
    }

    const record = diagnostic(result.stderr);

    expect(record).toMatchObject({
      event: 'output_failed',
      err: {
        name: 'Error',
        cause: {
          code: 'EAGAIN',
        },
      },
    });

    expect(record.err).not.toHaveProperty('code');
  });

  it('passes EPIPE through without retrying', () => {
    const preload = installWriteHook(`
      throw Object.assign(
        new Error('closed'),
        { code: 'EPIPE' },
      );
    `);

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(2);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'output_failed',
      err: {
        code: 'EPIPE',
      },
    });

    expect(writeStats()).toMatchObject({
      calls: 1,
      waits: 0,
    });
  });

  it('rejects a write that makes no progress', () => {
    const preload = installWriteHook('return 0;');

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(2);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'output_failed',
    });

    expect(writeStats()).toMatchObject({
      calls: 1,
      waits: 0,
    });
  });

  it('does not invoke a code accessor while classifying a failure', () => {
    const preload = installWriteHook(`
      const error = new Error('write failed');

      Object.defineProperty(error, 'code', {
        get() {
          stats.getters += 1;

          return 'EAGAIN';
        },
      });

      throw error;
    `);

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(2);

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'output_failed',
    });

    expect(writeStats()).toMatchObject({
      calls: 1,
      waits: 0,
      getters: 0,
    });
  });
});

describe('configured bootstrap diagnostic policy', () => {
  it.each([
    {
      event: 'cli_failed',
      action: 'throw error;',
    },
    {
      event: 'uncaught_exception',
      action: `
        setTimeout(() => { throw error; }, 0);
        await new Promise(() => {});
      `,
    },
    {
      event: 'unhandled_rejection',
      action: `
        setTimeout(() => { void Promise.reject(error); }, 0);
        await new Promise(() => {});
      `,
    },
  ])('uses the installed policy for $event', ({ event, action }) => {
    setModule('cli', `
      export async function main(args, output, options) {
        const secret = ${JSON.stringify(SECRET)};

        options.onDiagnostics({
          scrubText(text) {
            return {
              text: text.replaceAll(secret, '[REDACTED]'),
              removed: text.includes(secret),
            };
          },
        });

        const error = new Error(
          'public rate limit exceeded; token=' + secret,
        );

        ${action}
      }
    `);

    const result = launch();

    expect(result.status).toBe(1);

    expect(diagnostic(result.stderr)).toMatchObject({
      event,
      err: {
        name: 'Error',
        message: 'public rate limit exceeded; token=[REDACTED]',
        textModified: true,
      },
    });
  });
});

describe('bootstrap import failure context', () => {
  it('uses the configured scrubber when reporting an output failure', () => {
    setModule('cli', `
      export async function main(args, output, options) {
        const secret = ${JSON.stringify(SECRET)};

        options.onDiagnostics({
          scrubText(text) {
            return {
              text: text.replaceAll(secret, '[REDACTED]'),
              removed: text.includes(secret),
            };
          },
        });

        output({
          type: 'import-result',
          round: 100n,
          result: {
            status: 'imported',
            submission: 'witness',
            round: 100n,
            randomness: '0x' + '11'.repeat(32),
            transactionHash: '0x' + '22'.repeat(32),
          },
        });
      }
    `);

    const preload = installWriteHook(`
      throw Object.assign(
        new Error(
          'Output stream unavailable; token=' +
          ${JSON.stringify(SECRET)},
        ),
        { code: 'EPIPE' },
      );
    `);

    const result = launch({ preload });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe('');

    expect(diagnostic(result.stderr)).toMatchObject({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'import-result',
      status: 'imported',
      round: '100',
      transactionHash: '0x' + '22'.repeat(32),
      err: {
        code: 'EPIPE',
        message: 'Output stream unavailable; token=[REDACTED]',
        textModified: true,
      },
    });

    expect(result.stderr).not.toContain(SECRET);
  });

  it.each([true, false])(
    'attaches context only to the reported error: %s',
    (sameError) => {
      setModule('cli', `
        export async function main(args, output, options) {
          const secret = ${JSON.stringify(SECRET)};

          options.onDiagnostics({
            scrubText(text) {
              return {
                text: text.replaceAll(secret, '[REDACTED]'),
                removed: text.includes(secret),
              };
            },
          });

          const error = new Error(
            'receipt timed out; token=' + secret,
          );

          options.onImportFailure(error, {
            round: 32607411n,
            phase: 'wait-for-receipt',
            transactionHash: '0x' + '12'.repeat(32),
          });

          if (${sameError}) {
            throw error;
          }

          throw new Error('different failure; token=' + secret);
        }
      `);

      const result = launch();

      expect(result.status, result.stderr).toBe(1);

      const record = diagnostic(result.stderr);

      if (sameError) {
        expect(record.operation).toEqual({
          name: 'import-round',
          round: '32607411',
          phase: 'wait-for-receipt',
          transactionHash: '0x' + '12'.repeat(32),
        });

        expect(record).toMatchObject({
          err: {
            message: 'receipt timed out; token=[REDACTED]',
          },
        });
      } else {
        expect(record).not.toHaveProperty('operation');

        expect(record).toMatchObject({
          err: {
            message: 'different failure; token=[REDACTED]',
          },
        });
      }

      expect(result.stderr).not.toContain(SECRET);
    },
  );
});

describe('configured submission-timeout diagnostics', () => {
  it.each([
    {
      event: 'cli_failed',
      action: 'throw error;',
    },
    {
      event: 'uncaught_exception',
      action: `
        setTimeout(() => { throw error; }, 0);
        await new Promise(() => {});
      `,
    },
    {
      event: 'unhandled_rejection',
      action: `
        setTimeout(() => {
          void Promise.reject(error);
        }, 0);

        await new Promise(() => {});
      `,
    },
  ])(
    'preserves the timeout chain without raw output for $event',
    ({ event, action }) => {
      const privateKey = '0x' + 'ab'.repeat(32);
      const bodyCanary = 'RAW_SIGNED_BYTES_CANARY';

      setModule('cli', `
        import {
          createScrubber,
        } from '../diagnostics/text-scrubber.js';

        export async function main(args, output, options) {
          const secret = ${JSON.stringify(SECRET)};
          const privateKey = ${JSON.stringify(privateKey)};
          const rpcUrl =
            'https://rpc.incident.test/' + secret + '/';

          options.onDiagnostics({
            scrubText: createScrubber({
              rpcUrls: [rpcUrl],
              privateKey,
            }),
          });

          // Reproduce the diagnostic shape of the production incident.
          const timeout = Object.assign(
            new Error('The request took too long to respond.'),
            {
              name: 'TimeoutError',
              details: 'The request timed out.',
              url: rpcUrl,
              headers: {
                authorization: 'Bearer ' + secret,
              },
              body: {
                method: 'eth_sendRawTransaction',
                params: [${JSON.stringify(bodyCanary)}],
              },
            },
          );

          const transaction = Object.assign(
            new Error('Transaction failed.', {
              cause: timeout,
            }),
            {
              name: 'TransactionExecutionError',
              details: 'The request timed out.',
            },
          );

          const contract = Object.assign(
            new Error('Contract call failed.', {
              cause: transaction,
            }),
            {
              name: 'ContractFunctionExecutionError',
              details: 'The request timed out.',
              metaMessages: [${JSON.stringify(bodyCanary)}],
            },
          );

          const error = new Error(
            'Submissions blocked; inspect signer state before restarting. ' +
            'Endpoint: ' + rpcUrl +
            ' key=' + privateKey +
            ' encoded=' + encodeURIComponent(rpcUrl),
            { cause: contract },
          );

          options.onImportFailure(error, {
            round: 32607411n,
            phase: 'submit-transaction',
          });

          ${action}
        }
      `);

      const result = launch();

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe('');

      // Also verifies that stderr contains exactly one JSON record.
      const record = diagnostic(result.stderr);

      expect(record).toMatchObject({
        event,
        err: {
          name: 'Error',
          message: expect.stringContaining(
            'Submissions blocked; inspect signer state before restarting.',
          ),
          textModified: true,
          cause: {
            name: 'ContractFunctionExecutionError',
            message: 'The request timed out.',
            cause: {
              name: 'TransactionExecutionError',
              message: 'The request timed out.',
              cause: {
                name: 'TimeoutError',
                message: 'The request timed out.',
              },
            },
          },
        },
      });

      expect(result.stderr).toContain(
        'https://rpc.incident.test/[REDACTED]',
      );

      expect(result.stderr).not.toContain(SECRET);
      expect(result.stderr).not.toContain(privateKey.slice(2));
      expect(result.stderr).not.toContain(bodyCanary);

      for (const field of [
        'stack',
        'url',
        'headers',
        'body',
        'metaMessages',
      ]) {
        expect(result.stderr).not.toContain(
          JSON.stringify(field) + ':',
        );
      }

      expect(Buffer.byteLength(JSON.stringify(record.err)))
        .toBeLessThanOrEqual(8_192);

      if (event === 'cli_failed') {
        expect(record.operation).toEqual({
          name: 'import-round',
          round: '32607411',
          phase: 'submit-transaction',
        });
      } else {
        // Fatal errors must not inherit unrelated import context.
        expect(record).not.toHaveProperty('operation');
      }
    },
  );
});