import {
  mkdtemp,
  open,
  rm,
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
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    open: vi.fn(actual.open),
  };
});

const SECRET = 'journal-read-error-canary';

const IDENTITY = {
  chainId: 4663,
  signer: '0x1111111111111111111111111111111111111111' as const,
};

describe('journal load error boundaries', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    const actual = await vi.importActual<
      typeof import('node:fs/promises')
    >('node:fs/promises');

    vi.mocked(open).mockReset();
    vi.mocked(open).mockImplementation(actual.open);

    directory = await mkdtemp(join(tmpdir(), 'journal-errors-'));
    filePath = join(directory, 'journal.json');
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  async function failure(): Promise<Error> {
    try {
      await FileTransactionJournalStore.open({
        filePath,
        identity: IDENTITY,
      });
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }

      throw new Error('Expected an Error.');
    }

    throw new Error('Expected opening the store to fail.');
  }

  it.each(['EACCES', 'EIO'])(
    'preserves safe filesystem code %s without retaining raw context',
    async (code) => {
      const original = Object.assign(new Error(SECRET), {
        code,
        path: SECRET,
        syscall: SECRET,
        cause: new Error(SECRET),
      });

      vi.mocked(open).mockRejectedValueOnce(original);

      const error = await failure();

      expect(error.message)
        .toBe('Transaction journal could not be loaded.');

      expect(error.cause).toBeInstanceOf(Error);
      expect(error.cause).not.toBe(original);
      expect(error.cause).toMatchObject({
        message: `Journal file open failed (${code}).`,
        code,
      });

      expect(error.cause).not.toHaveProperty('path');
      expect(error.cause).not.toHaveProperty('syscall');
      expect(error.cause).not.toHaveProperty('cause');

      expect(String(error.cause)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    },
  );

  it('does not copy an unrecognized error code', async () => {
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error(SECRET), {
        code: SECRET,
      }),
    );

    const error = await failure();

    expect(error.cause).toHaveProperty(
      'message',
      'Journal file open failed.',
    );

    expect(error.cause).not.toHaveProperty('code');
    expect(String(error.cause)).not.toContain(SECRET);
  });

  it('does not invoke an error code accessor', async () => {
    const get = vi.fn(() => SECRET);
    const original = new Error(SECRET);

    Object.defineProperty(original, 'code', { get });
    vi.mocked(open).mockRejectedValueOnce(original);

    const error = await failure();

    expect(get).not.toHaveBeenCalled();
    expect(error.cause).not.toHaveProperty('code');
    expect(String(error.cause)).not.toContain(SECRET);
  });

  it('retains the sanitized serialization error without parser input', async () => {
    await writeFile(filePath, `{"attempt":"${SECRET}`);

    const error = await failure();

    expect(error.message)
      .toBe('Transaction journal could not be decoded.');

    expect(error.cause).toHaveProperty(
      'message',
      'Invalid transaction journal encoding.',
    );

    expect(error.cause).not.toHaveProperty('cause');
    expect(String(error.cause)).not.toContain(SECRET);
  });
});