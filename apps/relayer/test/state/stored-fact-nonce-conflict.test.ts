import {
  mkdtemp,
  readFile,
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
  describe,
  expect,
  it,
} from 'vitest';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import {
  findStoredFactNonceConflict,
} from '../../src/state/stored-fact-nonce-conflict.js';

import type {
  SearchFactKind,
} from '../../src/state/stored-fact-nonce-conflict.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

import {
  validateJournalSnapshotStructure,
} from '../../src/state/transaction-journal-validation.js';

import {
  FACT_IDENTITY,
  factObservation,
  searchFactFixture,
} from '../helpers/search-fact-fixture.js';

const PAIRS: readonly (readonly [SearchFactKind, SearchFactKind])[] = [
  ['lowerBound', 'lowerBound'],
  ['exhausted', 'exhausted'],
  ['lowerBound', 'exhausted'],
  ['exhausted', 'lowerBound'],
];

async function paired(first: SearchFactKind, second: SearchFactKind, equal: boolean) {
  const snapshot = await searchFactFixture();

  // Each mixed conflicting pair satisfies each attempt's separate nonce bounds.

  const firstNonce = first === 'lowerBound' ? 4n : 6n;

  let secondNonce = second === 'lowerBound' ? 5n : 7n;

  if (equal) {
    secondNonce = firstNonce;
  }

  const attempts = snapshot.attempts.map((attempt, index) => {
    const kind = index === 0 ? first : second;

    const nonce = index === 0 ? firstNonce : secondNonce;

    return {
      ...attempt,
      replacementSearch: {
        lowerBound: factObservation(90n, 4n),
        searchedThrough: null,
        exhausted: null,
        [kind]: factObservation(100n, nonce),
      },
    };
  });

  return { ...snapshot, attempts };
}

function wire(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

describe('cross-attempt search facts', () => {
  it.each(PAIRS)('rejects contradictory %s / %s without mutating input', async (first, second) => {
    const input = await paired(first, second, false);

    const before = structuredClone(input);

    // Remove the peer from comparison without changing either fact's local shape.
    for (const index of [0, 1]) {
      const isolated = {
        ...input,
        attempts: input.attempts.map((attempt, peer) => ({
          ...attempt,
          replacementSearch: peer === index ? attempt.replacementSearch : null,
        })),
      };

      expect(() => validateJournalSnapshotStructure(isolated, FACT_IDENTITY)).not.toThrow();
    }

    expect(() => validateJournalSnapshotStructure(input, FACT_IDENTITY)).toThrow();
    await expect(encodeJournalSnapshot(input, FACT_IDENTITY)).rejects.toThrow();
    await expect(decodeJournalSnapshot(wire(input), FACT_IDENTITY)).rejects.toThrow();
    expect(input).toEqual(before);
  });

  it.each(['lowerBound', 'exhausted'] as const)(
    'accepts equal %s facts and preserves canonical bytes',
    async (kind) => {
      const input = await paired(kind, kind, true);

      const encoded = await encodeJournalSnapshot(input, FACT_IDENTITY);

      const decoded = await decodeJournalSnapshot(encoded, FACT_IDENTITY);

      expect(await encodeJournalSnapshot(decoded, FACT_IDENTITY)).toBe(encoded);
      expect(findStoredFactNonceConflict(decoded.attempts)).toBeNull();
    },
  );

  it('accepts an individually valid equal mixed pair', async () => {
    const input = await searchFactFixture();

    const attempts = input.attempts.map((attempt, index) => ({
      ...attempt,
      replacementSearch: {
        lowerBound: factObservation(index === 0 ? 90n : 100n, index === 0 ? 4n : 5n),
        searchedThrough: null,
        exhausted: index === 0 ? factObservation(100n, 5n) : null,
      },
    }));

    await expect(encodeJournalSnapshot({ ...input, attempts }, FACT_IDENTITY)).resolves.toBeTypeOf(
      'string',
    );
  });

  it.each([true, false])('compares uppercase hash facts; equal nonce: %s', async (equal) => {
    const input = await paired('lowerBound', 'lowerBound', equal);

    const search = input.attempts[1]!.replacementSearch;

    search.lowerBound.anchor.blockHash =
      `0x${search.lowerBound.anchor.blockHash.slice(2).toUpperCase()}`;

    if (equal) {
      expect(() => validateJournalSnapshotStructure(input, FACT_IDENTITY)).not.toThrow();
    } else {
      expect(() => validateJournalSnapshotStructure(input, FACT_IDENTITY)).toThrow();
    }
  });

  it.each(['height', 'hash'] as const)('does not conflate a different %s', async (field) => {
    const input = await paired('lowerBound', 'lowerBound', false);

    const anchor = input.attempts[1]!.replacementSearch.lowerBound.anchor;

    if (field === 'height') {
      anchor.blockNumber = 101n;
    } else {
      anchor.blockHash = `0x${'cd'.repeat(32)}`;
    }

    expect(() => validateJournalSnapshotStructure(input, FACT_IDENTITY)).not.toThrow();
  });

  it('refuses a contradictory file without replacing its bytes', async () => {
    const input = await paired('exhausted', 'exhausted', false);

    const directory = await mkdtemp(join(tmpdir(), 'fact-conflict-'));

    const filePath = join(directory, 'journal.json');

    const contents = wire(input);

    try {
      await writeFile(filePath, contents, { mode: 0o600 });

      await expect(FileTransactionJournalStore.read({
        filePath,
        identity: FACT_IDENTITY,
      })).rejects.toThrow();

      expect(await readFile(filePath, 'utf8')).toBe(contents);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
