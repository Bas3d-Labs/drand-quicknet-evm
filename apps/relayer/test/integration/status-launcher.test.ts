import {
  spawnSync,
} from 'node:child_process';

import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

import {
  tmpdir,
} from 'node:os';

import {
  delimiter,
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

const LAUNCHER = fileURLToPath(
  new URL('../../scripts/relayer.sh', import.meta.url),
);

const ARGS = [
  'status',
  '--chain-id', '4663',
  '--signer', `0x${'ab'.repeat(20)}`,
];

describe.skipIf(process.platform !== 'linux')('status launcher', () => {
  let root: string;
  let launcher: string;
  let state: string;
  let bin: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'status-launcher-'));
    const app = join(root, 'app');
    bin = join(root, 'bin');
    state = join(root, 'state');

    mkdirSync(join(app, 'scripts'), { recursive: true });
    mkdirSync(join(app, 'dist'));
    mkdirSync(bin);
    mkdirSync(state, { mode: 0o700 });

    launcher = join(app, 'scripts', 'relayer.sh');
    copyFileSync(LAUNCHER, launcher);

    symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(join(state, 'relayer.flock'), 'preserve-me');

    writeFileSync(join(app, 'dist', 'bootstrap.js'), `
      const fs = require('node:fs');
      const path = require('node:path');

      let inheritedLock = false;

      try {
        const opened = fs.fstatSync(9);
        const expected = fs.statSync(
          path.join(process.env.QUICKNET_STATE_DIR, 'relayer.flock')
        );
        inheritedLock =
          opened.dev === expected.dev && opened.ino === expected.ino;
      } catch {}

      process.stdout.write(JSON.stringify({
        args: process.argv.slice(2),
        stateDirectory: process.env.QUICKNET_STATE_DIR,
        inheritedLock,
      }));
    `);

    env = {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      QUICKNET_STATE_DIR: state,
      QUICKNET_ENV_FILE: join(root, 'missing.env'),
    };

    delete env.NODE_OPTIONS;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(args = ARGS) {
    return spawnSync('sh', [launcher, ...args], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
  }

  function held(args = ARGS) {
    return spawnSync('flock', [
      '--exclusive',
      join(state, 'relayer.flock'),
      'sh',
      launcher,
      ...args,
    ], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
  }

  it('selects journal when ownership is acquired and preserves files', () => {
    const result = run();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: [...ARGS, '--source', 'journal'],
      stateDirectory: state,
      inheritedLock: true,
    });

    expect(readdirSync(state)).toEqual(['relayer.flock']);
    expect(readFileSync(join(state, 'relayer.flock'), 'utf8'))
      .toBe('preserve-me');
  });

  it('selects snapshot only on contention and closes descriptor 9', () => {
    const result = held();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      args: [...ARGS, '--source', 'daemon-snapshot'],
      inheritedLock: false,
    });
  });

  it('preserves explicit journal contention as exit 75', () => {
    const result = held([...ARGS, '--source', 'journal']);

    expect(result.status).toBe(75);
    expect(result.stdout).toBe('');
  });

  it('preserves explicit journal source without duplicating it', () => {
    const args = [...ARGS, '--source', 'journal'];
    const result = run(args);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).args).toEqual(args);
  });

  it('reads explicit snapshot mode without flock or an env file', () => {
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 99\n', {
      mode: 0o700,
    });

    const args = [...ARGS, '--source', 'daemon-snapshot'];
    const result = run(args);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      args,
      inheritedLock: false,
    });
  });

  it('does not create a missing directory in explicit snapshot mode', () => {
    rmSync(state, { recursive: true });

    const result = run([...ARGS, '--source', 'daemon-snapshot']);

    expect(result.status).toBe(0);
    expect(readdirSync(root)).not.toContain('state');
  });

  it('fails automatic selection without creating a missing directory', () => {
    rmSync(state, { recursive: true });

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readdirSync(root)).not.toContain('state');
  });

  it('fails automatic selection without creating a missing lock', () => {
    rmSync(join(state, 'relayer.flock'));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readdirSync(state)).toEqual([]);
  });

  it.each(['symlink', 'hard-link'] as const)(
    'rejects a lock %s',
    (kind) => {
      const lock = join(state, 'relayer.flock');

      if (kind === 'symlink') {
        rmSync(lock);
        const target = join(root, 'other-lock');
        writeFileSync(target, '');
        symlinkSync(target, lock);
      } else {
        linkSync(lock, join(root, 'other-lock'));
      }

      const result = run();

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
  );

  it('preserves non-contention flock errors without running Node', () => {
    writeFileSync(join(bin, 'flock'), [
      '#!/bin/sh',
      'if [ "${1-}" = "--version" ]; then',
      '  printf "%s\\n" "flock from util-linux"',
      '  exit 0',
      'fi',
      'exit 74',
      '',
    ].join('\n'), { mode: 0o700 });

    const result = run();

    expect(result.status).toBe(74);
    expect(result.stdout).toBe('');
  });

  it('canonicalizes the directory before journal inspection', () => {
    const alias = join(root, 'state-alias');
    symlinkSync(state, alias);
    env.QUICKNET_STATE_DIR = alias;

    const result = run();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).stateDirectory).toBe(state);
  });

  it('preserves help precedence without preparing state', () => {
    rmSync(state, { recursive: true });

    const result = run(['status', '--source', '--help']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).args)
      .toEqual(['status', '--source', '--help']);
    expect(readdirSync(root)).not.toContain('state');
  });

  it('accepts the leading package-manager separator', () => {
    const result = run(['--', ...ARGS]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).args)
      .toEqual([...ARGS, '--source', 'journal']);
  });

  it('leaves duplicate source arguments for Node to reject', () => {
    const args = [
      ...ARGS,
      '--source', 'journal',
      '--source', 'daemon-snapshot',
    ];

    const result = run(args);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      args,
      inheritedLock: false,
    });
  });
});