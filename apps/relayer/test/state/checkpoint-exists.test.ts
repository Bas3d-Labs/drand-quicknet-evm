import {
  mkdtemp,
  mkdir,
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
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  checkpointExists,
} from '../../src/state/checkpoint-exists.js';

describe('checkpointExists', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'checkpoint-exists-'),
    );

    filePath = join(directory, 'checkpoint.json');
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  it('returns false for an absent checkpoint', async () => {
    expect(await checkpointExists(filePath)).toBe(false);
  });

  it('returns true for an existing checkpoint', async () => {
    await writeFile(filePath, '{}');

    expect(await checkpointExists(filePath)).toBe(true);
  });

  it('counts malformed checkpoint contents as prior state', async () => {
    await writeFile(filePath, 'invalid JSON');

    expect(await checkpointExists(filePath)).toBe(true);
  });

  it('counts a directory at the checkpoint path as prior state', async () => {
    await mkdir(filePath);

    expect(await checkpointExists(filePath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'counts a dangling symlink as prior state',
    async () => {
      await symlink(
        join(directory, 'missing-target.json'),
        filePath,
      );

      expect(await checkpointExists(filePath)).toBe(true);
    },
  );

  it('propagates errors other than missing paths', async () => {
    await writeFile(filePath, '{}');

    // A regular file cannot serve as a parent directory.
    await expect(
      checkpointExists(join(filePath, 'child.json')),
    ).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});