import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  Hash,
} from 'viem';

import {
  DEFAULT_JOURNAL_BOUNDS,
  DEFAULT_MAX_RETAINED_ATTEMPTS,
  MAX_RETAINED_ATTEMPTS,
  MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
  inspectJournalBounds,
} from '../../src/state/journal-bounds.js';

import {
  JournalBoundsExceededError,
} from '../../src/state/journal-bounds-error.js';

import type {
  JournalAttempt,
  JournalIdentity,
  JournalSignedTransaction,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from '../../src/state/transaction-journal-validation.js';

const IDENTITY: JournalIdentity = {
  chainId: 4663,
  signer: '0x1111111111111111111111111111111111111111',
};

function hash(value: number): Hash {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function snapshot(
  transactionCounts: readonly number[],
  included = false,
): TransactionJournalSnapshot {
  let transactionNumber = 1;

  function transaction(): JournalSignedTransaction {
    const transactionHash = hash(transactionNumber);
    transactionNumber += 1;

    // Structural fixture only; cryptographic verification is separate.
    return {
      transactionHash,
      signedTransaction: transactionHash,
    };
  }

  const anchor = {
    blockNumber: 100n,
    blockHash: hash(100_000),
  };

  const attempts = transactionCounts.map(
    (count, index): JournalAttempt => {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Fixture requires a positive transaction count.');
      }

      const first = transaction();
      const remaining = Array.from(
        { length: count - 1 },
        () => transaction(),
      );

      const signedTransactions: JournalAttempt['signedTransactions'] = [
        first,
        ...remaining,
      ];

      const common = {
        attemptId:
          '00000000-0000-4000-8000-'
          + (index + 1).toString(16).padStart(12, '0'),
        workId: 'bounds-test:' + index,
        nonce: BigInt(index),
        createdAt: '2026-10-21T00:00:00.000Z',
        signedTransactions,
        replacementSearch: null,
      };

      if (included) {
        return {
          ...common,
          phase: 'included',
          inclusion: {
            inclusion: anchor,
            observedAt: anchor,
            outcome: 'success',
            transactionHash: first.transactionHash,
          },
        };
      }

      return {
        ...common,
        phase: 'signed',
        inclusion: null,
      };
    },
  );

  const validated = validateJournalSnapshotStructure({
    version: 1,
    identity: IDENTITY,
    baseline: { anchor, nonce: 0n },
    lastObservation: { anchor, nonce: 0n },
    nextNonce: BigInt(attempts.length),
    durableNextNonce: 0n,
    repairs: [],
    attempts,
  }, IDENTITY);

  // Keep fixture inputs mutable so tests detect accidental freezing.
  return structuredClone(validated);
}

describe('journal bounds', () => {
  it('keeps defaults within the supported maxima', () => {
    expect(DEFAULT_JOURNAL_BOUNDS).toEqual({
      maxRetainedAttempts: DEFAULT_MAX_RETAINED_ATTEMPTS,
      maxSignedTransactionsPerAttempt:
        MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
    });

    expect(DEFAULT_MAX_RETAINED_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_MAX_RETAINED_ATTEMPTS)
      .toBeLessThanOrEqual(MAX_RETAINED_ATTEMPTS);

    expect(Object.isFrozen(DEFAULT_JOURNAL_BOUNDS)).toBe(true);
  });

  it('accepts an empty journal and freezes the empty result', () => {
    const result = inspectJournalBounds(snapshot([]));

    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts exactly the supported attempt and transaction limits', () => {
    const current = snapshot(
      Array.from(
        { length: MAX_RETAINED_ATTEMPTS },
        () => MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      ),
    );

    expect(inspectJournalBounds(current, {
      maxRetainedAttempts: MAX_RETAINED_ATTEMPTS,
      maxSignedTransactionsPerAttempt:
        MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
    })).toEqual([]);
  });

  it('reports one attempt above the retained-attempt limit', () => {
    const observed = MAX_RETAINED_ATTEMPTS + 1;
    const current = snapshot(
      Array.from({ length: observed }, () => 1),
    );

    const result = inspectJournalBounds(current);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bound: 'retained-attempts',
      maximum: MAX_RETAINED_ATTEMPTS,
      observed,
      attemptId: null,
    });

    expect(result[0]!.message).toBe(
      'Journal retained-attempt count exceeds its limit: observed '
      + observed
      + ', maximum '
      + MAX_RETAINED_ATTEMPTS
      + '.',
    );
  });

  it('reports one transaction above the per-attempt limit', () => {
    const observed = MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1;
    const current = snapshot([observed]);
    const attemptId = current.attempts[0]!.attemptId;

    const result = inspectJournalBounds(current);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bound: 'signed-transactions-per-attempt',
      maximum: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      observed,
      attemptId,
    });

    expect(result[0]!.message).toBe(
      'Journal signed-transaction count exceeds its per-attempt limit: '
      + 'attempt '
      + attemptId
      + ', observed '
      + observed
      + ', maximum '
      + MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT
      + '.',
    );
  });

  it('reports the attempt bound first, then transaction bounds in snapshot order', () => {
    const counts = Array.from(
      { length: MAX_RETAINED_ATTEMPTS + 1 },
      (_, index) => MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + index + 1,
    );

    const current = snapshot(counts);
    const result = inspectJournalBounds(current);

    expect(result.map((violation) => ({
      bound: violation.bound,
      maximum: violation.maximum,
      observed: violation.observed,
      attemptId: violation.attemptId,
    }))).toEqual([
      {
        bound: 'retained-attempts',
        maximum: MAX_RETAINED_ATTEMPTS,
        observed: counts.length,
        attemptId: null,
      },
      ...current.attempts.map((attempt) => ({
        bound: 'signed-transactions-per-attempt',
        maximum: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
        observed: attempt.signedTransactions.length,
        attemptId: attempt.attemptId,
      })),
    ]);
  });

  it('counts included attempts toward retained capacity', () => {
    const current = snapshot(
      Array.from(
        { length: MAX_RETAINED_ATTEMPTS + 1 },
        () => 1,
      ),
      true,
    );

    expect(current.attempts.every((attempt) => {
      return attempt.phase === 'included';
    })).toBe(true);

    expect(inspectJournalBounds(current)).toMatchObject([
      {
        bound: 'retained-attempts',
        maximum: MAX_RETAINED_ATTEMPTS,
        observed: MAX_RETAINED_ATTEMPTS + 1,
        attemptId: null,
      },
    ]);
  });

  it('honors a lower supplied transaction limit', () => {
    const bounds = {
      maxRetainedAttempts: DEFAULT_MAX_RETAINED_ATTEMPTS,
      maxSignedTransactionsPerAttempt: 2,
    };

    expect(inspectJournalBounds(snapshot([2]), bounds)).toEqual([]);

    expect(inspectJournalBounds(snapshot([3]), bounds)).toMatchObject([
      {
        bound: 'signed-transactions-per-attempt',
        maximum: 2,
        observed: 3,
      },
    ]);

    expect(inspectJournalBounds(snapshot([3]))).toEqual([]);
  });

  it('freezes violations without modifying or freezing the input', () => {
    const current = snapshot([
      MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1,
    ]);
    const before = structuredClone(current);

    const result = inspectJournalBounds(current);

    expect(current).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);

    for (const violation of result) {
      expect(Object.isFrozen(violation)).toBe(true);
    }

    expect(Object.isFrozen(current)).toBe(false);
    expect(Object.isFrozen(current.attempts)).toBe(false);

    for (const attempt of current.attempts) {
      expect(Object.isFrozen(attempt)).toBe(false);
      expect(Object.isFrozen(attempt.signedTransactions)).toBe(false);

      for (const transaction of attempt.signedTransactions) {
        expect(Object.isFrozen(transaction)).toBe(false);
      }
    }
  });

  const invalidValues = [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  it.each([
    ...invalidValues,
    MAX_RETAINED_ATTEMPTS + 1,
  ])('rejects invalid retained-attempt configuration: %s', (value) => {
    expect(() => inspectJournalBounds(snapshot([]), {
      ...DEFAULT_JOURNAL_BOUNDS,
      maxRetainedAttempts: value,
    })).toThrow('Invalid retained-attempt bound.');
  });

  it.each([
    ...invalidValues,
    MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1,
  ])('rejects invalid transaction-count configuration: %s', (value) => {
    expect(() => inspectJournalBounds(snapshot([]), {
      ...DEFAULT_JOURNAL_BOUNDS,
      maxSignedTransactionsPerAttempt: value,
    })).toThrow('Invalid signed-transaction bound.');
  });

  it('captures bound violations in a typed error without mutable aliases', () => {
    const current = snapshot([
      MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1,
    ]);

    const violations = inspectJournalBounds(current).map((violation) => ({
      ...violation,
    }));

    const expected = structuredClone(violations);
    const error = new JournalBoundsExceededError(violations);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('JournalBoundsExceededError');
    expect(error.message).toBe(
      expected.map((violation) => violation.message).join(' '),
    );
    expect(error.violations).toEqual(expected);
    expect(error.violations).not.toBe(violations);
    expect(Object.isFrozen(error.violations)).toBe(true);

    for (const [index, violation] of error.violations.entries()) {
      expect(violation).not.toBe(violations[index]);
      expect(Object.isFrozen(violation)).toBe(true);
    }

    violations[0]!.observed = 0;
    violations.length = 0;

    expect(error.violations).toEqual(expected);
  });

  it('rejects constructing a bounds error without violations', () => {
    expect(() => new JournalBoundsExceededError([])).toThrow(
      'Expected at least one journal bound violation.',
    );
  });
});