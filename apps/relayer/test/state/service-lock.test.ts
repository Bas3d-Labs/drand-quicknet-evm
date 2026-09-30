import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import {
  execFile,
  spawn,
} from 'node:child_process';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  promisify,
} from 'node:util';

import {
  stripTypeScriptTypes,
} from 'node:module';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
  serviceLockReason,
  type ServiceLockReason,
} from '../../src/state/service-lock.js';

const execFileAsync = promisify(execFile);

type ProbeResult =
  | {
      status: 'held';
      stateDirectory: string;
    }
  | {
      status: 'refused';
      reason: ServiceLockReason;
      message: string;
    };

describe('service lock diagnostics', () => {
  it('recognizes registered errors', () => {
    for (const reason of [
      'platform',
      'state-directory',
      'lock-file',
      'descriptor',
    ] as const) {
      const error = new ServiceLockNotHeldError(reason);

      expect(serviceLockReason(error)).toBe(reason);
      expect(error.message).toBe(
        'Required relayer service lock was not verified.',
      );
    }
  });

  it('does not trust error-shaped objects', () => {
    expect(serviceLockReason({
      name: 'ServiceLockNotHeldError',
      reason: 'descriptor',
    })).toBeUndefined();

    expect(serviceLockReason(new Error('descriptor')))
      .toBeUndefined();

    expect(serviceLockReason(null)).toBeUndefined();
  });

  it('rejects an unknown diagnostic reason', () => {
    expect(() => new ServiceLockNotHeldError(
      'unknown' as ServiceLockReason,
    )).toThrow('Invalid service lock reason.');
  });

  it.skipIf(process.platform === 'linux')(
    'refuses protected execution outside Linux',
    () => {
      let failure: unknown;

      try {
        assertServiceLockHeld();
      } catch (error) {
        failure = error;
      }

      expect(serviceLockReason(failure)).toBe('platform');
    },
  );
});

