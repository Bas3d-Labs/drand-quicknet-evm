import {
  spawnSync,
} from 'node:child_process';

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  fileURLToPath,
} from 'node:url';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const LAUNCHER = fileURLToPath(new URL('../../scripts/relayer.sh', import.meta.url));

describe.skipIf(process.platform !== 'linux')('attribution launcher ownership', () => {
  let root: string;

  let launcher: string;

  let state: string;

  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attribution-launcher-'));
    launcher = join(root, 'scripts', 'relayer.sh');
    state = join(root, 'state');

    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'dist'));
    mkdirSync(state, {
      mode: 0o700,
    });
    copyFileSync(LAUNCHER, launcher);
    writeFileSync(join(state, 'relayer.flock'), 'persistent-lock');
    writeFileSync(join(root, 'dist', 'bootstrap.js'), `
      const fs = require('node:fs');

      let locked = false;
      try {
        const info = fs.readFileSync('/proc/self/fdinfo/9', 'utf8');
        locked = info.includes('FLOCK') && info.includes('WRITE');
      } catch {}
      process.stdout.write(JSON.stringify({
        locked,
        args: process.argv.slice(2),
        stateDirectory: process.env.QUICKNET_STATE_DIR,
        envFileLoaded: process.env.ATTRIBUTION_TEST_ENV,
      }));
    `);

    env = {
      ...process.env,
      QUICKNET_STATE_DIR: state,
    };
    delete env.QUICKNET_ENV_FILE;
    delete env.NODE_OPTIONS;
  });

  afterEach(() => {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  });

  function run(apply: boolean, held: boolean) {
    const args = ['sh', launcher, 'attribute-transaction'];

    if (apply) {
      args.push('--apply', '--ticket', 'ticket.json');
    } else {
      args.push('--dry-run');
    }

    if (held) {
      args.unshift('flock', '--exclusive', join(state, 'relayer.flock'));
    }

    return spawnSync(args[0]!, args.slice(1), {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
  }

  it('allows read-only preview while another process holds the lock', () => {
    const result = run(false, true);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).locked).toBe(false);
  });

  it('refuses apply with exit 75 before launching Node when another process owns the lock', () => {
    const result = run(true, true);

    expect(result.status).toBe(75);
    expect(result.stdout).toBe('');
  });

  it('inherits the exclusive lock through exec without replacing or truncating its inode', () => {
    const path = join(state, 'relayer.flock');

    const before = statSync(path);

    const result = run(true, false);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).locked).toBe(true);
    expect(statSync(path).ino).toBe(before.ino);
    expect(readFileSync(path, 'utf8')).toBe('persistent-lock');
  });

  it.each(['unset', 'relative'])('uses the same directory with an env file when launch state is %s', (setting) => {
    const envFile = join(root, 'relayer.env');

    const other = join(root, 'env-file-state');

    writeFileSync(envFile, `QUICKNET_STATE_DIR=${other}\nATTRIBUTION_TEST_ENV=loaded\n`);
    env.QUICKNET_ENV_FILE = envFile;

    if (setting === 'unset') {
      delete env.QUICKNET_STATE_DIR;
    } else {
      env.QUICKNET_STATE_DIR = './state';
    }

    const dryRun = run(false, false);

    const apply = run(true, false);

    expect(dryRun.status).toBe(0);
    expect(apply.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      stateDirectory: state,
      envFileLoaded: 'loaded',
      locked: false,
    });
    expect(JSON.parse(apply.stdout)).toMatchObject({
      stateDirectory: state,
      envFileLoaded: 'loaded',
      locked: true,
    });
    expect(existsSync(other)).toBe(false);
  });

  it('does not create a missing default directory during preview', () => {
    delete env.QUICKNET_STATE_DIR;
    rmSync(state, {
      recursive: true,
    });

    const result = run(false, false);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).stateDirectory).toBe(state);
    expect(existsSync(state)).toBe(false);
  });

  it('rejects an explicitly empty directory in both modes', () => {
    env.QUICKNET_STATE_DIR = '';

    expect(run(false, false).status).toBe(1);
    expect(run(true, false).status).toBe(1);
  });
});
