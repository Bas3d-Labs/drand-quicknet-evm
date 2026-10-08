import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  Hash,
} from 'viem';

import {
  assertResolutionTransaction,
} from '../../src/diagnostics/resolution-validation.js';

const ORIGINAL = `0x${'ab'.repeat(32)}` as const;
const BUMP = `0x${'cd'.repeat(32)}` as const;
const EXTERNAL = `0x${'ef'.repeat(32)}` as const;

const FAILURE = 'Invalid attempt resolution evidence.';

function attempt() {
  return {
    nonce: 4n,
    signedTransactions: [
      { transactionHash: ORIGINAL },
      { transactionHash: BUMP },
    ],
  };
}

function uppercase(hash: Hash): Hash {
  return `0x${hash.slice(2).toUpperCase()}`;
}

describe('resolution transaction matching', () => {
  it.each([
    { outcome: 'success', transactionHash: ORIGINAL },
    { outcome: 'success', transactionHash: BUMP },
    { outcome: 'reverted', transactionHash: ORIGINAL },
    { outcome: 'reverted', transactionHash: BUMP },
  ] as const)(
    'accepts $outcome for recorded hash $transactionHash',
    (evidence) => {
      expect(() => assertResolutionTransaction(
        attempt(),
        evidence,
      )).not.toThrow();
    },
  );

  it.each(['success', 'reverted'] as const)(
    'rejects %s for an unrecorded hash',
    (outcome) => {
      expect(() => assertResolutionTransaction(attempt(), {
        outcome,
        transactionHash: EXTERNAL,
      })).toThrow(FAILURE);
    },
  );

  it('accepts replacement by an external transaction', () => {
    expect(() => assertResolutionTransaction(attempt(), {
      outcome: 'replaced',
      replacementTransactionHash: EXTERNAL,
      nonceAtAnchor: 5n,
    })).not.toThrow();
  });

  it('accepts replacement evidence with additional nonce consumption', () => {
    expect(() => assertResolutionTransaction(attempt(), {
      outcome: 'replaced',
      replacementTransactionHash: EXTERNAL,
      nonceAtAnchor: 8n,
    })).not.toThrow();
  });

  it.each([ORIGINAL, BUMP])(
    'rejects replacement evidence naming our recorded hash %s',
    (replacementTransactionHash) => {
      expect(() => assertResolutionTransaction(attempt(), {
        outcome: 'replaced',
        replacementTransactionHash,
        nonceAtAnchor: 5n,
      })).toThrow(FAILURE);
    },
  );

  it.each([3n, 4n])(
    'rejects replacement evidence without nonce consumption: %s',
    (nonceAtAnchor) => {
      expect(() => assertResolutionTransaction(attempt(), {
        outcome: 'replaced',
        replacementTransactionHash: EXTERNAL,
        nonceAtAnchor,
      })).toThrow(FAILURE);
    },
  );

  it('matches recorded hashes regardless of hexadecimal case', () => {
    const recorded = {
      nonce: 4n,
      signedTransactions: [
        { transactionHash: uppercase(ORIGINAL) },
        { transactionHash: BUMP },
      ],
    };

    expect(() => assertResolutionTransaction(recorded, {
      outcome: 'success',
      transactionHash: ORIGINAL,
    })).not.toThrow();

    expect(() => assertResolutionTransaction(recorded, {
      outcome: 'reverted',
      transactionHash: uppercase(BUMP),
    })).not.toThrow();

    expect(() => assertResolutionTransaction(recorded, {
      outcome: 'replaced',
      replacementTransactionHash: uppercase(BUMP),
      nonceAtAnchor: 5n,
    })).toThrow(FAILURE);
  });

  it('rejects an empty recorded transaction set', () => {
    expect(() => assertResolutionTransaction({
      nonce: 4n,
      signedTransactions: [],
    }, {
      outcome: 'replaced',
      replacementTransactionHash: EXTERNAL,
      nonceAtAnchor: 5n,
    })).toThrow(FAILURE);
  });
});