import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  resolveReplacementSearch,
} from '../../src/chain/resolve-replacement-search.js';

import type {
  AnchoredNonceObservation,
  ReplacementSearch,
} from '../../src/state/transaction-journal.js';

const OBSERVATION: AnchoredNonceObservation = {
  anchor: {
    blockNumber: 100n,
    blockHash:
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  nonce: 4n,
};

describe('resolveReplacementSearch', () => {
  it.each([3n, 4n, 5n])(
    'preserves existing progress when the last observed nonce is %s',
    (nonce) => {
      const existing: ReplacementSearch = {
        lowerBound: OBSERVATION,
        searchedThrough: OBSERVATION.anchor,
      };

      const result = resolveReplacementSearch(
        {
          nonce: 4n,
          replacementSearch: existing,
        },
        {
          ...OBSERVATION,
          nonce,
        },
      );

      expect(result).toBe(existing);
      expect(result?.lowerBound).toBe(OBSERVATION);
      expect(result?.searchedThrough).toBe(OBSERVATION.anchor);
    },
  );

  it.each([3n, 4n])(
    'initializes from an eligible observation with nonce %s',
    (nonce) => {
      const observation: AnchoredNonceObservation = {
        ...OBSERVATION,
        nonce,
      };

      const attempt = Object.freeze({
        nonce: 4n,
        replacementSearch: null,
      });

      const result = resolveReplacementSearch(attempt, observation);

      expect(result).toEqual({
        lowerBound: observation,
        searchedThrough: null,
      });
      expect(result?.lowerBound).toBe(observation);
      expect(attempt.replacementSearch).toBeNull();
    },
  );

  it('does not initialize from an observation above the attempt nonce', () => {
    const result = resolveReplacementSearch(
      {
        nonce: 4n,
        replacementSearch: null,
      },
      {
        ...OBSERVATION,
        nonce: 5n,
      },
    );

    expect(result).toBeNull();
  });
});