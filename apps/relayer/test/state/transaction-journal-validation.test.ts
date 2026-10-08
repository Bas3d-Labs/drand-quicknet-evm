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
const OTHER = `0x${'bb'.repeat(32)}` as const;
const THIRD = `0x${'cc'.repeat(32)}` as const;

const IDENTITY = {
  chainId: 4663,
  signer: SIGNER,
} as const;

// Structural fixtures only; not signed transactions.
const BYTES = `0x${'ab'.repeat(64)}` as const;
const OTHER_BYTES = `0x${'cd'.repeat(64)}` as const;
const INVALID = 'Invalid transaction journal snapshot.';

function inclusion() {
  return {
    outcome: 'success',
    transactionHash: HASH,
    inclusion: {
      blockNumber: 119n,
      blockHash: OTHER,
    },
    observedAt: {
      blockNumber: 120n,
      blockHash: HASH,
    },
  };
}

function attempt(nonce = 4n) {
  return {
    attemptId: nonce === 4n
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222',
    nonce,
    createdAt: '2026-10-04T00:00:00.000Z',
    phase: 'broadcast-may-have-occurred',
    inclusion: null as ReturnType<typeof inclusion> | null,
    signedTransactions: [{
      transactionHash: nonce === 4n ? HASH : THIRD,
      signedTransaction: BYTES,
    }],
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
  };
}

function fixture() {
  return {
    version: 1,
    identity: { ...IDENTITY },
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
    nextNonce: 5n,
    durableNextNonce: 4n,
    attempts: [attempt()],
  };
}

function includedFixture() {
  const input = fixture();
  const recorded = input.attempts[0]!;

  recorded.phase = 'included';
  recorded.inclusion = inclusion();

  return input;
}

function validate(input: unknown) {
  return validateJournalSnapshotStructure(input, IDENTITY);
}

function expectInvalid(input: unknown) {
  expect(() => validate(input)).toThrow(new TypeError(INVALID));
}