describe.skipIf(process.platform !== 'linux')(
  'service lock descriptor verification',
  () => {
    let root: string;
    let runnerFile: string;

    beforeAll(async () => {
      // Linux integration tests require util-linux flock.
      // Missing infrastructure should fail rather than silently skip.
      const version = await execFileAsync('flock', ['--version']);
      expect(version.stdout).toContain('util-linux');

      root = await mkdtemp(
        join(tmpdir(), 'quicknet-service-lock-'),
      );

      const source = await readFile(
        new URL(
          '../../src/state/service-lock.ts',
          import.meta.url,
        ),
        'utf8',
      );

      // Run the actual implementation in independent Node processes.
      // Avoid relying on generated dist files or a TS runtime loader.
      const compiled = stripTypeScriptTypes(source, {
        mode: 'strip',
      });

      await writeFile(
        join(root, 'service-lock.mjs'),
        compiled,
        'utf8',
      );

      runnerFile = join(root, 'probe.mjs');

      await writeFile(
        runnerFile,
        `
import {
  closeSync,
  openSync,
} from 'node:fs';

import {
  join,
} from 'node:path';

import {
  assertServiceLockHeld,
  serviceLockReason,
} from './service-lock.mjs';

const [mode, stateDirectory, checkpointFile] =
  process.argv.slice(2);

let unrelatedFd;

try {
  if (mode === 'open-unlocked') {
    unrelatedFd = openSync(
      join(stateDirectory, 'relayer.flock'),
      'r',
    );
  }

  const options = {
    env: {
      QUICKNET_STATE_DIR: stateDirectory,
    },
  };

  if (checkpointFile !== undefined) {
    options.checkpointFile = checkpointFile;
  }

  const canonicalDirectory = assertServiceLockHeld(options);

  process.stdout.write(JSON.stringify({
    status: 'held',
    stateDirectory: canonicalDirectory,
  }) + '\\n');

  if (mode === 'hold') {
    setInterval(() => {}, 1_000);
  }
} catch (error) {
  const reason = serviceLockReason(error);

  if (reason === undefined) {
    throw error;
  }

  process.stdout.write(JSON.stringify({
    status: 'refused',
    reason,
    message: error.message,
  }) + '\\n');
} finally {
  if (unrelatedFd !== undefined) {
    closeSync(unrelatedFd);
  }
}
`,
        'utf8',
      );
    });

    afterAll(async () => {
      if (root !== undefined) {
        await rm(root, {
          recursive: true,
          force: true,
        });
      }
    });

    async function createStateDirectory(): Promise<string> {
      return mkdtemp(join(root, 'state-'));
    }

    async function probe(
      stateDirectory: string,
      options: {
        lock?: 'exclusive' | 'shared';
        checkpointFile?: string;
        openUnlocked?: boolean;
      } = {},
    ): Promise<ProbeResult> {
      let mode = 'probe';

      if (options.openUnlocked) {
        mode = 'open-unlocked';
      }

      const nodeArgs = [
        runnerFile,
        mode,
        stateDirectory,
      ];

      if (options.checkpointFile !== undefined) {
        nodeArgs.push(options.checkpointFile);
      }

      let command = process.execPath;
      let args = nodeArgs;

      if (options.lock !== undefined) {
        command = 'flock';
        args = [
          `--${options.lock}`,
          '--nonblock',
          '--no-fork',
          '--conflict-exit-code',
          '75',
          join(stateDirectory, 'relayer.flock'),
          process.execPath,
          ...nodeArgs,
        ];
      }

      const result = await execFileAsync(command, args, {
        timeout: 5_000,
      });

      return JSON.parse(result.stdout) as ProbeResult;
    }

    it('verifies an inherited exclusive lock', async () => {
      const stateDirectory = await createStateDirectory();

      expect(await probe(stateDirectory, {
        lock: 'exclusive',
        checkpointFile: join(stateDirectory, 'checkpoint.json'),
      })).toEqual({
        status: 'held',
        stateDirectory: await realpath(stateDirectory),
      });
    });

    it('refuses bare execution with an existing lock file', async () => {
      const stateDirectory = await createStateDirectory();

      await writeFile(
        join(stateDirectory, 'relayer.flock'),
        '',
      );

      expect(await probe(stateDirectory)).toMatchObject({
        status: 'refused',
        reason: 'descriptor',
      });
    });

    it('refuses an inherited shared lock', async () => {
      const stateDirectory = await createStateDirectory();

      expect(await probe(stateDirectory, {
        lock: 'shared',
      })).toMatchObject({
        status: 'refused',
        reason: 'descriptor',
      });
    });

    it('does not confuse another process ownership with an open descriptor', async () => {
      const stateDirectory = await createStateDirectory();

      const holder = spawn('flock', [
        '--exclusive',
        '--nonblock',
        '--no-fork',
        join(stateDirectory, 'relayer.flock'),
        process.execPath,
        runnerFile,
        'hold',
        stateDirectory,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const exited = new Promise<void>((resolve) => {
        holder.once('close', () => resolve());
      });

      try {
        const ready = await new Promise<ProbeResult>(
          (resolve, reject) => {
            let output = '';
            let stderr = '';

            const timeout = setTimeout(() => {
              reject(new Error('Lock holder did not become ready.'));
            }, 5_000);

            holder.once('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });

            holder.once('close', () => {
              clearTimeout(timeout);
              reject(new Error(
                `Lock holder exited before readiness: ${stderr}`,
              ));
            });

            holder.stderr.on('data', (chunk) => {
              stderr += chunk.toString();
            });

            holder.stdout.on('data', (chunk) => {
              output += chunk.toString();

              if (!output.includes('\n')) {
                return;
              }

              clearTimeout(timeout);

              try {
                resolve(JSON.parse(output.trim()) as ProbeResult);
              } catch (error) {
                reject(error);
              }
            });
          },
        );

        expect(ready.status).toBe('held');

        expect(await probe(stateDirectory, {
          openUnlocked: true,
        })).toMatchObject({
          status: 'refused',
          reason: 'descriptor',
        });

        await expect(probe(stateDirectory, {
          lock: 'exclusive',
        })).rejects.toMatchObject({
          code: 75,
        });
      } finally {
        holder.kill('SIGKILL');
        await exited;
      }

      // Ownership recovers without deleting the persistent lock file.
      expect(await probe(stateDirectory, {
        lock: 'exclusive',
      })).toMatchObject({
        status: 'held',
      });
    });

    it('refuses a world-writable state directory', async () => {
      const stateDirectory = await createStateDirectory();
      await chmod(stateDirectory, 0o777);

      expect(await probe(stateDirectory, {
        lock: 'exclusive',
      })).toMatchObject({
        status: 'refused',
        reason: 'state-directory',
      });
    });

    it('refuses a missing lock file without exposing its path', async () => {
      const stateDirectory = await createStateDirectory();
      const result = await probe(stateDirectory);

      expect(result).toEqual({
        status: 'refused',
        reason: 'lock-file',
        message: 'Required relayer service lock was not verified.',
      });

      expect(JSON.stringify(result)).not.toContain(stateDirectory);
    });

    it('refuses a symlink used as the lock file', async () => {
      const stateDirectory = await createStateDirectory();
      const target = join(stateDirectory, 'other-file');

      await writeFile(target, '');
      await symlink(target, join(stateDirectory, 'relayer.flock'));

      expect(await probe(stateDirectory, {
        lock: 'exclusive',
      })).toMatchObject({
        status: 'refused',
        reason: 'lock-file',
      });
    });

    it('refuses a hard-linked lock file', async () => {
      const stateDirectory = await createStateDirectory();
      const lockFile = join(stateDirectory, 'relayer.flock');

      await writeFile(lockFile, '');
      await link(lockFile, join(stateDirectory, 'lock-alias'));

      expect(await probe(stateDirectory, {
        lock: 'exclusive',
      })).toMatchObject({
        status: 'refused',
        reason: 'lock-file',
      });
    });

    it('accepts an existing regular checkpoint', async () => {
      const stateDirectory = await createStateDirectory();
      const checkpointFile = join(stateDirectory, 'checkpoint.json');

      await writeFile(checkpointFile, '{}');

      expect(await probe(stateDirectory, {
        lock: 'exclusive',
        checkpointFile,
      })).toMatchObject({
        status: 'held',
      });
    });

    it('rejects checkpoints outside the direct state directory', async () => {
      const stateDirectory = await createStateDirectory();
      const nested = join(stateDirectory, 'nested');
      const outside = await createStateDirectory();

      await mkdir(nested);

      for (const checkpointFile of [
        join(nested, 'checkpoint.json'),
        join(outside, 'checkpoint.json'),
      ]) {
        expect(await probe(stateDirectory, {
          lock: 'exclusive',
          checkpointFile,
        })).toMatchObject({
          status: 'refused',
          reason: 'state-directory',
        });
      }
    });

    it('rejects the reserved lock filename as a checkpoint', async () => {
      const stateDirectory = await createStateDirectory();

      expect(await probe(stateDirectory, {
        lock: 'exclusive',
        checkpointFile: join(stateDirectory, 'relayer.flock'),
      })).toMatchObject({
        status: 'refused',
        reason: 'state-directory',
      });
    });

    it('rejects checkpoint symlinks and hard-link aliases', async () => {
      const stateDirectory = await createStateDirectory();
      const target = join(stateDirectory, 'target.json');
      const symbolic = join(stateDirectory, 'symbolic.json');
      const hard = join(stateDirectory, 'hard.json');

      await writeFile(target, '{}');
      await symlink(target, symbolic);
      await link(target, hard);

      for (const checkpointFile of [symbolic, hard]) {
        expect(await probe(stateDirectory, {
          lock: 'exclusive',
          checkpointFile,
        })).toMatchObject({
          status: 'refused',
          reason: 'state-directory',
        });
      }
    });

    it('returns the canonical directory when configured through an alias', async () => {
      const stateDirectory = await createStateDirectory();
      const alias = join(root, 'state-alias');

      await symlink(stateDirectory, alias);

      expect(await probe(alias, {
        lock: 'exclusive',
        checkpointFile: join(alias, 'checkpoint.json'),
      })).toEqual({
        status: 'held',
        stateDirectory: await realpath(stateDirectory),
      });
    });
  },
);