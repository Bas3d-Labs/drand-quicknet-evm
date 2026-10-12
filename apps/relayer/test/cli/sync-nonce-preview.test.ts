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

import type {
  PublicClient,
} from 'viem';

vi.mock('../../src/chain/inspect-nonce-sync.js', () => ({
  inspectNonceSync: vi.fn(),
}));

vi.mock('../../src/state/service-lock.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/service-lock.js')
  >();

  return {
    ...actual,
    assertServiceLockHeld: vi.fn(),
  };
});

import {
  inspectNonceSync,
} from '../../src/chain/inspect-nonce-sync.js';

import {
  syncNonce,
} from '../../src/cli/sync-nonce.js';

import {
  assertServiceLockHeld,
} from '../../src/state/service-lock.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'11'.repeat(20)}` as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

function observation(blockNumber: bigint, nonce: bigint) {
  return {
    anchor: {
      blockNumber,
      blockHash: HASH,
    },
    nonce,
  };
}

describe('nonce sync preview filesystem behavior', () => {
  let directory: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, {
        recursive: true,
        force: true,
      });

      directory = undefined;
    }
  });

  it('preserves the journal and matching temporary recovery evidence', async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'relayer-nonce-sync-preview-'),
    );

    const filePath = join(
      directory,
      `transaction-journal-${IDENTITY.chainId}-${IDENTITY.signer}.json`,
    );

    const temporary =
      `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;

    const snapshot: TransactionJournalSnapshot = {
      version: 1,
      identity: IDENTITY,
      baseline: observation(90n, 4n),
      lastObservation: observation(100n, 8n),
      nextNonce: 4n,
      durableNextNonce: 4n,
      repairs: [],
      attempts: [],
    };

    const contents = await encodeJournalSnapshot(snapshot, IDENTITY);
    const temporaryContents = 'retained recovery evidence';

    await writeFile(filePath, contents);
    await writeFile(temporary, temporaryContents);

    const entriesBefore = (await readdir(directory)).sort();
    const journalBefore = await stat(filePath, { bigint: true });
    const temporaryBefore = await stat(temporary, { bigint: true });

    vi.mocked(assertServiceLockHeld).mockReturnValue({
      stateDirectory: directory,
      dev: 1n,
      ino: 2n,
    });

    const freshObservation = observation(110n, 8n);

    vi.mocked(inspectNonceSync).mockResolvedValue({
      status: 'observed',
      observation: freshObservation,
      latestNonce: 8n,
      pendingNonce: 8n,
    });

    const result = await syncNonce({
      publicClient: {} as PublicClient,
      identity: IDENTITY,
      finality: { type: 'safe' },
      apply: false,
      env: {
        QUICKNET_STATE_DIR: directory,
      },
      now: () => new Date('2026-10-12T12:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'repair-available',
      repair: {
        kind: 'sync-nonce',
        previousNextNonce: 4n,
        nextNonce: 8n,
        observation: freshObservation,
      },
    });

    expect(inspectNonceSync).toHaveBeenCalledOnce();

    expect((await readdir(directory)).sort()).toEqual(entriesBefore);
    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(await readFile(temporary, 'utf8')).toBe(temporaryContents);

    const journalAfter = await stat(filePath, { bigint: true });
    const temporaryAfter = await stat(temporary, { bigint: true });

    expect(journalAfter.dev).toBe(journalBefore.dev);
    expect(journalAfter.ino).toBe(journalBefore.ino);
    expect(journalAfter.mtimeNs).toBe(journalBefore.mtimeNs);
    expect(journalAfter.ctimeNs).toBe(journalBefore.ctimeNs);

    expect(temporaryAfter.dev).toBe(temporaryBefore.dev);
    expect(temporaryAfter.ino).toBe(temporaryBefore.ino);
    expect(temporaryAfter.mtimeNs).toBe(temporaryBefore.mtimeNs);
    expect(temporaryAfter.ctimeNs).toBe(temporaryBefore.ctimeNs);
  });
});