describe('journal snapshot structure', () => {
  it('returns a detached, deeply frozen snapshot', () => {
    const input = includedFixture();
    const snapshot = validate(input);
    const recorded = input.attempts[0]!;

    input.lastObservation.anchor.blockNumber = 999n;
    recorded.replacementSearch.lowerBound.nonce = 999n;
    recorded.inclusion!.inclusion.blockNumber = 999n;

    Object.assign(recorded.signedTransactions[0]!, {
      signedTransaction: OTHER_BYTES,
    });

    input.attempts.push(attempt(5n));

    expect(snapshot.attempts).toHaveLength(1);
    expect(snapshot.lastObservation.anchor.blockNumber).toBe(120n);

    const saved = snapshot.attempts[0]!;

    expect(saved.replacementSearch?.lowerBound.nonce).toBe(4n);
    expect(saved.inclusion?.inclusion.blockNumber).toBe(119n);
    expect(saved.signedTransactions[0].signedTransaction).toBe(BYTES);

    for (const value of [
      snapshot,
      snapshot.identity,
      snapshot.baseline,
      snapshot.baseline.anchor,
      snapshot.lastObservation,
      snapshot.lastObservation.anchor,
      snapshot.attempts,
      saved,
      saved.signedTransactions,
      saved.signedTransactions[0],
      saved.replacementSearch,
      saved.replacementSearch?.lowerBound,
      saved.replacementSearch?.lowerBound.anchor,
      saved.replacementSearch?.searchedThrough,
      saved.inclusion,
      saved.inclusion?.inclusion,
      saved.inclusion?.observedAt,
    ]) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it.each([4n, 8n])(
    'accepts an empty journal with both counters at %s',
    (nonce) => {
      const input = {
        ...fixture(),
        nextNonce: nonce,
        durableNextNonce: nonce,
        attempts: [],
      };

      expect(validate(input).attempts).toEqual([]);
    },
  );

  it('accepts multiple unresolved attempts retained for recovery', () => {
    const input = fixture();

    input.attempts.push(attempt(5n));
    input.nextNonce = 6n;

    expect(validate(input).attempts.map((entry) => entry.nonce))
      .toEqual([4n, 5n]);
  });

  it('accepts a signed attempt with no replacement search', () => {
    const input = fixture();

    Object.assign(input.attempts[0]!, {
      phase: 'signed',
      replacementSearch: null,
    });

    expect(validate(input).attempts[0]!.phase).toBe('signed');
  });

  it.each([0n, 20n])(
    'preserves an observed nonce outside the allocated range: %s',
    (nonce) => {
      const input = fixture();
      input.lastObservation.nonce = nonce;

      expect(validate(input).lastObservation.nonce).toBe(nonce);
    },
  );

  it.each([
    { chainId: 1, signer: SIGNER },
    {
      chainId: 4663,
      signer: '0x2222222222222222222222222222222222222222',
    },
  ] as const)('rejects an identity mismatch: %#', (expected) => {
    expect(() => validateJournalSnapshotStructure(
      fixture(),
      expected,
    )).toThrow(new TypeError(INVALID));
  });

  it('requires the attempts field', () => {
    const { attempts: _attempts, ...input } = fixture();

    expectInvalid(input);
  });

  const invalidStates: Array<{
    name: string;
    mutate: (input: ReturnType<typeof fixture>) => void;
  }> = [
    {
      name: 'unsupported version',
      mutate: (input) => { input.version = 2; },
    },
    {
      name: 'durable progress behind the baseline',
      mutate: (input) => { input.durableNextNonce = 3n; },
    },
    {
      name: 'allocation behind durable progress',
      mutate: (input) => { input.nextNonce = 3n; },
    },
    {
      name: 'missing allocated nonce',
      mutate: (input) => { input.nextNonce = 6n; },
    },
    {
      name: 'incorrect first nonce',
      mutate: (input) => { input.attempts[0]!.nonce = 5n; },
    },
    {
      name: 'duplicate nonce',
      mutate: (input) => {
        input.attempts.push(attempt(5n));
        input.attempts[1]!.nonce = 4n;
        input.nextNonce = 6n;
      },
    },
    {
      name: 'duplicate attempt ID',
      mutate: (input) => {
        input.attempts.push(attempt(5n));
        input.attempts[1]!.attemptId = input.attempts[0]!.attemptId;
        input.nextNonce = 6n;
      },
    },
    {
      name: 'duplicate hash across attempts',
      mutate: (input) => {
        input.attempts.push(attempt(5n));
        input.attempts[1]!.signedTransactions[0]!.transactionHash = HASH;
        input.nextNonce = 6n;
      },
    },
    {
      name: 'duplicate hash within an attempt',
      mutate: (input) => {
        const transactions = input.attempts[0]!.signedTransactions;
        transactions.push({ ...transactions[0]! });
      },
    },
    {
      name: 'empty signed transaction collection',
      mutate: (input) => {
        input.attempts[0]!.signedTransactions = [];
      },
    },
    {
      name: 'invalid signed bytes',
      mutate: (input) => {
        Object.assign(input.attempts[0]!.signedTransactions[0]!, {
          signedTransaction: '0xzz',
        });
      },
    },
    {
      name: 'invalid timestamp',
      mutate: (input) => {
        input.attempts[0]!.createdAt = 'not-a-timestamp';
      },
    },
    {
      name: 'consumed replacement-search lower bound',
      mutate: (input) => {
        input.attempts[0]!.replacementSearch.lowerBound.nonce = 5n;
      },
    },
    {
      name: 'search boundary at the lower bound',
      mutate: (input) => {
        input.attempts[0]!
          .replacementSearch.searchedThrough.blockNumber = 100n;
      },
    },
    {
      name: 'unknown phase',
      mutate: (input) => {
        input.attempts[0]!.phase = 'unknown';
      },
    },
    {
      name: 'included phase without an observation',
      mutate: (input) => {
        input.attempts[0]!.phase = 'included';
      },
    },
    {
      name: 'broadcast phase with an inclusion observation',
      mutate: (input) => {
        input.attempts[0]!.inclusion = inclusion();
      },
    },
    {
      name: 'signed phase with an inclusion observation',
      mutate: (input) => {
        input.attempts[0]!.phase = 'signed';
        input.attempts[0]!.inclusion = inclusion();
      },
    },
  ];

  it.each(invalidStates)('rejects $name', ({ mutate }) => {
    const input = fixture();
    mutate(input);

    expectInvalid(input);
  });
});

describe('journal inclusion observations', () => {
  it.each(['success', 'reverted'])(
    'accepts %s for a recorded signed transaction',
    (outcome) => {
      const input = includedFixture();
      input.attempts[0]!.inclusion!.outcome = outcome;

      expect(validate(input).attempts[0]!.inclusion?.outcome)
        .toBe(outcome);
    },
  );

  it('accepts inclusion of a later signed transaction', () => {
    const input = includedFixture();
    const recorded = input.attempts[0]!;

    recorded.signedTransactions.push({
      transactionHash: THIRD,
      signedTransaction: BYTES,
    });
    recorded.inclusion!.transactionHash = THIRD;

    expect(validate(input).attempts[0]!.inclusion)
      .toMatchObject({ transactionHash: THIRD });
  });

  it('accepts inclusion at the observation anchor itself', () => {
    const input = includedFixture();
    const observed = input.attempts[0]!.inclusion!;

    observed.inclusion = { ...observed.observedAt };

    expect(validate(input).attempts[0]!.inclusion)
      .toMatchObject({ inclusion: observed.observedAt });
  });

  it.each([
    'unrecorded hash',
    'inclusion above observation',
    'conflicting hash at observation height',
    'unknown outcome',
  ])('rejects %s', (kind) => {
    const input = includedFixture();
    const observed = input.attempts[0]!.inclusion!;

    switch (kind) {
      case 'unrecorded hash':
        observed.transactionHash = THIRD;
        break;
      case 'inclusion above observation':
        observed.inclusion.blockNumber = 121n;
        break;
      case 'conflicting hash at observation height':
        observed.inclusion.blockNumber = 120n;
        break;
      case 'unknown outcome':
        observed.outcome = 'unknown';
        break;
    }

    expectInvalid(input);
  });

  it('accepts a replacement outside the recorded transactions', () => {
    const input = includedFixture();

    Object.assign(input.attempts[0]!, {
      inclusion: {
        inclusion: inclusion().inclusion,
        observedAt: inclusion().observedAt,
        outcome: 'replaced',
        replacementTransactionHash: THIRD,
        nonceAtAnchor: 5n,
      },
    });

    expect(validate(input).attempts[0]!.inclusion)
      .toMatchObject({
        outcome: 'replaced',
        replacementTransactionHash: THIRD,
        nonceAtAnchor: 5n,
      });
  });

  it.each([
    { hash: HASH, nonce: 5n },
    { hash: THIRD, nonce: 4n },
  ])('rejects inconsistent replacement evidence: %#', ({ hash, nonce }) => {
    const input = includedFixture();

    Object.assign(input.attempts[0]!, {
      inclusion: {
        inclusion: inclusion().inclusion,
        observedAt: inclusion().observedAt,
        outcome: 'replaced',
        replacementTransactionHash: hash,
        nonceAtAnchor: nonce,
      },
    });

    expectInvalid(input);
  });
});

describe('journal property access', () => {
  it('does not invoke a signed-byte getter', () => {
    const input = fixture();
    const get = vi.fn(() => BYTES);

    Object.defineProperty(
      input.attempts[0]!.signedTransactions[0]!,
      'signedTransaction',
      { get },
    );

    expectInvalid(input);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['attempts', 'signedTransactions'] as const)(
    'does not invoke an indexed getter in %s',
    (target) => {
      const input = fixture();
      const entries = target === 'attempts'
        ? input.attempts
        : input.attempts[0]!.signedTransactions;
      const get = vi.fn(() => entries);

      Object.defineProperty(entries, '0', { get });

      expectInvalid(input);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each(['attempts', 'signedTransactions'] as const)(
    'rejects a sparse %s array',
    (target) => {
      const input = fixture();
      const entries = target === 'attempts'
        ? input.attempts
        : input.attempts[0]!.signedTransactions;

      Reflect.deleteProperty(entries, '0');

      expectInvalid(input);
    },
  );

  it('rejects inherited array entries', () => {
    const input = fixture();
    const inherited = Object.create(Array.prototype);

    Object.defineProperty(inherited, '0', {
      value: input.attempts[0],
    });

    Reflect.deleteProperty(input.attempts, '0');
    Object.setPrototypeOf(input.attempts, inherited);

    expectInvalid(input);
  });

  it('does not invoke the input array iterator', () => {
    const input = fixture();
    const get = vi.fn(() => {
      throw new Error('Iterator must not be inspected');
    });

    Object.defineProperty(input.attempts, Symbol.iterator, { get });
    Object.defineProperty(
      input.attempts[0]!.signedTransactions,
      Symbol.iterator,
      { get },
    );

    expect(validate(input).attempts).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('does not inspect or retain extra fields', () => {
    const input = fixture();
    const get = vi.fn(() => BYTES);

    for (const value of [
      input,
      input.attempts[0]!,
      input.attempts[0]!.signedTransactions[0]!,
    ]) {
      Object.defineProperty(value, 'rawResponse', {
        enumerable: true,
        get,
      });
    }

    const snapshot = validate(input);

    expect(snapshot).not.toHaveProperty('rawResponse');
    expect(snapshot.attempts[0]).not.toHaveProperty('rawResponse');
    expect(snapshot.attempts[0]!.signedTransactions[0])
      .not.toHaveProperty('rawResponse');
    expect(get).not.toHaveBeenCalled();
  });
});