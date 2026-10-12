import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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

import {
  readJournalStatus,
} from '../../src/cli/read-journal-status.js';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from '../../src/state/service-lock.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

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

const HASH = `0x${'aa'.repeat(32)}` as const;

describe('readJournalStatus', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'relayer-journal-status-'),
    );

    filePath = join(
      directory,
      `transaction-journal-${IDENTITY.chainId}-${IDENTITY.signer}.json`,
    );

    await writeFile(join(directory, 'relayer.flock'), '');

    vi.mocked(assertServiceLockHeld)
      .mockReset()
      .mockReturnValue({
        stateDirectory: directory,
        dev: 1n,
        ino: 2n,
      });
  });

  afterEach(async () => {
    vi.restoreAllMocks();

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

  async function seedJournal(): Promise<string> {
    const observation = {
      anchor: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      nonce: 4n,
    };

    const snapshot: TransactionJournalSnapshot = {
      version: 1,
      identity: IDENTITY,
      baseline: observation,
      lastObservation: observation,
      nextNonce: 4n,
      durableNextNonce: 4n,
      repairs: [],
      attempts: [],
    };

    const contents = await encodeJournalSnapshot(snapshot, IDENTITY);
    await writeFile(filePath, contents);
    return contents;
  }

  async function fileIdentity(path: string) {
    const info = await stat(path, { bigint: true });

    // Reads may update atime; that is not a journal rewrite.
    return {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    };
  }

  it('reports a missing journal without initializing or cleaning state', async () => {
    const temporary =
      `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;

    await writeFile(temporary, 'retained recovery evidence');

    const entriesBefore = (await readdir(directory)).sort();

    expect(await readJournalStatus(options())).toEqual({
      source: 'journal',
      journal: 'missing',
      gate: 'unknown',
    });

    expect((await readdir(directory)).sort()).toEqual(entriesBefore);
    expect(await readFile(temporary, 'utf8'))
      .toBe('retained recovery evidence');
  });

  it('preserves journal and temporary files while reading status', async () => {
    const contents = await seedJournal();
    const temporary =
      `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;

    await writeFile(temporary, 'retained recovery evidence');

    const entriesBefore = (await readdir(directory)).sort();
    const journalBefore = await fileIdentity(filePath);
    const temporaryBefore = await fileIdentity(temporary);

    expect(await readJournalStatus(options())).toMatchObject({
      source: 'journal',
      journal: 'present',
      gate: 'unknown',
      identity: IDENTITY,
      nextNonce: '4',
      durableNextNonce: '4',
      repairs: [],
      attempts: [],
    });

    expect((await readdir(directory)).sort()).toEqual(entriesBefore);
    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(await readFile(temporary, 'utf8'))
      .toBe('retained recovery evidence');

    expect(await fileIdentity(filePath)).toEqual(journalBefore);
    expect(await fileIdentity(temporary)).toEqual(temporaryBefore);
  });

  it('uses the canonical journal filename for an uppercase signer', async () => {
    await seedJournal();

    const input = options();
    input.identity.signer = `0x${'AB'.repeat(20)}`;

    expect(await readJournalStatus(input)).toMatchObject({
      journal: 'present',
      nextNonce: '4',
    });
  });

  it('refuses to read without verified ownership', async () => {
    const read = vi.spyOn(FileTransactionJournalStore, 'read');
    const failure = new ServiceLockNotHeldError('descriptor');

    vi.mocked(assertServiceLockHeld).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(readJournalStatus(options())).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects corrupt state without replacing it', async () => {
    await writeFile(filePath, 'invalid JSON');
    const before = await fileIdentity(filePath);

    await expect(readJournalStatus(options()))
      .rejects.toThrow('Transaction journal could not be decoded.');

    expect(await readFile(filePath, 'utf8')).toBe('invalid JSON');
    expect(await fileIdentity(filePath)).toEqual(before);
  });

  it('rejects an ownership change during the read', async () => {
    await seedJournal();

    vi.mocked(assertServiceLockHeld)
      .mockReturnValueOnce({
        stateDirectory: directory,
        dev: 1n,
        ino: 2n,
      })
      .mockReturnValueOnce({
        stateDirectory: directory,
        dev: 1n,
        ino: 3n,
      });

    await expect(readJournalStatus(options()))
      .rejects.toBeInstanceOf(ServiceLockNotHeldError);
  });

  it('honors cancellation before reading state', async () => {
    const read = vi.spyOn(FileTransactionJournalStore, 'read');
    const controller = new AbortController();
    const reason = new Error('Cancelled');

    controller.abort(reason);

    await expect(readJournalStatus({
      ...options(),
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(assertServiceLockHeld).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});