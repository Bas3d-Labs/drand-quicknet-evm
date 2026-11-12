import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Hash,
  PublicClient,
} from 'viem';

import {
  MAX_LOWER_BOUND_PROBES,
  repairSearchLowerBound,
  type RepairSearchLowerBoundOptions,
} from '../../src/chain/repair-search-lower-bound.js';

import type {
  AnchoredNonceObservation,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const SIGNER = `0x${'11'.repeat(20)}` as const;

function hashAt(height: bigint): Hash {
  return `0x${height.toString(16).padStart(64, '0')}`;
}

function oldAnchor(height: bigint) {
  return { blockNumber: height, blockHash: hashAt(height) };
}

function newAnchor(height: bigint) {
  return { blockNumber: height, blockHash: hashAt(10_000n + height) };
}

function assertFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) {
      assertFrozen(child);
    }
  }
}

function setup(lowerHeight = 98n, factHeight: bigint | null = null) {
  const lowerBound = { anchor: oldAnchor(lowerHeight), nonce: 4n };
  let exhausted: AnchoredNonceObservation | null = null;
  if (factHeight !== null) {
    exhausted = { anchor: oldAnchor(factHeight), nonce: 5n };
  }
  const snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: { chainId: 4663, signer: SIGNER },
    baseline: lowerBound,
    lastObservation: { anchor: oldAnchor(130n), nonce: 5n },
    nextNonce: 5n,
    durableNextNonce: 4n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts: [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      workId: 'test-work:4',
      nonce: 4n,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      // This reader validates structure; signed-byte verification belongs to
      // the store boundary and is not exercised by these transport unit tests.
      signedTransactions: [{
        transactionHash: hashAt(900n),
        signedTransaction: `0x${'11'.repeat(32)}`,
      }],
      replacementSearch: {
        lowerBound,
        searchedThrough: null,
        exhausted,
      },
    }],
  };

  const calls: string[] = [];
  const getBlock = vi.fn(async (request: {
    blockNumber: bigint;
    includeTransactions?: boolean;
  }) => {
    calls.push(`header:${request.blockNumber}`);
    expect(request.includeTransactions).not.toBe(true);
    let parentHash = hashAt(0n);
    if (request.blockNumber > 0n) {
      parentHash = newAnchor(request.blockNumber - 1n).blockHash;
    }
    return {
      number: request.blockNumber,
      hash: newAnchor(request.blockNumber).blockHash,
      parentHash,
    };
  });
  const getTransactionCount = vi.fn(async (request: {
    address: string;
    blockNumber: bigint;
  }): Promise<number> => {
    calls.push(`nonce:${request.blockNumber}`);
    expect(request.address).toBe(SIGNER);
    if (request.blockNumber === lowerHeight) {
      return 5;
    }
    return 4;
  });
  const options = {
    publicClient: { getBlock, getTransactionCount } as unknown as PublicClient,
    snapshot,
    observation: { anchor: newAnchor(104n), nonce: 5n },
    trigger: {
      durableAnchor: newAnchor(104n),
      lowerBound,
      observedLower: newAnchor(lowerHeight),
    },
    observations: [],
  } satisfies RepairSearchLowerBoundOptions;
  return {
    options,
    calls,
    getBlock,
    getTransactionCount,
    run: () => repairSearchLowerBound(options),
  };
}

