import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  hostname,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  tmpdir,
} from 'node:os';
import {
  setTimeout as delay,
} from 'node:timers/promises';

import {
  CheckpointLockError,
  CheckpointLockHeldError,
  CheckpointLockStaleError,
  CheckpointLockUnvalidatableError,
  FileCheckpointLock,
} from '../src/state/file-checkpoint-lock.js';

interface SerializedLockState {
  version: number;
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

const ACQUIRED_AT = '2026-08-12T12:00:00.000Z';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const EXISTING_PID = 12_345;
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        'drand-quicknet-checkpoint-lock-',
      )
    );

  temporaryDirectories.push(
    directory,
  );

  return directory;
}

function checkpointLockPath(
  checkpointFile: string,
): string {
  return `${checkpointFile}.lock`;
}

function createLockState(
  overrides: Partial<SerializedLockState> = {},
): SerializedLockState {
  return {
    version: 1,
    ownerId: OWNER_ID,
    pid: EXISTING_PID,
    hostname: hostname(),
    acquiredAt: ACQUIRED_AT,
    ...overrides,
  };
}

async function writeExistingLock(
  checkpointFile: string,
  state: SerializedLockState,
): Promise<void> {
  const lockPath =  checkpointLockPath(checkpointFile);

  await mkdir(
    join(checkpointFile, '..'),
    { recursive: true }
  );

  await writeFile(
    lockPath,
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

function nodeError(
  code: string,
): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;

  return error;
}

afterEach(async () => {
  vi.restoreAllMocks();

  for (
    const directory of
    temporaryDirectories.splice(0)
  ) {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      }
    );
  }
});

