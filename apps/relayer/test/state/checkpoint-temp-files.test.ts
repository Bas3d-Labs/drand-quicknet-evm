import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  removeCheckpointTempFiles,
} from '../../src/state/checkpoint-temp-files.js';

const UUID = '12345678-1234-4abc-8def-123456789abc';

describe('removeCheckpointTempFiles', () => {
  let directory: string;
  let checkpointFile: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'quicknet-checkpoint-temps-'),
    );

    checkpointFile = join(directory, 'checkpoint.json');
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  it('removes exact temp names while preserving checkpoint and lock files', async () => {
    const names = [
      'checkpoint.json',
      'relayer.flock',
      `checkpoint.json.123.${UUID}.tmp`,
      `checkpoint.json.456.${UUID}.tmp`,
    ];

    for (const name of names) {
      await writeFile(join(directory, name), name, 'utf8');
    }

    await removeCheckpointTempFiles(checkpointFile);

    expect((await readdir(directory)).sort()).toEqual([
      'checkpoint.json',
      'relayer.flock',
    ]);

    expect(await readFile(checkpointFile, 'utf8'))
      .toBe('checkpoint.json');

    expect(
      await readFile(join(directory, 'relayer.flock'), 'utf8'),
    ).toBe('relayer.flock');
  });

  it('matches the entire checkpoint basename, including dots', async () => {
    checkpointFile = join(directory, 'service.checkpoint.json');

    const matching =
      `service.checkpoint.json.123.${UUID}.tmp`;

    const unrelated =
      `checkpoint.json.123.${UUID}.tmp`;

    await writeFile(join(directory, matching), '');
    await writeFile(join(directory, unrelated), '');

    await removeCheckpointTempFiles(checkpointFile);

    expect(await readdir(directory)).toEqual([unrelated]);
  });

  it.each([
    ['zero PID', `checkpoint.json.0.${UUID}.tmp`],
    ['leading-zero PID', `checkpoint.json.0123.${UUID}.tmp`],
    ['negative PID', `checkpoint.json.-1.${UUID}.tmp`],
    ['nondecimal PID', `checkpoint.json.12a.${UUID}.tmp`],
    ['empty PID', `checkpoint.json..${UUID}.tmp`],
    [
      'unsafe integer PID',
      `checkpoint.json.9007199254740992.${UUID}.tmp`,
    ],
    ['uppercase UUID', `checkpoint.json.123.${UUID.toUpperCase()}.tmp`],
    [
      'wrong UUID version',
      'checkpoint.json.123.12345678-1234-5abc-8def-123456789abc.tmp',
    ],
    [
      'wrong UUID variant',
      'checkpoint.json.123.12345678-1234-4abc-7def-123456789abc.tmp',
    ],
    [
      'nonhex UUID',
      'checkpoint.json.123.12345678-1234-4abc-8def-123456789abg.tmp',
    ],
    ['truncated UUID', `checkpoint.json.123.${UUID.slice(1)}.tmp`],
    ['newline after UUID', `checkpoint.json.123.${UUID}\n.tmp`],
    ['different checkpoint', `other.json.123.${UUID}.tmp`],
    ['extra prefix', `other.checkpoint.json.123.${UUID}.tmp`],
    ['extra suffix', `checkpoint.json.123.${UUID}.tmp.extra`],
  ])('preserves a name with %s', async (_description, name) => {
    await writeFile(join(directory, name), 'preserve', 'utf8');

    await removeCheckpointTempFiles(checkpointFile);

    expect(await readFile(join(directory, name), 'utf8'))
      .toBe('preserve');
  });

  it('preserves matching symlinks and their targets', async () => {
    const target = join(directory, 'target');
    const candidate = join(
      directory,
      `checkpoint.json.123.${UUID}.tmp`,
    );

    await writeFile(target, 'preserve', 'utf8');
    await symlink(target, candidate);

    await removeCheckpointTempFiles(checkpointFile);

    expect(await readFile(candidate, 'utf8')).toBe('preserve');
    expect(await readFile(target, 'utf8')).toBe('preserve');
  });

  it('preserves matching hard links and their aliases', async () => {
    const target = join(directory, 'target');
    const candidate = join(
      directory,
      `checkpoint.json.123.${UUID}.tmp`,
    );

    await writeFile(target, 'preserve', 'utf8');
    await link(target, candidate);

    await removeCheckpointTempFiles(checkpointFile);

    expect(await readFile(candidate, 'utf8')).toBe('preserve');
    expect(await readFile(target, 'utf8')).toBe('preserve');
  });

  it('preserves matching directories without traversing them', async () => {
    const candidate = join(
      directory,
      `checkpoint.json.123.${UUID}.tmp`,
    );

    await mkdir(candidate);
    await writeFile(join(candidate, 'child'), 'preserve', 'utf8');

    await removeCheckpointTempFiles(checkpointFile);

    expect(await readFile(join(candidate, 'child'), 'utf8'))
      .toBe('preserve');
  });

  it('rejects a missing state directory without creating it', async () => {
    await expect(
      removeCheckpointTempFiles(
        join(directory, 'missing', 'checkpoint.json'),
      ),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });

    expect(await readdir(directory)).toEqual([]);
  });
});