describe('lower-bound repair bracket', () => {
  it('walks consecutive heights and exposes evidence only after closing', async () => {
    const fixture = setup();
    const before = structuredClone(fixture.options.snapshot);
    const result = await fixture.run();

    expect(fixture.calls).toEqual([
      'header:104',
      'header:98', 'nonce:98', 'header:98',
      'header:97', 'nonce:97', 'header:97',
      'header:104',
    ]);
    expect(result.status).toBe('search-lower-bound-replacement-required');
    if (result.status !== 'search-lower-bound-replacement-required') {
      throw new Error('Expected replacement evidence');
    }
    expect(result.replacement.replacement).toEqual({ anchor: newAnchor(97n), nonce: 4n });
    expect(result.replacement.probes.map((probe) => probe.observation.nonce)).toEqual([5n, 4n]);
    expect(result.replacement.probes[0]!.parentHash).toBe(newAnchor(97n).blockHash);
    expect(result.replacement.invalidatedFact).toBeNull();
    expect(result.observations).toContainEqual(fixture.options.trigger.observedLower);
    expect(result.replacement.opening).toEqual(newAnchor(104n));
    expect(result.replacement.closing).toEqual(newAnchor(104n));
    expect(fixture.options.snapshot).toEqual(before);

    assertFrozen(result);
  });

  it('accepts the same height with a fresh nonce below the historical baseline', async () => {
    const fixture = setup();
    fixture.getTransactionCount.mockResolvedValue(3);
    const result = await fixture.run();
    expect(result.status).toBe('search-lower-bound-replacement-required');
    if (result.status === 'search-lower-bound-replacement-required') {
      expect(result.replacement.replacement).toEqual({ anchor: newAnchor(98n), nonce: 3n });
    }
    expect(fixture.getTransactionCount.mock.calls).toEqual([
      [{ address: SIGNER, blockNumber: 98n }],
    ]);
  });

  it.each([false, true])('enforces exactly eight probes; candidate found: %s', async (found) => {
    const fixture = setup(98n, 100n);
    fixture.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
      if (found && blockNumber === 91n) {
        return 4;
      }
      return 5;
    });
    const result = await fixture.run();
    expect(MAX_LOWER_BOUND_PROBES).toBe(8);
    expect(fixture.getTransactionCount.mock.calls.map(([request]) => request.blockNumber))
      .toEqual([98n, 97n, 96n, 95n, 94n, 93n, 92n, 91n]);
    if (found) {
      expect(result.status).toBe('search-lower-bound-replacement-required');
      expect(fixture.getBlock.mock.calls.length + fixture.getTransactionCount.mock.calls.length).toBe(27);
    } else {
      expect(result).toEqual({
        status: 'search-lower-bound-replacement-unavailable',
        reason: 'probe-budget-exhausted',
        observation: fixture.options.observation,
      });
      expect(fixture.getBlock.mock.calls.length + fixture.getTransactionCount.mock.calls.length).toBe(26);
    }
  });

  it.each([0n, 2n, 7n])('stops at genesis from %s without probing below zero', async (height) => {
    const fixture = setup(height);
    fixture.getTransactionCount.mockResolvedValue(5);
    expect(await fixture.run()).toEqual({
      status: 'search-lower-bound-replacement-unavailable',
      reason: 'no-unconsumed-candidate',
      observation: fixture.options.observation,
    });
    expect(fixture.getTransactionCount.mock.calls.map(([request]) => request.blockNumber))
      .toEqual(Array.from({ length: Number(height) + 1 }, (_, index) => height - BigInt(index)));
    expect(fixture.calls.at(-1)).toBe('header:104');
  });

  it('accepts an unconsumed genesis candidate', async () => {
    const fixture = setup(0n);
    fixture.getTransactionCount.mockResolvedValue(4);
    const result = await fixture.run();
    expect(result.status).toBe('search-lower-bound-replacement-required');
    if (result.status === 'search-lower-bound-replacement-required') {
      expect(result.replacement.replacement).toEqual({
        anchor: newAnchor(0n),
        nonce: 4n,
      });
    }
    expect(fixture.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it('lets an outer closing mismatch override exhausted probe budget', async () => {
    const fixture = setup();
    fixture.getTransactionCount.mockResolvedValue(5);
    const read = fixture.getBlock.getMockImplementation()!;
    let selectedReads = 0;
    fixture.getBlock.mockImplementation(async (request) => {
      const header = await read(request);
      if (request.blockNumber === 104n) {
        selectedReads += 1;
        if (selectedReads === 2) {
          return { ...header, hash: hashAt(999n) };
        }
      }
      return header;
    });
    expect(await fixture.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: { blockNumber: 104n, blockHash: hashAt(999n) },
    });
    expect(fixture.getTransactionCount).toHaveBeenCalledTimes(8);
  });

  it.each([100n, 104n])('confirms a changed fact at %s and reuses the selected opening', async (height) => {
    const fixture = setup(98n, height);
    const result = await fixture.run();
    expect(result.status).toBe('search-lower-bound-replacement-required');
    if (result.status === 'search-lower-bound-replacement-required') {
      expect(result.replacement.invalidatedFact).toEqual({
        fact: { anchor: oldAnchor(height), nonce: 5n },
        observedAnchor: newAnchor(height),
      });
      assertFrozen(result);
    }
    const factReads = fixture.getBlock.mock.calls.filter(([request]) => request.blockNumber === height);
    if (height === 104n) {
      expect(factReads).toHaveLength(2);
    } else {
      expect(factReads).toHaveLength(1);
      expect(fixture.calls.slice(-2)).toEqual(['header:100', 'header:104']);
    }
  });

  it.each(['same', 'case-only'] as const)('refuses a %s fact after closing', async (variant) => {
    const fixture = setup(98n, 100n);
    const factHash = `0x${'ab'.repeat(32)}` as const;
    fixture.options.snapshot = {
      ...fixture.options.snapshot,
      attempts: [{
        ...fixture.options.snapshot.attempts[0]!,
        replacementSearch: {
          ...fixture.options.snapshot.attempts[0]!.replacementSearch!,
          exhausted: {
            anchor: { blockNumber: 100n, blockHash: factHash },
            nonce: 5n,
          },
        },
      }],
    };
    const read = fixture.getBlock.getMockImplementation()!;
    fixture.getBlock.mockImplementation(async (request) => {
      const header = await read(request);
      if (request.blockNumber === 100n) {
        let hash: Hash = factHash;
        if (variant === 'case-only') {
          hash = `0x${hash.slice(2).toUpperCase()}`;
        }
        return { ...header, hash };
      }
      return header;
    });
    expect(await fixture.run()).toEqual({ status: 'inconsistent-observations', observation: fixture.options.observation });
    expect(fixture.calls.at(-1)).toBe('header:104');
  });

  it.each([
    { fault: 'trigger', nonceReads: 1 },
    { fault: 'stored-hash', nonceReads: 1 },
    { fault: 'parent', nonceReads: 2 },
    { fault: 'nonce-increase', nonceReads: 2 },
    { fault: 'nonce-above-durable', nonceReads: 1 },
  ] as const)(
    'refuses conflicting $fault evidence without trying another candidate',
    async ({ fault, nonceReads }) => {
      const fixture = setup();
      const read = fixture.getBlock.getMockImplementation()!;
      fixture.getBlock.mockImplementation(async (request) => {
        const header = await read(request);
        if (request.blockNumber === 98n) {
          if (fault === 'trigger') {
            return { ...header, hash: hashAt(999n) };
          }
          if (fault === 'stored-hash') {
            return { ...header, hash: oldAnchor(98n).blockHash };
          }
          if (fault === 'parent') {
            return { ...header, parentHash: hashAt(999n) };
          }
        }
        return header;
      });
      if (fault === 'nonce-increase') {
        fixture.options.observation.nonce = 7n;
        fixture.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
          fixture.calls.push(`nonce:${blockNumber}`);
          if (blockNumber === 98n) {
            return 5;
          }
          return 6;
        });
      }
      if (fault === 'nonce-above-durable') {
        fixture.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
          fixture.calls.push(`nonce:${blockNumber}`);
          return 6;
        });
      }
      expect(await fixture.run()).toEqual({ status: 'inconsistent-observations', observation: fixture.options.observation });
      expect(fixture.getTransactionCount).toHaveBeenCalledTimes(nonceReads);
      if (nonceReads === 1) {
        expect(fixture.calls).toEqual([
          'header:104',
          'header:98', 'nonce:98', 'header:98',
        ]);
      } else {
        expect(fixture.calls).toEqual([
          'header:104',
          'header:98', 'nonce:98', 'header:98',
          'header:97', 'nonce:97', 'header:97',
        ]);
      }
    },
  );

  it.each(['opening', 'candidate-hash', 'candidate-parent', 'closing', 'closing-with-matching-fact'] as const)(
    'refuses a changing %s bracket and publishes no evidence',
    async (fault) => {
      const fixture = setup(98n, 100n);
      const read = fixture.getBlock.getMockImplementation()!;
      const reads = new Map<bigint, number>();
      fixture.getBlock.mockImplementation(async (request) => {
        const header = await read(request);
        const count = (reads.get(request.blockNumber) ?? 0) + 1;
        reads.set(request.blockNumber, count);
        if (request.blockNumber === 104n && (
          (fault === 'opening' && count === 1) ||
          (fault.startsWith('closing') && count === 2)
        )) {
          return { ...header, hash: hashAt(999n) };
        }
        if (request.blockNumber === 98n && count === 2) {
          if (fault === 'candidate-hash') {
            return { ...header, hash: hashAt(999n) };
          }
          if (fault === 'candidate-parent') {
            return { ...header, parentHash: hashAt(999n) };
          }
        }
        if (request.blockNumber === 100n && fault === 'closing-with-matching-fact') {
          return { ...header, hash: oldAnchor(100n).blockHash };
        }
        return header;
      });
      const result = await fixture.run();
      if (fault === 'candidate-parent') {
        expect(result.status).toBe('inconsistent-observations');
      } else {
        expect(result.status).toBe('anchor-changed');
      }
      expect(result).not.toHaveProperty('observations');
      expect(result).not.toHaveProperty('replacement');
    },
  );

  it.each([98n, 97n, 100n, 104n])('merges earlier receipt/trigger evidence at %s', async (height) => {
    const fixture = setup(98n, 100n);
    const result = await repairSearchLowerBound({
      ...fixture.options,
      observations: [oldAnchor(height)],
    });
    expect(result).toEqual({ status: 'inconsistent-observations', observation: fixture.options.observation });
    expect(fixture.calls.at(-1)).toBe('header:104');
  });

  it.each(['opening', 'candidate', 'fact', 'closing', 'nonce'] as const)(
    'propagates %s RPC failures without a disposition',
    async (fault) => {
      const fixture = setup(98n, 100n);
      const failure = new Error('RPC failed');
      const read = fixture.getBlock.getMockImplementation()!;
      let selectedReads = 0;
      fixture.getBlock.mockImplementation(async (request) => {
        if (request.blockNumber === 104n) {
          selectedReads += 1;
        }
        if (
          (fault === 'opening' && selectedReads === 1 && request.blockNumber === 104n) ||
          (fault === 'closing' && selectedReads === 2) ||
          (fault === 'candidate' && request.blockNumber === 98n) ||
          (fault === 'fact' && request.blockNumber === 100n)
        ) {
          throw failure;
        }
        return read(request);
      });
      if (fault === 'nonce') {
        fixture.getTransactionCount.mockRejectedValue(failure);
      }
      await expect(fixture.run()).rejects.toBe(failure);
    },
  );

  it('refuses malformed historical nonces before the candidate closes', async () => {
    const fixture = setup();
    fixture.getTransactionCount.mockResolvedValue(-1);
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.getBlock.mock.calls).toHaveLength(2);
  });

  it('captures its inputs and withholds evidence while the outer closing is pending', async () => {
    const fixture = setup();
    const read = fixture.getBlock.getMockImplementation()!;
    let enterClosing!: () => void;
    const closingEntered = new Promise<void>((resolve) => {
      enterClosing = resolve;
    });
    let releaseClosing!: () => void;
    const closingReleased = new Promise<void>((resolve) => {
      releaseClosing = resolve;
    });
    let selectedReads = 0;
    let settled = false;

    fixture.getBlock.mockImplementation(async (request) => {
      if (request.blockNumber === 104n) {
        selectedReads += 1;
        if (selectedReads === 2) {
          enterClosing();
          await closingReleased;
        }
      }
      return read(request);
    });

    const pending = fixture.run().then((result) => {
      settled = true;
      return result;
    });
    await closingEntered;
    expect(settled).toBe(false);
    fixture.options.observation.nonce = 99n;
    fixture.options.trigger.lowerBound.nonce = 99n;
    fixture.options.trigger.observedLower.blockHash = hashAt(999n);
    releaseClosing();

    const result = await pending;
    expect(result.status).toBe('search-lower-bound-replacement-required');
    if (result.status === 'search-lower-bound-replacement-required') {
      expect(result.observation.nonce).toBe(5n);
      expect(result.replacement.trigger.lowerBound.nonce).toBe(4n);
      expect(result.replacement.trigger.observedLower).toEqual(newAnchor(98n));
      expect(result.replacement.replacement).toEqual({ anchor: newAnchor(97n), nonce: 4n });
    }
  });

  it('refuses a fact above the selected anchor before RPCs', async () => {
    const fixture = setup(98n, 105n);
    expect(await fixture.run()).toEqual({
      status: 'anchor-behind-exhaustion',
      anchor: newAnchor(104n),
      exhausted: { anchor: oldAnchor(105n), nonce: 5n },
    });
    expect(fixture.getBlock).not.toHaveBeenCalled();
  });

  it.each(['missing-search', 'unconsumed', 'floor', 'stale-bound'] as const)(
    'refuses %s input without probing',
    async (fault) => {
      const fixture = setup();
      if (fault === 'missing-search') {
        fixture.options.snapshot = {
          ...fixture.options.snapshot,
          attempts: [{
            ...fixture.options.snapshot.attempts[0]!,
            replacementSearch: null,
          }],
        };
      }
      if (fault === 'unconsumed') {
        fixture.options.observation.nonce = 4n;
      }
      if (fault === 'floor') {
        fixture.options.observation.nonce = 3n;
      }
      if (fault === 'stale-bound') {
        fixture.options.trigger.lowerBound = {
          anchor: oldAnchor(98n),
          nonce: 3n,
        };
      }
      const result = await fixture.run();
      if (fault === 'floor') {
        expect(result.status).toBe('nonce-behind-journal');
      } else {
        expect(result.status).toBe('inconsistent-observations');
      }
      expect(fixture.getBlock).not.toHaveBeenCalled();
    },
  );
});
