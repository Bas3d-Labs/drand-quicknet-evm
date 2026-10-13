import {
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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
  vi,
} from 'vitest';

import type {
  DaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

import {
  MAX_DAEMON_STATUS_BYTES,
  readDaemonStatusFile,
  writeDaemonStatusFile,
} from '../../src/state/file-daemon-status-store.js';

import {
  assertServiceLockHeld,
  DAEMON_STATUS_FILENAME,
  ServiceLockNotHeldError,
} from '../../src/state/service-lock.js';

vi.mock('../../src/state/service-lock.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/service-lock.js')
  >();

  return {
    ...actual,
    assertServiceLockHeld: vi.fn(),
  };
});

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

function snapshot(): DaemonStatusSnapshot {
  return {
    version: 1,
    identity: { ...IDENTITY },
    runId: '11111111-1111-4111-8111-111111111111',
    observedAt: '2026-10-12T12:00:00.000Z',
    journalInitialized: true,
    lastObservedGate: {
      open: false,
      primaryReason: 'recovery-incomplete',
      blockers: ['recovery-incomplete'],
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle',
      blockedSince: null,
    },
  };
}

describe('daemon status file storage', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'relayer-daemon-status-'),
    );

    filePath = join(directory, DAEMON_STATUS_FILENAME);

    vi.mocked(assertServiceLockHeld)
      .mockReset()
      .mockReturnValue({
        stateDirectory: directory,
        dev: 1n,
        ino: 2n,
      });
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  function options() {
    return {
      identity: { ...IDENTITY },
      env: {
        QUICKNET_STATE_DIR: directory,
      },
    };
  }

  it('returns null for a missing snapshot without creating files', async () => {
    expect(await readDaemonStatusFile(options())).toBeNull();
    expect(await readdir(directory)).toEqual([]);
    expect(assertServiceLockHeld).not.toHaveBeenCalled();
  });

  it('publishes and replaces complete snapshots', async () => {
    const first = snapshot();

    await writeDaemonStatusFile({
      ...options(),
      snapshot: first,
    });

    expect(await readDaemonStatusFile(options())).toEqual(first);

    const second: DaemonStatusSnapshot = {
      ...first,
      observedAt: '2026-10-12T12:01:00.000Z',
      journalInitialized: true,
      lastObservedGate: {
        open: true,
        primaryReason: null,
        blockers: [],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
        blockedSince: null,
      },
    };

    await writeDaemonStatusFile({
      ...options(),
      snapshot: second,
    });

    expect(await readDaemonStatusFile(options())).toEqual(second);
    expect(await readdir(directory)).toEqual([DAEMON_STATUS_FILENAME]);

    const info = await stat(filePath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('reads without ownership and preserves temporary files', async () => {
    const contents = JSON.stringify(snapshot());
    await writeFile(filePath, contents);

    const temporary =
      `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;

    await writeFile(temporary, 'orphaned snapshot');

    vi.mocked(assertServiceLockHeld).mockImplementation(() => {
      throw new ServiceLockNotHeldError('descriptor');
    });

    const before = await stat(filePath, { bigint: true });

    expect(await readDaemonStatusFile(options())).toEqual(snapshot());
    expect(assertServiceLockHeld).not.toHaveBeenCalled();
    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(await readFile(temporary, 'utf8')).toBe('orphaned snapshot');

    const after = await stat(filePath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  });

  it('refuses publication without ownership', async () => {
    const failure = new ServiceLockNotHeldError('descriptor');

    vi.mocked(assertServiceLockHeld).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(writeDaemonStatusFile({
      ...options(),
      snapshot: snapshot(),
    })).rejects.toBe(failure);

    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { name: 'invalid JSON', contents: '{' },
    { name: 'invalid UTF-8', contents: Buffer.from([0xff]) },
    {
      name: 'oversized data',
      contents: 'x'.repeat(MAX_DAEMON_STATUS_BYTES + 1),
    },
    {
      name: 'wrong identity',
      contents: JSON.stringify({
        ...snapshot(),
        identity: { ...IDENTITY, chainId: 1 },
      }),
    },
  ])('rejects $name without replacing the file', async ({ contents }) => {
    await writeFile(filePath, contents);
    const before = await readFile(filePath);

    await expect(readDaemonStatusFile(options())).rejects.toThrow();
    expect(await readFile(filePath)).toEqual(before);
  });

  it.each(['symlink', 'hard-link'] as const)(
    'rejects a %s destination for reading and publication',
    async (kind) => {
      const target = join(directory, 'target.json');
      const contents = JSON.stringify(snapshot());

      await writeFile(target, contents);

      if (kind === 'symlink') {
        await symlink(target, filePath);
      } else {
        await link(target, filePath);
      }

      await expect(readDaemonStatusFile(options())).rejects.toThrow();

      await expect(writeDaemonStatusFile({
        ...options(),
        snapshot: snapshot(),
      })).rejects.toThrow();

      expect(await readFile(target, 'utf8')).toBe(contents);
    },
  );
});