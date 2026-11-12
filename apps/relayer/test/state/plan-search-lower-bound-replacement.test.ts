import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  keccak256,
  type Hash,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import type {
  LowerBoundRepairResult,
} from '../../src/chain/repair-search-lower-bound.js';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import type {
  JournalAttempt,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

type RequiredReplacement = Extract<
  LowerBoundRepairResult,
  { status: 'search-lower-bound-replacement-required' }
>;

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const IDENTITY = { chainId: 4663, signer: ACCOUNT.address };

function anchor(height: bigint, fork = false) {
  let hashNumber = height;
  if (fork) {
    hashNumber += 10_000n;
  }
  return {
    blockNumber: height,
    blockHash: `0x${hashNumber.toString(16).padStart(64, '0')}` as Hash,
  };
}

async function setup(withFact = true) {
  const attempts: JournalAttempt[] = [];
  for (const nonce of [4, 5]) {
    const signedTransaction = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: IDENTITY.chainId,
      nonce,
      gas: 21_000n,
      to: ACCOUNT.address,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    let exhausted = null;
    if (withFact || nonce === 5) {
      exhausted = { anchor: anchor(100n), nonce: BigInt(nonce + 1) };
    }
    attempts.push({
      attemptId: `11111111-1111-4111-8111-11111111111${nonce}`,
      workId: `test-work:${nonce}`,
      nonce: BigInt(nonce),
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      signedTransactions: [{
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      }],
      replacementSearch: {
        lowerBound: { anchor: anchor(98n), nonce: 4n },
        searchedThrough: anchor(100n),
        exhausted,
      },
    });
  }
  const original: TransactionJournalSnapshot = {
    version: 1,
    identity: IDENTITY,
    baseline: { anchor: anchor(98n), nonce: 4n },
    lastObservation: { anchor: anchor(130n), nonce: 9n },
    nextNonce: 6n,
    durableNextNonce: 4n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts,
  };
  const snapshot = structuredClone(original) as Mutable<TransactionJournalSnapshot>;
  let invalidatedFact = null;
  if (withFact) {
    invalidatedFact = {
      fact: { anchor: anchor(100n), nonce: 5n },
      observedAnchor: anchor(100n, true),
    };
  }
  const input: RequiredReplacement = {
    status: 'search-lower-bound-replacement-required',
    attemptId: snapshot.attempts[0]!.attemptId,
    observation: { anchor: anchor(104n, true), nonce: 6n },
    observations: [anchor(98n, true), anchor(104n, true), anchor(97n), anchor(104n, true)],
    replacement: {
      trigger: {
        durableAnchor: anchor(104n, true),
        lowerBound: { anchor: anchor(98n), nonce: 4n },
        observedLower: anchor(98n, true),
      },
      opening: anchor(104n, true),
      closing: anchor(104n, true),
      probes: [
        {
          status: 'verified',
          observation: { anchor: anchor(98n, true), nonce: 5n },
          parentHash: anchor(97n).blockHash,
        },
        {
          status: 'verified',
          observation: { anchor: anchor(97n), nonce: 3n },
          parentHash: anchor(96n).blockHash,
        },
      ],
      replacement: { anchor: anchor(97n), nonce: 3n },
      invalidatedFact,
    },
  };
  const inspection = structuredClone(input) as Mutable<RequiredReplacement>;
  if (withFact) {
    inspection.observations.push(anchor(100n, true));
  }
  return {
    snapshot,
    inspection,
    plan: (activity = false) => planSignerRecovery({
      identity: IDENTITY,
      snapshot,
      inspection,
      unattributedActivity: activity,
    }),
  };
}

function assertFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) {
      assertFrozen(child);
    }
  }
}

function setProbeWalk(inspection: Mutable<RequiredReplacement>, count: number): void {
  const evidence = inspection.replacement;
  evidence.probes = [];
  inspection.observations = [evidence.opening, evidence.closing];
  if (evidence.invalidatedFact !== null) {
    inspection.observations.push(evidence.invalidatedFact.observedAnchor);
  }
  for (let index = 0; index < count; index += 1) {
    const height = 98n - BigInt(index);
    let nonce = 5n;
    if (index === count - 1) {
      nonce = 3n;
    }
    const observation = { anchor: anchor(height, index === 0), nonce };
    evidence.probes.push({
      status: 'verified',
      observation,
      parentHash: anchor(height - 1n).blockHash,
    });
    inspection.observations.push(observation.anchor);
  }
  evidence.replacement = structuredClone(evidence.probes.at(-1)!.observation);
}

