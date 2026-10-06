import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  JournalPersistence,
  type JournalPersistenceState,
} from '../../src/state/journal-persistence.js';

import {
  evaluateSignerGate,
  type CoordinatorBlocker,
} from '../../src/state/signer-gate.js';

import type {
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

// Public test fixture only.
const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

function emptySnapshot(): TransactionJournalSnapshot {
  const observation = {
    anchor: {
      blockNumber: 100n,
      blockHash: HASH,
    },
    nonce: 4n,
  };

  return {
    version: 1,
    identity: { ...IDENTITY },
    baseline: observation,
    lastObservation: observation,
    nextNonce: 4n,
    durableNextNonce: 4n,
    attempts: [],
  };
}

async function unresolvedSnapshot(): Promise<TransactionJournalSnapshot> {
  const signedTransaction = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: IDENTITY.chainId,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    value: 0n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  return {
    ...emptySnapshot(),
    nextNonce: 5n,
    attempts: [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      signedTransactions: [{
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      }],
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      replacementSearch: null,
    }],
  };
}

async function includedSnapshot(): Promise<TransactionJournalSnapshot> {
  const snapshot = await unresolvedSnapshot();
  const attempt = snapshot.attempts[0]!;

  const anchor = {
    blockNumber: 110n,
    blockHash: HASH,
  };

  return {
    ...snapshot,
    lastObservation: {
      anchor,
      nonce: 5n,
    },
    attempts: [{
      ...attempt,
      phase: 'included',
      inclusion: {
        outcome: 'success',
        transactionHash:
          attempt.signedTransactions[0].transactionHash,
        inclusion: anchor,
        observedAt: anchor,
      },
    }],
  };
}

function present(
  snapshot: TransactionJournalSnapshot,
  state: JournalPersistenceState = 'idle',
) {
  return {
    state,
    current: {
      kind: 'present' as const,
      snapshot,
    },
  };
}

