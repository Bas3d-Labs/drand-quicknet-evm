import {
  mkdtemp,
  readFile,
  rename,
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
  durableReplace,
} from '../../src/state/durable-replace.js';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  encodeJournalSnapshot,
  MAX_JOURNAL_BYTES,
} from '../../src/state/transaction-journal-serialization.js';

vi.mock('../../src/state/durable-replace.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/durable-replace.js')
  >();

  return {
    ...actual,
    durableReplace: vi.fn(actual.durableReplace),
  };
});

const IDENTITY = {
  chainId: 4663,
  signer: '0x1111111111111111111111111111111111111111' as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

function fixture(): TransactionJournalSnapshot {
  const observation = {
    anchor: {
      blockNumber: 100n,
      blockHash: HASH,
    },
    nonce: 4n,
  };

  return {
    version: 1,
    identity: { ...IDENTITY },
    baseline: observation,
    lastObservation: observation,
    nextNonce: 4n,
    attempt: null,
  };
}

describe('file transaction journal store', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'relayer-journal-'));
    filePath = join(directory, 'journal.json');

    const actual = await vi.importActual<
      typeof import('../../src/state/durable-replace.js')
    >('../../src/state/durable-replace.js');

    vi.mocked(durableReplace).mockReset();
    vi.mocked(durableReplace).mockImplementation(actual.durableReplace);
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  function openStore() {
    return FileTransactionJournalStore.open({
      filePath,
      identity: IDENTITY,
    });
  }

  it('leaves a missing journal missing', async () => {
    const store = await openStore();

    expect(await store.load()).toEqual({
      kind: 'missing',
    });

    expect(durableReplace).not.toHaveBeenCalled();
    await expect(readFile(filePath)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('saves and reloads a verified snapshot', async () => {
    const store = await openStore();
    const snapshot = fixture();

    await store.save(snapshot);

    expect(await store.load()).toEqual({
      kind: 'present',
      snapshot,
    });

    expect(durableReplace).toHaveBeenCalledTimes(1);
  });

  it('durably rewrites existing state during open', async () => {
    const snapshot = fixture();

    await writeFile(
      filePath,
      await encodeJournalSnapshot(snapshot, IDENTITY),
    );

    const store = await openStore();

    expect(durableReplace).toHaveBeenCalledTimes(1);
    expect(await store.load()).toEqual({
      kind: 'present',
      snapshot,
    });
  });

  it('rejects corrupt state without overwriting it', async () => {
    const contents = '{"broken":';
    await writeFile(filePath, contents);

    await expect(openStore())
      .rejects.toThrow('Transaction journal could not be decoded.');

    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(durableReplace).not.toHaveBeenCalled();
  });

  it('rejects a journal belonging to another chain', async () => {
    const snapshot = fixture();
    const otherIdentity = {
      ...IDENTITY,
      chainId: 1,
    };

    await writeFile(filePath, await encodeJournalSnapshot({
      ...snapshot,
      identity: otherIdentity,
    }, otherIdentity));

    await expect(openStore())
      .rejects.toThrow('Transaction journal could not be decoded.');

    expect(durableReplace).not.toHaveBeenCalled();
  });

  it('rejects oversized files before decoding', async () => {
    await writeFile(filePath, Buffer.alloc(MAX_JOURNAL_BYTES + 1, 32));

    await expect(openStore())
      .rejects.toThrow('Transaction journal could not be loaded.');

    expect(durableReplace).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8', async () => {
    await writeFile(filePath, Buffer.from([0xff, 0xfe]));

    await expect(openStore())
      .rejects.toThrow('Transaction journal could not be loaded.');
  });

  it('removes only matching orphaned temporary files', async () => {
    const orphan =
      `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;
    const unrelated = join(directory, 'unrelated.tmp');

    await writeFile(orphan, 'orphan');
    await writeFile(unrelated, 'keep');

    await openStore();

    await expect(readFile(orphan))
      .rejects.toHaveProperty('code', 'ENOENT');

    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  });

  it('performs a fresh replacement for repeated identical saves', async () => {
    const store = await openStore();
    const snapshot = fixture();

    await store.save(snapshot);
    await store.save(snapshot);

    expect(durableReplace).toHaveBeenCalledTimes(2);
  });

  it('allows a fresh save after replacement occurs but the write rejects', async () => {
    const store = await openStore();
    const snapshot = fixture();

    vi.mocked(durableReplace).mockImplementationOnce(
      async (destination, contents) => {
        const temporary = `${destination}.injected`;

        await writeFile(temporary, contents);
        await rename(temporary, destination);

        // Simulate failure after replacement, without confirmation
        // of file and directory durability.
        throw new Error('Injected synchronization failure.');
      },
    );

    await expect(store.save(snapshot))
      .rejects.toThrow('Journal persistence did not complete.');

    // Visibility is possible after failure. It is not confirmation
    // that the rejected save completed durably.
    expect(await store.load()).toEqual({
      kind: 'present',
      snapshot,
    });

    await store.save(snapshot);

    expect(durableReplace).toHaveBeenCalledTimes(2);
  });

  it('captures a snapshot before a queued save can be mutated', async () => {
    const store = await openStore();

    const snapshot = {
      ...fixture(),
      nextNonce: 4n,
    };

    const pending = store.save(snapshot);
    snapshot.nextNonce = 99n;

    await pending;

    const loaded = await store.load();

    expect(loaded.kind).toBe('present');

    if (loaded.kind !== 'present') {
      throw new Error('Expected persisted journal.');
    }

    expect(loaded.snapshot.nextNonce).toBe(4n);
  });
});