describe('lower-bound replacement planning', () => {
  it.each([
    { name: 'oldest fact at selected height', later: false, conflict: false },
    { name: 'both facts contradicted at selected height', later: true, conflict: false },
    { name: 'fact observation differs from opening', later: false, conflict: true },
  ])('$name', async ({ later, conflict }) => {
    const fixture = await setup();
    const fact = { anchor: anchor(104n), nonce: 6n };
    fixture.snapshot.attempts[0]!.replacementSearch!.exhausted = fact;
    if (later) {
      fixture.snapshot.attempts[1]!.replacementSearch!.exhausted = structuredClone(fact);
    }
    let observedAnchor = anchor(104n, true);
    if (conflict) {
      observedAnchor = { ...observedAnchor, blockHash: anchor(999n).blockHash };
    }
    fixture.inspection.replacement.invalidatedFact = { fact, observedAnchor };
    fixture.inspection.observations.push(observedAnchor);
    const before = structuredClone(fixture.snapshot);
    const result = fixture.plan();
    if (conflict) {
      expect(result).toEqual({ kind: 'unchanged', reason: 'inspection-not-committable' });
    } else {
      expect(result.kind).toBe('persist');
      if (result.kind !== 'persist') {
        throw new Error('Expected replacement plan');
      }
      expect(result.snapshot.attempts[0]!.replacementSearch!.exhausted).toBeNull();
      expect(result.snapshot.attempts[1]).toEqual(before.attempts[1]);
    }
    expect(fixture.snapshot).toEqual(before);
  });

  it.each([
    { fact: false, preserve: false },
    { fact: false, preserve: true },
    { fact: true, preserve: false },
    { fact: true, preserve: true },
  ])('plans the exact oldest-only correction: %j', async ({ fact, preserve }) => {
    const fixture = await setup(fact);
    const before = structuredClone(fixture.snapshot);
    const evidenceBefore = structuredClone(fixture.inspection);
    const result = fixture.plan(preserve);
    expect(result.kind).toBe('persist');
    if (result.kind !== 'persist') {
      throw new Error('Expected a replacement plan');
    }
    let lastObservation = fixture.inspection.observation;
    if (preserve) {
      lastObservation = fixture.snapshot.lastObservation;
    }
    expect(result.snapshot).toEqual({
      ...before,
      lastObservation,
      attempts: [{
        ...before.attempts[0]!,
        replacementSearch: {
          lowerBound: fixture.inspection.replacement.replacement,
          searchedThrough: null,
          exhausted: null,
        },
      }, before.attempts[1]!],
    });
    expect(result.completion).toEqual({
      kind: 'search-lower-bound-replacement',
      event: {
        signer: IDENTITY.signer,
        attemptId: before.attempts[0]!.attemptId,
        nonce: 4n,
        oldLowerBound: fixture.inspection.replacement.trigger.lowerBound,
        observedLower: fixture.inspection.replacement.trigger.observedLower,
        replacement: fixture.inspection.replacement.replacement,
        durableObservation: fixture.inspection.observation,
        probeCount: 2,
        invalidatedFact: fixture.inspection.replacement.invalidatedFact,
      },
    });
    expect(fixture.snapshot).toEqual(before);
    expect(fixture.inspection).toEqual(evidenceBefore);
    assertFrozen(result.snapshot);
    assertFrozen(result.completion);

    const planned = structuredClone(result);
    fixture.inspection.replacement.probes.pop();
    fixture.inspection.replacement.replacement.nonce = 99n;
    fixture.inspection.observation.nonce = 99n;
    fixture.snapshot.lastObservation.nonce = 99n;
    expect(result).toEqual(planned);
  });

  it('accepts the first candidate at the old height and discards an independent cursor', async () => {
    const fixture = await setup(false);
    const evidence = fixture.inspection.replacement;
    evidence.probes = [evidence.probes[0]!];
    evidence.probes[0]!.observation.nonce = 4n;
    evidence.replacement = structuredClone(evidence.probes[0]!.observation);
    fixture.snapshot.attempts[0]!.replacementSearch!.searchedThrough = anchor(102n);
    const result = fixture.plan();
    expect(result.kind).toBe('persist');
    if (result.kind === 'persist') {
      expect(result.snapshot.attempts[0]!.replacementSearch).toEqual({
        lowerBound: evidence.replacement,
        searchedThrough: null,
        exhausted: null,
      });
    }
  });

  it('keeps an included phase and inclusion byte-for-byte', async () => {
    const fixture = await setup();
    const oldest = fixture.snapshot.attempts[0]!;
    fixture.snapshot.attempts[0] = {
      ...oldest,
      phase: 'included',
      inclusion: {
        outcome: 'success',
        transactionHash: oldest.signedTransactions[0].transactionHash,
        inclusion: anchor(102n),
        observedAt: anchor(130n),
      },
    };
    const result = fixture.plan();
    expect(result.kind).toBe('persist');
    if (result.kind === 'persist') {
      expect(result.snapshot.attempts[0]!.phase).toBe('included');
      expect(result.snapshot.attempts[0]!.inclusion).toEqual(fixture.snapshot.attempts[0]!.inclusion);
    }
  });

  it('accepts a complete eight-probe walk', async () => {
    const fixture = await setup();
    setProbeWalk(fixture.inspection, 8);
    const result = fixture.plan();
    expect(result.kind).toBe('persist');
    if (result.kind === 'persist') {
      expect(result.snapshot.attempts[0]!.replacementSearch!.lowerBound).toEqual({
        anchor: anchor(91n),
        nonce: 3n,
      });
    }
  });

  it('compares persisted fact and lower-bound hashes case-insensitively', async () => {
    const fixture = await setup();
    const lowerHash = `0x${'ab'.repeat(32)}` as const;
    const factHash = `0x${'cd'.repeat(32)}` as const;
    fixture.snapshot.attempts[0]!.replacementSearch!.lowerBound.anchor.blockHash = lowerHash;
    fixture.snapshot.attempts[0]!.replacementSearch!.exhausted!.anchor.blockHash = factHash;
    fixture.inspection.replacement.trigger.lowerBound.anchor.blockHash = `0x${lowerHash.slice(2).toUpperCase()}`;
    fixture.inspection.replacement.invalidatedFact!.fact.anchor.blockHash = `0x${factHash.slice(2).toUpperCase()}`;
    expect(fixture.plan().kind).toBe('persist');
  });

  it.each([
    'target', 'removed-target', 'missing-search', 'old-lower-hash', 'old-lower-nonce',
    'stored-fact-hash', 'stored-fact-nonce', 'removed-fact', 'added-fact', 'missing-invalidation',
    'fact-observed-height', 'fact-still-matches', 'later-fact-above', 'later-fact-nonce',
    'later-contradicted-fact', 'unconsumed-durable', 'durable-below-floor',
    'trigger-anchor', 'opening', 'closing', 'trigger-old-height', 'trigger-old-hash',
    'empty-probes', 'ninth-probe', 'skipped-height', 'duplicate-height', 'negative-height',
    'parent', 'malformed-parent', 'first-trigger-disagreement', 'nonce-increase',
    'nonce-above-durable', 'earlier-unconsumed', 'last-consumed', 'last-nonce', 'last-hash',
    'malformed-nonce', 'missing-probe-header', 'missing-fact-header', 'missing-selected-header',
    'conflicting-header', 'above-durable-header', 'malformed-header',
  ] as const)('refuses %s evidence before preservation', async (fault) => {
    const fixture = await setup(fault !== 'added-fact');
    const snapshot = fixture.snapshot;
    const inspection = fixture.inspection;
    const evidence = inspection.replacement;
    const search = snapshot.attempts[0]!.replacementSearch!;

    switch (fault) {
      case 'target':
        inspection.attemptId = snapshot.attempts[1]!.attemptId;
        break;
      case 'removed-target':
        snapshot.attempts.shift();
        snapshot.durableNextNonce = 5n;
        break;
      case 'missing-search':
        snapshot.attempts[0]!.replacementSearch = null;
        break;
      case 'old-lower-hash':
        search.lowerBound.anchor = anchor(98n, true);
        break;
      case 'old-lower-nonce':
        search.lowerBound.nonce = 3n;
        break;
      case 'stored-fact-hash':
        search.exhausted!.anchor = anchor(100n, true);
        break;
      case 'stored-fact-nonce':
        search.exhausted!.nonce = 6n;
        break;
      case 'removed-fact':
        search.exhausted = null;
        break;
      case 'added-fact':
        search.exhausted = { anchor: anchor(100n), nonce: 5n };
        break;
      case 'missing-invalidation':
        evidence.invalidatedFact = null;
        break;
      case 'fact-observed-height':
        evidence.invalidatedFact!.observedAnchor = anchor(101n, true);
        break;
      case 'fact-still-matches':
        evidence.invalidatedFact!.observedAnchor = anchor(100n);
        break;
      case 'later-fact-above':
        snapshot.attempts[1]!.replacementSearch!.exhausted!.anchor = anchor(105n);
        break;
      case 'later-fact-nonce':
        snapshot.attempts[1]!.replacementSearch!.exhausted = { anchor: anchor(104n, true), nonce: 7n };
        break;
      case 'later-contradicted-fact':
        snapshot.attempts[1]!.replacementSearch!.exhausted!.anchor = anchor(104n);
        break;
      case 'unconsumed-durable':
        inspection.observation.nonce = 4n;
        break;
      case 'durable-below-floor':
        inspection.observation.nonce = 3n;
        break;
      case 'trigger-anchor':
        evidence.trigger.durableAnchor = anchor(104n);
        break;
      case 'opening':
        evidence.opening = anchor(104n);
        break;
      case 'closing':
        evidence.closing = anchor(104n);
        break;
      case 'trigger-old-height':
        evidence.trigger.observedLower = anchor(99n, true);
        break;
      case 'trigger-old-hash':
        evidence.trigger.observedLower = anchor(98n);
        break;
      case 'empty-probes':
        evidence.probes = [];
        break;
      case 'ninth-probe':
        setProbeWalk(inspection, 9);
        break;
      case 'skipped-height':
        evidence.probes[1]!.observation.anchor = anchor(96n);
        break;
      case 'duplicate-height':
        evidence.probes[1]!.observation.anchor = anchor(98n, true);
        break;
      case 'negative-height':
        evidence.probes[1]!.observation.anchor.blockNumber = -1n;
        break;
      case 'parent':
        evidence.probes[0]!.parentHash = anchor(96n).blockHash;
        break;
      case 'malformed-parent':
        evidence.probes[0]!.parentHash = '0x00';
        break;
      case 'first-trigger-disagreement':
        evidence.probes[0]!.observation.anchor = anchor(98n);
        break;
      case 'nonce-increase':
        setProbeWalk(inspection, 3);
        evidence.probes[1]!.observation.nonce = 6n;
        break;
      case 'nonce-above-durable':
        evidence.probes[0]!.observation.nonce = 7n;
        break;
      case 'earlier-unconsumed':
        evidence.probes[0]!.observation.nonce = 4n;
        break;
      case 'last-consumed':
        evidence.probes[1]!.observation.nonce = 5n;
        evidence.replacement.nonce = 5n;
        break;
      case 'last-nonce':
        evidence.replacement.nonce = 4n;
        break;
      case 'last-hash':
        evidence.replacement.anchor = anchor(97n, true);
        break;
      case 'malformed-nonce':
        evidence.probes[1]!.observation.nonce = -1n;
        break;
      case 'missing-probe-header':
        inspection.observations = inspection.observations.filter(
          (header) => header.blockNumber !== 97n,
        );
        break;
      case 'missing-fact-header':
        inspection.observations = inspection.observations.filter(
          (header) => header.blockNumber !== 100n,
        );
        break;
      case 'missing-selected-header':
        inspection.observations = inspection.observations.filter(
          (header) => header.blockNumber !== 104n,
        );
        break;
      case 'conflicting-header':
        inspection.observations.push(anchor(98n));
        break;
      case 'above-durable-header':
        inspection.observations.push(anchor(105n));
        break;
      case 'malformed-header':
        inspection.observations.push({ blockNumber: 99n, blockHash: '0x00' });
        break;
    }

    const before = structuredClone(snapshot);
    const evidenceBefore = structuredClone(inspection);
    expect(fixture.plan(true)).toEqual({ kind: 'unchanged', reason: 'inspection-not-committable' });
    expect(snapshot).toEqual(before);
    expect(inspection).toEqual(evidenceBefore);
  });
});
