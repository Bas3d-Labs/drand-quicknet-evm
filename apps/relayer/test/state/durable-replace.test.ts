import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  basename,
  join,
} from 'node:path';

const faults = vi.hoisted(() => ({
  fileSync: undefined as Error | undefined,
  directoryClose: undefined as Error | undefined,
  directorySync: undefined as Error | undefined,
  rename: undefined as Error | undefined,
  events: [] as string[],
  tempPaths: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('node:fs/promises')
  >();

  return {
    ...actual,

    async open(
      ...args: Parameters<typeof actual.open>
    ) {
      const handle = await actual.open(...args);
      const isTemporaryFile = args[1] === 'wx';

      let kind = 'directory';

      if (isTemporaryFile) {
        kind = 'file';
        faults.tempPaths.push(String(args[0]));
      }

      faults.events.push(`${kind}:open`);

      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);

      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        faults.events.push(`${kind}:sync`);

        let failure = faults.directorySync;

        if (isTemporaryFile) {
          failure = faults.fileSync;
          faults.fileSync = undefined;
        } else {
          faults.directorySync = undefined;
        }

        if (failure !== undefined) {
          throw failure;
        }

        await sync();
      });

      vi.spyOn(handle, 'close').mockImplementation(async () => {
        faults.events.push(`${kind}:close`);

        let failure: Error | undefined;

        if (!isTemporaryFile) {
          failure = faults.directoryClose;
          faults.directoryClose = undefined;
        }

        await close();

        if (failure !== undefined) {
          throw failure;
        }
      });

      return handle;
    },

    async rename(
      ...args: Parameters<typeof actual.rename>
    ) {
      faults.events.push('rename');

      const failure = faults.rename;
      faults.rename = undefined;

      if (failure !== undefined) {
        throw failure;
      }

      await actual.rename(...args);
    },
  };
});

import {
  durableReplace,
} from '../../src/state/durable-replace.js';

const ORIGINAL = '{"checkpoint":"original"}\n';
const UPDATED = '{"checkpoint":"updated"}\n';
const RECOVERY = '{"checkpoint":"recovery"}\n';

describe('durableReplace', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    faults.fileSync = undefined;
    faults.directoryClose = undefined;
    faults.directorySync = undefined;
    faults.rename = undefined;
    faults.events.length = 0;
    faults.tempPaths.length = 0;

    directory = await mkdtemp(
      join(tmpdir(), 'quicknet-durable-replace-'),
    );

    filePath = join(directory, 'checkpoint.json');

    await writeFile(filePath, ORIGINAL, 'utf8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  async function expectOnlyCheckpoint(): Promise<void> {
    expect(await readdir(directory)).toEqual([
      basename(filePath),
    ]);
  }

  it('syncs and closes the file before rename, then syncs the directory', async () => {
    await durableReplace(filePath, UPDATED);

    expect(faults.events).toEqual([
      'directory:open',
      'file:open',
      'file:sync',
      'file:close',
      'rename',
      'directory:sync',
      'directory:close',
    ]);

    expect(await readFile(filePath, 'utf8')).toBe(UPDATED);

    await expectOnlyCheckpoint();
  });

  it('creates a checkpoint when its parent directory already exists', async () => {
    await rm(filePath);

    await durableReplace(filePath, UPDATED);

    expect(await readFile(filePath, 'utf8')).toBe(UPDATED);

    await expectOnlyCheckpoint();
  });

  it('preserves the previous checkpoint when file sync fails', async () => {
    const failure = new Error('Injected file sync failure.');
    faults.fileSync = failure;

    await expect(
      durableReplace(filePath, UPDATED),
    ).rejects.toMatchObject({
      cause: failure,
    });

    expect(await readFile(filePath, 'utf8')).toBe(ORIGINAL);
    expect(faults.events).not.toContain('rename');
    expect(faults.events).not.toContain('directory:sync');

    expect(
      faults.events.filter((event) => event === 'file:sync'),
    ).toHaveLength(1);

    expect(faults.events).toContain('file:close');
    expect(faults.events).toContain('directory:close');

    await expectOnlyCheckpoint();
  });

  it('preserves the previous checkpoint and removes the temp file when rename fails', async () => {
    const failure = new Error('Injected rename failure.');
    faults.rename = failure;

    await expect(
      durableReplace(filePath, UPDATED),
    ).rejects.toMatchObject({
      cause: failure,
    });

    expect(await readFile(filePath, 'utf8')).toBe(ORIGINAL);
    expect(faults.events).not.toContain('directory:sync');
    expect(faults.events).toContain('directory:close');

    await expectOnlyCheckpoint();
  });

  it('reports directory sync failure without deleting the renamed checkpoint', async () => {
    const failure = new Error('Injected directory sync failure.');
    faults.directorySync = failure;

    await expect(
      durableReplace(filePath, UPDATED),
    ).rejects.toMatchObject({
      cause: failure,
    });

    // Rename completed, so the new contents are visible. The failed
    // directory sync means persistence was not acknowledged.
    expect(await readFile(filePath, 'utf8')).toBe(UPDATED);

    expect(
      faults.events.filter(
        (event) => event === 'directory:sync',
      ),
    ).toHaveLength(1);

    expect(faults.events).toContain('directory:close');

    await expectOnlyCheckpoint();
  });

  it('resolves when directory close fails after successful sync', async () => {
    faults.directoryClose =
      new Error('Injected directory close failure.');

    await expect(
      durableReplace(filePath, UPDATED),
    ).resolves.toBeUndefined();

    expect(faults.events).toEqual([
      'directory:open',
      'file:open',
      'file:sync',
      'file:close',
      'rename',
      'directory:sync',
      'directory:close',
    ]);

    expect(await readFile(filePath, 'utf8')).toBe(UPDATED);

    await expectOnlyCheckpoint();
  });

  it('preserves the directory sync error when directory close also fails', async () => {
    const syncFailure =
      new Error('Injected directory sync failure.');
    const closeFailure =
      new Error('Injected directory close failure.');

    faults.directorySync = syncFailure;
    faults.directoryClose = closeFailure;

    await expect(
      durableReplace(filePath, UPDATED),
    ).rejects.toMatchObject({
      cause: syncFailure,
    });

    expect(faults.events).toEqual([
      'directory:open',
      'file:open',
      'file:sync',
      'file:close',
      'rename',
      'directory:sync',
      'directory:close',
    ]);

    expect(await readFile(filePath, 'utf8')).toBe(UPDATED);

    await expectOnlyCheckpoint();
  });

  it.each([
    'fileSync',
    'directorySync',
  ] as const)(
    'recovers from %s failure using a fresh complete snapshot',
    async (phase) => {
      const failure = new Error(`Injected ${phase} failure.`);
      faults[phase] = failure;

      await expect(
        durableReplace(filePath, UPDATED),
      ).rejects.toMatchObject({
        cause: failure,
      });

      expect(faults.tempPaths).toHaveLength(1);

      const failedTempPath = faults.tempPaths[0];

      faults.events.length = 0;

      await durableReplace(filePath, RECOVERY);

      expect(faults.tempPaths).toHaveLength(2);
      expect(faults.tempPaths[1]).not.toBe(failedTempPath);

      expect(faults.events).toEqual([
        'directory:open',
        'file:open',
        'file:sync',
        'file:close',
        'rename',
        'directory:sync',
        'directory:close',
      ]);

      expect(await readFile(filePath, 'utf8')).toBe(RECOVERY);

      await expectOnlyCheckpoint();
    },
  );
});