import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  validateJournalSnapshotStructure,
} from '../../src/state/transaction-journal-validation.js';

const SIGNER = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'aa'.repeat(32)}` as const;

// Structural fixture only; not a signed transaction.
const BYTES = `0x${'ab'.repeat(64)}` as const;

function fixture() {
  return {
    version: 1 as const,
    identity: {
      chainId: 4663,
      signer: SIGNER as typeof SIGNER,
    },
    baseline: {
      anchor: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      nonce: 4n,
    },
    lastObservation: {
      anchor: {
        blockNumber: 120n,
        blockHash: HASH,
      },
      nonce: 5n,
    },
    nextNonce: 4n,
    attempt: {
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      transactionHash: HASH,
      signedTransaction: BYTES,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred' as const,
      replacementSearch: {
        lowerBound: {
          anchor: {
            blockNumber: 100n,
            blockHash: HASH,
          },
          nonce: 4n,
        },
        searchedThrough: {
          blockNumber: 110n,
          blockHash: HASH,
        },
      },
    },
  };
}

describe('journal snapshot structure', () => {
  it('returns a detached, deeply frozen snapshot', () => {
    const input = fixture();
    const snapshot = validateJournalSnapshotStructure(
      input,
      input.identity,
    );

    input.lastObservation.anchor.blockNumber = 999n;
    input.attempt.replacementSearch.lowerBound.nonce = 999n;

    expect(snapshot.lastObservation.anchor.blockNumber).toBe(120n);
    expect(snapshot.attempt?.replacementSearch?.lowerBound.nonce)
      .toBe(4n);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.identity)).toBe(true);
    expect(Object.isFrozen(snapshot.lastObservation.anchor)).toBe(true);
    expect(Object.isFrozen(snapshot.attempt)).toBe(true);
    expect(
      Object.isFrozen(snapshot.attempt?.replacementSearch?.lowerBound),
    ).toBe(true);
  });

  it('accepts an initialized journal without an attempt', () => {
    const input = {
      ...fixture(),
      nextNonce: 5n,
      attempt: null,
    };

    expect(
      validateJournalSnapshotStructure(input, input.identity).attempt,
    ).toBeNull();
  });

  it('requires explicit null rather than a missing attempt', () => {
    const input = fixture();
    const { attempt: _attempt, ...missingAttempt } = input;

    expect(() => validateJournalSnapshotStructure(
      missingAttempt,
      input.identity,
    )).toThrow('Invalid transaction journal snapshot.');
  });

  it('preserves an observed nonce ahead of the journal', () => {
    const input = fixture();
    input.lastObservation.nonce = 20n;

    expect(
      validateJournalSnapshotStructure(
        input,
        input.identity,
      ).lastObservation.nonce,
    ).toBe(20n);
  });

  it.each([
    {
      chainId: 1,
      signer: SIGNER,
    },
    {
      chainId: 4663,
      signer: '0x2222222222222222222222222222222222222222',
    },
  ] as const)('rejects an identity mismatch: %#', (expected) => {
    expect(() => validateJournalSnapshotStructure(
      fixture(),
      expected,
    )).toThrow('Invalid transaction journal snapshot.');
  });

  it.each([
    (input: ReturnType<typeof fixture>) => {
      input.nextNonce = 3n;
    },
    (input: ReturnType<typeof fixture>) => {
      input.attempt.nonce = 5n;
    },
    (input: ReturnType<typeof fixture>) => {
      input.attempt.replacementSearch.lowerBound.nonce = 5n;
    },
    (input: ReturnType<typeof fixture>) => {
      input.attempt.replacementSearch.searchedThrough.blockNumber = 100n;
    },
    (input: ReturnType<typeof fixture>) => {
      input.attempt.createdAt = 'not-a-timestamp';
    },
  ])('rejects inconsistent state: %#', (mutate) => {
    const input = fixture();
    mutate(input);

    expect(() => validateJournalSnapshotStructure(
      input,
      input.identity,
    )).toThrow('Invalid transaction journal snapshot.');
  });

  it('does not invoke a declared field getter or echo its value', () => {
    const input = fixture();
    const get = vi.fn(() => BYTES);

    Object.defineProperty(input.attempt, 'signedTransaction', { get });

    expect(() => validateJournalSnapshotStructure(
      input,
      input.identity,
    )).toThrow(new TypeError('Invalid transaction journal snapshot.'));

    expect(get).not.toHaveBeenCalled();
  });

  it('does not inspect or retain extra fields', () => {
    const input = fixture();
    const get = vi.fn(() => BYTES);

    Object.defineProperty(input, 'rawResponse', {
      enumerable: true,
      get,
    });

    const snapshot = validateJournalSnapshotStructure(
      input,
      input.identity,
    );

    expect(snapshot).not.toHaveProperty('rawResponse');
    expect(get).not.toHaveBeenCalled();
  });
});