import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  Hash,
  PublicClient,
} from 'viem';

import type {
  BlockAnchor,
} from '../../src/chain/block-anchor.js';

import {
  assertInspectionCompleted,
  createInspectionBracket,
  discardInspectionEvidence,
  inspectionNeedsOpening,
  latestNonceIsConsistent,
  mergeBlockObservations,
  nextInspectionPhase,
  observeDurableNonce,
  type InspectionBracket,
} from '../../src/state/inspection-bracket.js';

const HASH_A: Hash = `0x${'ab'.repeat(32)}`;

const HASH_B: Hash = `0x${'cd'.repeat(32)}`;

const HASH_A_UPPER: Hash = `0x${'AB'.repeat(32)}`;

const publicClient = {} as PublicClient;

const head: BlockAnchor = { blockNumber: 20n, blockHash: HASH_B };

const durableAnchor: BlockAnchor = { blockNumber: 10n, blockHash: HASH_A };

const phases = [
  'opening',
  'durable',
  'latest',
  'closing',
  'persisting',
  'completed',
  'failed',
] as const;

function bracket(): InspectionBracket {
  return createInspectionBracket({ publicClient, head, durableAnchor });
}

describe('inspection bracket', () => {
  it(
    'captures frozen anchor copies and starts with isolated empty evidence',
    () => {
      const first = bracket();

      const second = bracket();

      expect(first).toEqual({
        publicClient,
        head: { blockNumber: 20n, blockHash: HASH_B },
        durableAnchor: { blockNumber: 10n, blockHash: HASH_A },
        durableNonce: undefined,
        durableObservations: new Map(),
        phase: 'opening',
      });
      expect(first.publicClient).toBe(publicClient);
      expect(first.head).not.toBe(head);
      expect(first.durableAnchor).not.toBe(durableAnchor);
      expect(Object.isFrozen(first.head)).toBe(true);
      expect(Object.isFrozen(first.durableAnchor)).toBe(true);
      expect(first.durableObservations).not.toBe(second.durableObservations);
    }
  );

  it('allows an absent durable anchor and matching same-height hashes', () => {
    expect(createInspectionBracket({ publicClient, head }).durableAnchor)
      .toBeUndefined();
    expect(createInspectionBracket({
      publicClient,
      head: { blockNumber: 10n, blockHash: HASH_A_UPPER },
      durableAnchor,
    }).phase).toBe('opening');
  });

  it.each([
    { head: { blockNumber: -1n, blockHash: HASH_A } },
    { head: { blockNumber: 1n << 256n, blockHash: HASH_A } },
    { head: { blockNumber: 10n, blockHash: '0xab' as Hash } },
    { head: { blockNumber: 10 as unknown as bigint, blockHash: HASH_A } },
    { durableAnchor: { blockNumber: -1n, blockHash: HASH_A } },
    { durableAnchor: { blockNumber: 21n, blockHash: HASH_A } },
    { durableAnchor: { blockNumber: 20n, blockHash: HASH_A } },
    { durableAnchor: { blockNumber: 10n, blockHash: '0xab' as Hash } },
    {
      durableAnchor: {
        blockNumber: 10 as unknown as bigint,
        blockHash: HASH_A
      }
    },
  ])('rejects invalid anchors in case %#', (invalid) => {
    expect(() => createInspectionBracket({
      publicClient,
      head,
      durableAnchor,
      ...invalid,
    })).toThrow(new TypeError('Invalid signer inspection anchors.'));
  });

  it.each(phases)(
    'checks opening, completion and every move from %s',
    (phase) => {
      const state = { ...bracket(), phase };

      // Expected moves are independent of the production transition table.
      const allowed = new Set([
        'opening:durable',
        'durable:latest',
        'latest:closing',
        'closing:persisting',
        'persisting:completed',
        'opening:failed',
        'durable:failed',
        'latest:failed',
        'closing:failed',
        'persisting:failed',
        'completed:failed',
        'failed:failed',
      ]);

      for (const next of phases) {
        if (allowed.has(`${phase}:${next}`)) {
          expect(nextInspectionPhase(phase, next)).toBe(next);
        } else {
          expect(() => nextInspectionPhase(phase, next)).toThrow(
            'Signer inspection bracket cannot accept another operation.',
          );
        }
      }

      if (phase === 'opening' || phase === 'durable') {
        expect(inspectionNeedsOpening(state)).toBe(phase === 'opening');
      } else {
        expect(() => inspectionNeedsOpening(state)).toThrow(
          'Signer inspection bracket cannot accept another operation.',
        );
      }

      if (phase === 'completed') {
        expect(() => assertInspectionCompleted(state)).not.toThrow();
      } else {
        expect(() => assertInspectionCompleted(state)).toThrow(
          'Signer inspection bracket has not completed successfully.',
        );
      }

      expect(state.phase).toBe(phase);
    }
  );

  it(
    'remembers the first nonce, accepts repeats, and reports contradictions',
    () => {
      const state = bracket();

      const observation = { anchor: durableAnchor, nonce: 0n };

      expect(observeDurableNonce(state, observation)).toBe(0n);
      expect(state.durableNonce).toBeUndefined();

      state.durableNonce = 0n;

      expect(observeDurableNonce(state, observation)).toBe(0n);
      expect(observeDurableNonce(state, {
        ...observation,
        nonce: 1n
      })).toBeNull();

      state.durableNonce = 2n;

      expect(observeDurableNonce(state, {
        ...observation,
        nonce: 1n
      })).toBeNull();
      expect(state.durableNonce).toBe(2n);
      expect(state.phase).toBe('opening');
    }
  );

  it('rejects durable observations without the selected durable anchor', () => {
    const state = bracket();

    const unanchored = createInspectionBracket({ publicClient, head });

    for (const candidate of [
      { state: unanchored, anchor: durableAnchor },
      { state, anchor: head },
      { state, anchor: { ...durableAnchor, blockHash: HASH_B } },
    ]) {
      expect(() => observeDurableNonce(candidate.state, {
        anchor: candidate.anchor,
        nonce: 1n,
      })).toThrow('Durable observation does not match the inspection anchor.');
    }

    expect(observeDurableNonce(state, {
      anchor: { ...durableAnchor, blockHash: HASH_A_UPPER },
      nonce: 1n,
    })).toBe(1n);
  });

  it(
    'allows latest nonces at or above durable, and any nonce without durable evidence',
    () => {
      const state = bracket();

      expect(latestNonceIsConsistent(state, 0n)).toBe(true);

      state.durableNonce = 2n;

      expect(latestNonceIsConsistent(state, 1n)).toBe(false);
      expect(latestNonceIsConsistent(state, 2n)).toBe(true);
      expect(latestNonceIsConsistent(state, 3n)).toBe(true);
      expect(state.durableNonce).toBe(2n);
    }
  );

  it(
    'merges matching repeats case-insensitively without mutating either input',
    () => {
      const previous = new Map<bigint, Hash>([[10n, HASH_A]]);

      const observations = Object.freeze([
        Object.freeze({ blockNumber: 10n, blockHash: HASH_A_UPPER }),
        Object.freeze({ blockNumber: 20n, blockHash: HASH_B }),
        Object.freeze({ blockNumber: 20n, blockHash: HASH_B }),
      ]);

      expect(mergeBlockObservations(previous, observations)).toEqual(
        new Map([[10n, HASH_A_UPPER], [20n, HASH_B]]),
      );
      expect(previous).toEqual(new Map([[10n, HASH_A]]));
      expect(mergeBlockObservations(previous, [])).not.toBe(previous);
    }
  );

  it(
    'rejects conflicts with retained evidence and within one new pass atomically',
    () => {
      const previous = new Map<bigint, Hash>([[10n, HASH_A]]);

      expect(mergeBlockObservations(previous, [
        { blockNumber: 20n, blockHash: HASH_B },
        { blockNumber: 10n, blockHash: HASH_B },
      ])).toBeNull();
      expect(mergeBlockObservations(previous, [
        { blockNumber: 20n, blockHash: HASH_A },
        { blockNumber: 20n, blockHash: HASH_B },
      ])).toBeNull();
      expect(previous).toEqual(new Map([[10n, HASH_A]]));
    }
  );

  it(
    'discards evidence without changing the old value or seeding another bracket',
    () => {
      const state = bracket();

      state.durableObservations = new Map([[10n, HASH_A]]);
      state.durableNonce = 2n;
      state.phase = 'completed';

      const discarded = discardInspectionEvidence(state);

      expect(discarded).toEqual({ ...state, durableObservations: new Map() });
      expect(discarded).not.toBe(state);
      expect(state.durableObservations).toEqual(new Map([[10n, HASH_A]]));
      expect(bracket().durableObservations.size).toBe(0);
      expect(bracket().durableNonce).toBeUndefined();
    }
  );
});
