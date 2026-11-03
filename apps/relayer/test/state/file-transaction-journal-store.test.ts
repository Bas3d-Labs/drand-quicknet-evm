import {
  link,
  mkdtemp,
  readdir,
  readFile,
  rename,
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
  keccak256,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

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

import {
  DEFAULT_JOURNAL_BOUNDS,
  MAX_RETAINED_ATTEMPTS,
  MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
} from '../../src/state/journal-bounds.js';

import {
  JournalBoundsExceededError,
} from '../../src/state/journal-bounds-error.js';

import type {
  JournalAttempt,
  JournalSignedTransaction,
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
    durableNextNonce: 4n,
    repairs: [],
    attempts: [],
  };
}

async function signedBoundsFixture(
  transactionCounts: readonly number[],
): Promise<TransactionJournalSnapshot> {
  // Public test fixture only.
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const base = fixture();
  const identity = {
    chainId: base.identity.chainId,
    signer: account.address,
  };

  const attempts: JournalAttempt[] = [];

  for (const [index, count] of transactionCounts.entries()) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('Fixture requires a positive transaction count.');
    }

    const nonce = base.durableNextNonce + BigInt(index);

    async function sign(
      replacementIndex: number,
    ): Promise<JournalSignedTransaction> {
      const signedTransaction = await account.signTransaction({
        type: 'eip1559',
        chainId: identity.chainId,
        nonce: Number(nonce),
        gas: 21_000n,
        to: account.address,
        value: 0n,
        maxFeePerGas: 2n + BigInt(replacementIndex),
        maxPriorityFeePerGas: 1n,
      });

      return {
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      };
    }

    const first = await sign(0);
    const remaining: JournalSignedTransaction[] = [];

    for (let replacementIndex = 1; replacementIndex < count; replacementIndex += 1) {
      remaining.push(await sign(replacementIndex));
    }

    attempts.push({
      attemptId:
        '00000000-0000-4000-8000-'
        + (index + 1).toString(16).padStart(12, '0'),
      workId: 'bounds-test:' + index,
      nonce,
      createdAt: '2026-10-21T00:00:00.000Z',
      signedTransactions: [first, ...remaining],
      replacementSearch: null,
      phase: 'signed',
      inclusion: null,
    });
  }

  return {
    ...base,
    identity,
    nextNonce: base.durableNextNonce + BigInt(attempts.length),
    attempts,
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

  it('preserves the retained queue and signed transactions across reopen', async () => {
    // Public test fixture only.
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

    const identity = {
      chainId: IDENTITY.chainId,
      signer: account.address,
    };

    async function sign(nonce: number, maxFeePerGas = 2n) {
      const signedTransaction = await account.signTransaction({
        type: 'eip1559',
        chainId: identity.chainId,
        nonce,
        gas: 21_000n,
        to: account.address,
        value: 0n,
        maxFeePerGas,
        maxPriorityFeePerGas: 1n,
      });

      return {
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      };
    }

    const original = await sign(4);
    const replacement = await sign(4, 4n);
    const next = await sign(5);

    const observedAt = {
      blockNumber: 120n,
      blockHash: HASH,
    };

    const snapshot: TransactionJournalSnapshot = {
      ...fixture(),
      identity,
      nextNonce: 6n,
      durableNextNonce: 4n,
      lastObservation: {
        anchor: observedAt,
        nonce: 5n,
      },
      attempts: [
        {
          attemptId: '11111111-1111-4111-8111-111111111111',
          workId: 'test-work:4',
          nonce: 4n,
          createdAt: '2026-10-04T00:00:00.000Z',
          signedTransactions: [original, replacement],
          replacementSearch: null,
          phase: 'included',
          inclusion: {
            outcome: 'success',
            transactionHash: replacement.transactionHash,
            inclusion: {
              blockNumber: 110n,
              blockHash: HASH,
            },
            observedAt,
          },
        },
        {
          attemptId: '22222222-2222-4222-8222-222222222222',
          workId: 'test-work:5',
          nonce: 5n,
          createdAt: '2026-10-04T00:01:00.000Z',
          signedTransactions: [next],
          replacementSearch: null,
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
        },
      ],
    };

    const store = await FileTransactionJournalStore.open({
      filePath,
      identity,
    });

    await store.save(snapshot);

    const reopened = await FileTransactionJournalStore.open({
      filePath,
      identity,
    });

    expect(await reopened.load()).toEqual({
      kind: 'present',
      snapshot,
    });
  });

  it('rejects a hard-linked journal without rewriting either path', async () => {
    const contents = await encodeJournalSnapshot(fixture(), IDENTITY);
    const alias = join(directory, 'journal-alias.json');

    await writeFile(filePath, contents);
    await link(filePath, alias);

    await expect(openStore()).rejects.toMatchObject({
      message: 'Transaction journal could not be loaded.',
      cause: {
        message: 'Journal file must have exactly one hard link.',
      },
    });

    expect(durableReplace).not.toHaveBeenCalled();
    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(await readFile(alias, 'utf8')).toBe(contents);
  });

  it('rejects a symlink journal without rewriting its target', async () => {
    const contents = await encodeJournalSnapshot(fixture(), IDENTITY);
    const target = join(directory, 'journal-target.json');

    await writeFile(target, contents);
    await symlink(target, filePath);

    await expect(openStore()).rejects.toMatchObject({
      message: 'Transaction journal could not be loaded.',
      cause: {
        code: 'ELOOP',
      },
    });

    expect(durableReplace).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe(contents);
  });

  it.each(['missing', 'present'] as const)(
    'reads a %s journal without cleanup or replacement',
    async (kind) => {
      const snapshot = fixture();
      const contents = await encodeJournalSnapshot(snapshot, IDENTITY);

      const orphan =
        `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;
      const unrelated = join(directory, 'unrelated.tmp');

      await writeFile(orphan, 'retained recovery evidence');
      await writeFile(unrelated, 'keep');

      if (kind === 'present') {
        await writeFile(filePath, contents);
      }

      const entriesBefore = (await readdir(directory)).sort();
      const identityBefore = kind === 'present'
        ? await stat(filePath, { bigint: true })
        : undefined;

      const result = await FileTransactionJournalStore.read({
        filePath,
        identity: IDENTITY,
      });

      expect(result).toEqual(
        kind === 'present'
          ? { kind: 'present', snapshot }
          : { kind: 'missing' },
      );

      expect(durableReplace).not.toHaveBeenCalled();

      expect((await readdir(directory)).sort()).toEqual(entriesBefore);
      expect(await readFile(orphan, 'utf8'))
        .toBe('retained recovery evidence');
      expect(await readFile(unrelated, 'utf8')).toBe('keep');

      if (identityBefore !== undefined) {
        expect(await readFile(filePath, 'utf8')).toBe(contents);

        const identityAfter = await stat(filePath, { bigint: true });

        expect(identityAfter.dev).toBe(identityBefore.dev);
        expect(identityAfter.ino).toBe(identityBefore.ino);
        expect(identityAfter.mtimeNs).toBe(identityBefore.mtimeNs);
      } else {
        await expect(readFile(filePath))
          .rejects.toHaveProperty('code', 'ENOENT');
      }
    },
  );

  it('rejects corrupt state through read without altering evidence', async () => {
    const contents = '{"broken":';
    const orphan =
      `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;

    await writeFile(filePath, contents);
    await writeFile(orphan, 'retain');

    await expect(FileTransactionJournalStore.read({
      filePath,
      identity: IDENTITY,
    })).rejects.toThrow('Transaction journal could not be decoded.');

    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(await readFile(orphan, 'utf8')).toBe('retain');
    expect(durableReplace).not.toHaveBeenCalled();
  });

  it('checks expected identity through the read-only entry point', async () => {
    const contents = await encodeJournalSnapshot(fixture(), IDENTITY);

    await writeFile(filePath, contents);

    await expect(FileTransactionJournalStore.read({
      filePath,
      identity: {
        ...IDENTITY,
        chainId: 1,
      },
    })).rejects.toThrow('Transaction journal could not be decoded.');

    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(durableReplace).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'retained attempts',
      counts: Array.from(
        { length: MAX_RETAINED_ATTEMPTS + 1 },
        () => 1,
      ),
      bound: 'retained-attempts',
      maximum: MAX_RETAINED_ATTEMPTS,
      observed: MAX_RETAINED_ATTEMPTS + 1,
    },
    {
      name: 'signed transactions',
      counts: [MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1],
      bound: 'signed-transactions-per-attempt',
      maximum: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      observed: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1,
    },
  ])(
    'rejects over-bound $name before cleanup or rewriting, while inspection remains available',
    async (testCase) => {
      const snapshot = await signedBoundsFixture(testCase.counts);
      const contents = await encodeJournalSnapshot(
        snapshot,
        snapshot.identity,
      );

      const orphan =
        `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;

      await writeFile(filePath, contents);
      await writeFile(orphan, 'retained recovery evidence');

      const entriesBefore = (await readdir(directory)).sort();
      const statBefore = await stat(filePath, { bigint: true });

      const opening = FileTransactionJournalStore.open({
        filePath,
        identity: snapshot.identity,
        bounds: {
          maxRetainedAttempts: MAX_RETAINED_ATTEMPTS,
          maxSignedTransactionsPerAttempt:
            MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
        },
      });

      await expect(opening).rejects.toBeInstanceOf(
        JournalBoundsExceededError,
      );

      await expect(opening).rejects.toMatchObject({
        violations: [
          {
            bound: testCase.bound,
            maximum: testCase.maximum,
            observed: testCase.observed,
          },
        ],
      });

      expect(durableReplace).not.toHaveBeenCalled();
      expect(await readFile(filePath, 'utf8')).toBe(contents);
      expect(await readFile(orphan, 'utf8'))
        .toBe('retained recovery evidence');
      expect((await readdir(directory)).sort()).toEqual(entriesBefore);

      const statAfter = await stat(filePath, { bigint: true });

      expect(statAfter.dev).toBe(statBefore.dev);
      expect(statAfter.ino).toBe(statBefore.ino);
      expect(statAfter.mtimeNs).toBe(statBefore.mtimeNs);

      // Inspection retains full structural and cryptographic validation,
      // but does not apply command-runtime capacity limits.
      const inspected = await FileTransactionJournalStore.read({
        filePath,
        identity: snapshot.identity,
      });

      expect(inspected).toEqual({
        kind: 'present',
        snapshot,
      });

      expect(durableReplace).not.toHaveBeenCalled();
      expect(await readFile(filePath, 'utf8')).toBe(contents);
      expect(await readFile(orphan, 'utf8'))
        .toBe('retained recovery evidence');
      expect((await readdir(directory)).sort()).toEqual(entriesBefore);
    },
  );

  it('opens and reloads a journal exactly at both supported bounds', async () => {
    const snapshot = await signedBoundsFixture(
      Array.from(
        { length: MAX_RETAINED_ATTEMPTS },
        () => MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      ),
    );

    await writeFile(
      filePath,
      await encodeJournalSnapshot(snapshot, snapshot.identity),
    );

    const store = await FileTransactionJournalStore.open({
      filePath,
      identity: snapshot.identity,
      bounds: {
        maxRetainedAttempts: MAX_RETAINED_ATTEMPTS,
        maxSignedTransactionsPerAttempt:
          MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      },
    });

    expect(durableReplace).toHaveBeenCalledTimes(1);
    expect(await store.load()).toEqual({
      kind: 'present',
      snapshot,
    });
  });

  it('captures bounds and enforces them on subsequent loads', async () => {
    const snapshot = await signedBoundsFixture([2]);
    const bounds = {
      maxRetainedAttempts: DEFAULT_JOURNAL_BOUNDS.maxRetainedAttempts,
      maxSignedTransactionsPerAttempt: 1,
    };

    const store = await FileTransactionJournalStore.open({
      filePath,
      identity: snapshot.identity,
      bounds,
    });

    expect(await store.load()).toEqual({ kind: 'missing' });

    bounds.maxSignedTransactionsPerAttempt =
      MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT;

    const contents = await encodeJournalSnapshot(
      snapshot,
      snapshot.identity,
    );

    // Simulate changed disk content to exercise this store's load policy.
    await writeFile(filePath, contents);

    await expect(store.load()).rejects.toMatchObject({
      name: 'JournalBoundsExceededError',
      violations: [
        {
          bound: 'signed-transactions-per-attempt',
          maximum: 1,
          observed: 2,
          attemptId: snapshot.attempts[0]!.attemptId,
        },
      ],
    });

    expect(durableReplace).not.toHaveBeenCalled();
    expect(await readFile(filePath, 'utf8')).toBe(contents);
  });
});