describe('signer gate', () => {
  it('opens only after recovery with idle persistence and no blockers', () => {
    const persistence = present(emptySnapshot());

    expect(evaluateSignerGate({
      persistence,
      recoveryComplete: false,
      blockers: new Set(),
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: ['recovery-incomplete'],
      primaryReason: 'recovery-incomplete',
    });

    expect(evaluateSignerGate({
      persistence,
      recoveryComplete: true,
      blockers: new Set(),
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: true,
      blockers: [],
      primaryReason: null,
    });
  });

  it('closes during a normal write without claiming a failure', () => {
    expect(evaluateSignerGate({
      persistence: present(emptySnapshot(), 'writing'),
      recoveryComplete: true,
      blockers: new Set(),
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: [],
      primaryReason: null,
    });
  });

  it('blocks missing state even when recovery is marked complete', () => {
    expect(evaluateSignerGate({
      persistence: {
        state: 'idle',
        current: {
          kind: 'missing',
        },
      },
      recoveryComplete: true,
      blockers: new Set(),
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: ['recovery-incomplete'],
      primaryReason: 'recovery-incomplete',
    });
  });

  it('derives the unresolved blocker from the recorded attempt', async () => {
    expect(evaluateSignerGate({
      persistence: present(await unresolvedSnapshot()),
      recoveryComplete: true,
      blockers: new Set(),
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: ['unresolved-attempt'],
      primaryReason: 'unresolved-attempt',
    });
  });

  it.each([
    'unattributed-signer-activity',
    'conflict-search-exhausted',
  ] as const)('honors coordinator blocker %s', (reason) => {
    expect(evaluateSignerGate({
      persistence: present(emptySnapshot()),
      recoveryComplete: true,
      blockers: new Set([reason]),
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: [reason],
      primaryReason: reason,
    });
  });

  it('uses deterministic precedence regardless of insertion order', async () => {
    const snapshot = await unresolvedSnapshot();

    for (const reasons of [
      [
        'unattributed-signer-activity',
        'conflict-search-exhausted',
      ],
      [
        'conflict-search-exhausted',
        'unattributed-signer-activity',
      ],
    ] as const) {
      expect(evaluateSignerGate({
        persistence: present(snapshot, 'failed'),
        recoveryComplete: true,
        blockers: new Set<CoordinatorBlocker>(reasons),
        inclusionChecksComplete: true,
        maxRetainedAttempts: 2,
      })).toEqual({
        open: false,
        blockers: [
          'persistence-failure',
          'unattributed-signer-activity',
          'conflict-search-exhausted',
          'unresolved-attempt',
        ],
        primaryReason: 'persistence-failure',
      });
    }
  });

  it('search progress can remove exhaustion without releasing an attempt', async () => {
    const blockers = new Set<CoordinatorBlocker>([
      'conflict-search-exhausted',
    ]);

    const persistence = present(await unresolvedSnapshot());

    expect(evaluateSignerGate({
      persistence,
      recoveryComplete: true,
      blockers,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    }).primaryReason).toBe('conflict-search-exhausted');

    blockers.delete('conflict-search-exhausted');

    expect(evaluateSignerGate({
      persistence,
      recoveryComplete: true,
      blockers,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: ['unresolved-attempt'],
      primaryReason: 'unresolved-attempt',
    });
  });

  it('returns a frozen decision detached from the supplied set', () => {
    const blockers = new Set<CoordinatorBlocker>([
      'unattributed-signer-activity',
    ]);

    const decision = evaluateSignerGate({
      persistence: present(emptySnapshot()),
      recoveryComplete: true,
      blockers,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    });

    blockers.clear();

    expect(decision.blockers).toEqual([
      'unattributed-signer-activity',
    ]);

    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.blockers)).toBe(true);
  });

  it('stays closed through a failed clear and respects remaining blockers', async () => {
    const snapshot = await unresolvedSnapshot();

    const cleared: TransactionJournalSnapshot = {
      ...snapshot,
      lastObservation: {
        anchor: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        nonce: 5n,
      },
      nextNonce: 5n,
      durableNextNonce: 5n,
      attempts: [],
    };

    let visible: TransactionJournalRead = {
      kind: 'present',
      snapshot,
    };

    const load = vi.fn<TransactionJournalStore['load']>(
      async () => visible,
    );

    const save = vi.fn<TransactionJournalStore['save']>()
      .mockImplementationOnce(async (candidate) => {
        visible = {
          kind: 'present',
          snapshot: candidate,
        };

        throw new Error('Injected failure after replacement.');
      })
      .mockResolvedValue(undefined);

    const persistence = await JournalPersistence.create({
      store: { load, save },
      identity: IDENTITY,
      initial: visible,
    });

    const blockers = new Set<CoordinatorBlocker>([
      'unattributed-signer-activity',
    ]);

    await expect(persistence.save(cleared))
      .rejects.toThrow('The pending snapshot must be retried.');

    expect(visible).toEqual({
      kind: 'present',
      snapshot: cleared,
    });

    expect(evaluateSignerGate({
      persistence,
      recoveryComplete: true,
      blockers,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: [
        'persistence-failure',
        'unattributed-signer-activity',
        'unresolved-attempt',
      ],
      primaryReason: 'persistence-failure',
    });

    await persistence.retry();

    expect(evaluateSignerGate({
      persistence,
      recoveryComplete: true,
      blockers,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
    })).toEqual({
      open: false,
      blockers: ['unattributed-signer-activity'],
      primaryReason: 'unattributed-signer-activity',
    });

    expect(load).not.toHaveBeenCalled();
  });

  it('allows preparation with retained inclusion after a clean recheck', async () => {
    expect(evaluateSignerGate({
      persistence: present(await includedSnapshot()),
      recoveryComplete: true,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
      blockers: new Set(),
    })).toEqual({
      open: true,
      blockers: [],
      primaryReason: null,
    });
  });

  it('does not authorize preparation from persisted inclusion alone', async () => {
    expect(evaluateSignerGate({
      persistence: present(await includedSnapshot()),
      recoveryComplete: true,
      inclusionChecksComplete: false,
      maxRetainedAttempts: 2,
      blockers: new Set(),
    })).toEqual({
      open: false,
      blockers: ['recovery-incomplete'],
      primaryReason: 'recovery-incomplete',
    });
  });

  it('blocks at capacity even when every retained attempt is included', async () => {
    expect(evaluateSignerGate({
      persistence: present(await includedSnapshot()),
      recoveryComplete: true,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 1,
      blockers: new Set(),
    })).toEqual({
      open: false,
      blockers: ['journal-capacity-reached'],
      primaryReason: 'journal-capacity-reached',
    });
  });

  it('reports unresolved attempts before capacity', async () => {
    expect(evaluateSignerGate({
      persistence: present(await unresolvedSnapshot()),
      recoveryComplete: true,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 1,
      blockers: new Set(),
    })).toEqual({
      open: false,
      blockers: [
        'unresolved-attempt',
        'journal-capacity-reached',
      ],
      primaryReason: 'unresolved-attempt',
    });
  });

  it('blocks a signed attempt before any broadcast', async () => {
    const snapshot = await unresolvedSnapshot();

    const signed: TransactionJournalSnapshot = {
      ...snapshot,
      attempts: [{
        ...snapshot.attempts[0]!,
        phase: 'signed',
        inclusion: null,
      }],
    };

    expect(evaluateSignerGate({
      persistence: present(signed),
      recoveryComplete: true,
      inclusionChecksComplete: true,
      maxRetainedAttempts: 2,
      blockers: new Set(),
    }).blockers).toEqual(['unresolved-attempt']);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects invalid retained capacity: %s',
    (maxRetainedAttempts) => {
      expect(() => evaluateSignerGate({
        persistence: present(emptySnapshot()),
        recoveryComplete: true,
        inclusionChecksComplete: true,
        maxRetainedAttempts,
        blockers: new Set(),
      })).toThrow('Invalid retained attempt capacity.');
    },
  );
});