describe('FileCheckpointLock', () => {
  it('rejects an empty checkpoint file path', () => {
    expect(
      () =>
        new FileCheckpointLock({
          checkpointFile: '',
        }),
    ).toThrow(
      'Checkpoint file path must not be empty.'
    );
  });

  it('acquires a checkpoint lock and records owner metadata', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile =
      join(
        directory,
        'nested',
        'state',
        'checkpoint.json',
      );

    const lockPath =
      checkpointLockPath(
        checkpointFile,
      );

    const lock =
      new FileCheckpointLock({
        checkpointFile,
      });

    const handle =
      await lock.acquire();

    const contents =
      await readFile(
        lockPath,
        'utf8',
      );

    const state =
      JSON.parse(
        contents,
      ) as SerializedLockState;

    expect(
      state.version,
    ).toBe(
      1
    );

    expect(
      state.ownerId,
    ).not.toBe(
      ''
    );

    expect(
      state.pid,
    ).toBe(
      process.pid
    );

    expect(
      state.hostname,
    ).toBe(
      hostname()
    );

    expect(
      Number.isNaN(
        Date.parse(
          state.acquiredAt,
        )
      ),
    ).toBe(
      false
    );

    await handle.release();
  });

  it('releases an acquired checkpoint lock', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');
    const lockPath = checkpointLockPath(checkpointFile);
    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    const handle = await lock.acquire();
    await handle.release();

    await expect(
      readFile(
        lockPath,
        'utf8',
      ),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows sequential release calls', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');
    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    const handle = await lock.acquire();
    await handle.release();
    await handle.release();
  });

  it('collapses concurrent release calls onto the same operation', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');

    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    const handle = await lock.acquire();
    const first = handle.release();
    const second = handle.release();

    expect(
      second,
    ).toBe(
      first
    );

    await Promise.all([
      first,
      second,
    ]);
  });

  it('rejects a second acquisition while the same-host owner is alive', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');

    const firstLock = new FileCheckpointLock({
      checkpointFile,
    });

    const firstHandle = await firstLock.acquire();
    const secondLock = new FileCheckpointLock({
      checkpointFile,
    });

    const rejection = secondLock.acquire();

    await expect(
      rejection,
    ).rejects.toBeInstanceOf(
      CheckpointLockHeldError,
    );

    await expect(
      rejection,
    ).rejects.toMatchObject({
      lockPath:
        checkpointLockPath(
          checkpointFile,
        ),
      sameHost: true,
      owner: {
        pid: process.pid,
        hostname: hostname(),
      },
    });

    await firstHandle.release();
  });

  it('classifies ESRCH as a stale same-host lock', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');

    await writeExistingLock(
      checkpointFile,
      createLockState(),
    );

    vi.spyOn(
      process,
      'kill',
    ).mockImplementation(
      () => {
        throw nodeError('ESRCH');
      }
    );

    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    const rejection = lock.acquire();

    await expect(
      rejection,
    ).rejects.toBeInstanceOf(
      CheckpointLockStaleError,
    );

    await expect(
      rejection,
    ).rejects.toMatchObject({
      lockPath:
        checkpointLockPath(
          checkpointFile,
        ),
      owner: {
        ownerId: OWNER_ID,
        pid: EXISTING_PID,
        hostname: hostname(),
        acquiredAt: ACQUIRED_AT,
      },
    });

    await expect(
      readFile(
        checkpointLockPath(
          checkpointFile,
        ),
        'utf8',
      ),
    ).resolves.toContain(
      OWNER_ID
    );
  });

  it('classifies EPERM as a live same-host lock', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');

    await writeExistingLock(
      checkpointFile,
      createLockState(),
    );

    vi.spyOn(
      process,
      'kill',
    ).mockImplementation(
      () => {
        throw nodeError('EPERM');
      }
    );

    const lock =
      new FileCheckpointLock({
        checkpointFile,
      });

    await expect(
      lock.acquire(),
    ).rejects.toMatchObject({
      name: 'CheckpointLockHeldError',
      sameHost: true,
    });
  });

  it('treats a different-host lock as held without checking its pid', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');

    await writeExistingLock(
      checkpointFile,
      createLockState({
        hostname:
          'another-host.example',
      }),
    );

    const kill =
      vi.spyOn(
        process,
        'kill',
      );

    const lock =
      new FileCheckpointLock({
        checkpointFile,
      });

    const rejection =
      lock.acquire();

    await expect(
      rejection,
    ).rejects.toBeInstanceOf(
      CheckpointLockHeldError,
    );

    await expect(
      rejection,
    ).rejects.toMatchObject({
      sameHost: false,
      owner: {
        hostname:
          'another-host.example',
      },
    });

    expect(
      kill,
    ).not.toHaveBeenCalled();
  });

  it('wraps unexpected pid liveness failures in CheckpointLockError', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');

    await writeExistingLock(
      checkpointFile,
      createLockState(),
    );

    const failure = nodeError('EINVAL');

    vi.spyOn(
      process,
      'kill',
    ).mockImplementation(
      () => {
        throw failure;
      }
    );

    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    const rejection = lock.acquire();

    await expect(
      rejection,
    ).rejects.toBeInstanceOf(
      CheckpointLockError,
    );

    await expect(
      rejection,
    ).rejects.not.toBeInstanceOf(
      CheckpointLockHeldError,
    );

    await expect(
      rejection,
    ).rejects.not.toBeInstanceOf(
      CheckpointLockStaleError,
    );
  });

  it('rejects a malformed existing lock without removing it', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');

    const lockPath = checkpointLockPath(
      checkpointFile,
    );

    await writeFile(lockPath, '{', 'utf8');

    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    await expect(
      lock.acquire(),
    ).rejects.toBeInstanceOf(
      CheckpointLockUnvalidatableError,
    );

    await expect(
      readFile(
        lockPath,
        'utf8',
      ),
    ).resolves.toBe(
      '{'
    );
  });

  it('retries when an existing lock is still being published', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');
    const lockPath = checkpointLockPath(checkpointFile);

    await writeFile(lockPath, '', 'utf8');

    const lockState = createLockState({
      pid: process.pid,
    });
    const fileContents = `${JSON.stringify(lockState, null, 2)}\n`;
    const publish =  delay(5).then(() => writeFile(lockPath, fileContents, 'utf8'));

    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    await expect(
      lock.acquire(),
    ).rejects.toBeInstanceOf(
      CheckpointLockHeldError,
    );

    await publish;
  });

  it('re-races acquisition when an existing lock disappears while being read', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');
    const lockPath = checkpointLockPath(checkpointFile);

    await writeFile(lockPath, '', 'utf8');

    const removeExisting = delay(5).then(() => rm(lockPath, { force: true }));

    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    const handle = await lock.acquire();

    await removeExisting;

    const state =
      JSON.parse(
        await readFile(
          lockPath,
          'utf8',
        )
      ) as SerializedLockState;

    expect(
      state.pid,
    ).toBe(
      process.pid
    );

    await handle.release();
  });

  it('refuses to release a lock whose ownerId has changed', async () => {
    const directory = await createTemporaryDirectory();
    const checkpointFile = join(directory,'checkpoint.json');
    const lockPath = checkpointLockPath(checkpointFile);

    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    const handle = await lock.acquire();

    const state =
      JSON.parse(
        await readFile(
          lockPath,
          'utf8',
        )
      ) as SerializedLockState;

    const fileContents = `${JSON.stringify({
      ...state,
      ownerId:
        OTHER_OWNER_ID,
    }, null, 2)}\n`;
    await writeFile(
      lockPath,
      fileContents,
      'utf8',
    );

    await expect(
      handle.release(),
    ).rejects.toThrow(
      `Checkpoint lock ${lockPath} is no longer owned by this relayer; refusing to remove it.`
    );

    const replacement =
      JSON.parse(
        await readFile(
          lockPath,
          'utf8',
        )
      ) as SerializedLockState;

    expect(
      replacement.ownerId,
    ).toBe(
      OTHER_OWNER_ID
    );
  });

  it('fails acquisition when the lock directory cannot be created', async () => {
    const directory = await createTemporaryDirectory();
    const parentFile = join(directory, 'not-a-directory');

    await writeFile(parentFile, 'file', 'utf8');

    const checkpointFile = join(parentFile, 'checkpoint.json');
    const lock = new FileCheckpointLock({
      checkpointFile,
    });

    await expect(
      lock.acquire(),
    ).rejects.toBeInstanceOf(
      CheckpointLockError,
    );
  });
});