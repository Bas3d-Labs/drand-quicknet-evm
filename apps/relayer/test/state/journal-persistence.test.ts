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
} from '../../src/state/journal-persistence.js';

import type {
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

import {
  broadcastAttempt,
} from '../helpers/journal-attempt.js';

// Public test fixture only.
const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });

  return {
    promise,
    resolve,
  };
}

async function fixture(): Promise<TransactionJournalSnapshot> {
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
    nextNonce: 5n,
    durableNextNonce: 4n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts: [
      broadcastAttempt({
        attemptId: '11111111-1111-4111-8111-111111111111',
        workId: 'test-work:4',
        nonce: 4n,
        signedTransactions: [{
          transactionHash: keccak256(signedTransaction),
          signedTransaction,
        }],
      }),
    ],
  };
}

function cleared(snapshot: TransactionJournalSnapshot) {
  return {
    ...snapshot,
    lastObservation: {
      anchor: {
        blockNumber: 110n,
        blockHash: HASH,
      },
      nonce: snapshot.nextNonce,
    },
    durableNextNonce: snapshot.nextNonce,
    attempts: [],
  };
}

async function setup() {
  const snapshot = await fixture();

  const load = vi.fn<TransactionJournalStore['load']>();
  const save = vi.fn<TransactionJournalStore['save']>()
    .mockResolvedValue(undefined);

  const persistence = await JournalPersistence.create({
    store: { load, save },
    identity: IDENTITY,
    initial: {
      kind: 'present',
      snapshot,
    },
  });

  return {
    snapshot,
    persistence,
    load,
    save,
  };
}

describe('journal persistence latch', () => {
  it('preserves missing state without creating a baseline', async () => {
    const load = vi.fn<TransactionJournalStore['load']>();
    const save = vi.fn<TransactionJournalStore['save']>();

    const persistence = await JournalPersistence.create({
      store: { load, save },
      identity: IDENTITY,
      initial: {
        kind: 'missing',
      },
    });

    expect(persistence.current).toEqual({ kind: 'missing' });
    expect(persistence.state).toBe('idle');
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('publishes a clear only after the save succeeds', async () => {
    const { persistence, snapshot, save } = await setup();
    const next = cleared(snapshot);
    const entered = deferred();
    const finish = deferred();

    save.mockImplementationOnce(() => {
      entered.resolve();
      return finish.promise;
    });

    const pending = persistence.save(next);

    try {
      expect(persistence.state).toBe('writing');

      await entered.promise;

      expect(persistence.current).toEqual({
        kind: 'present',
        snapshot,
      });
    } finally {
      finish.resolve();
      await pending;
    }

    expect(persistence.state).toBe('idle');
    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot: next,
    });
  });

  it('retains the attempt when a failed clear is visible in storage', async () => {
    const { persistence, snapshot, load, save } = await setup();
    const next = cleared(snapshot);

    let visible: TransactionJournalRead = {
      kind: 'present',
      snapshot,
    };

    load.mockImplementation(async () => visible);

    save.mockImplementationOnce(async (candidate) => {
      visible = {
        kind: 'present',
        snapshot: candidate,
      };

      throw new Error('Injected failure after replacement.');
    });

    await expect(persistence.save(next))
      .rejects.toThrow('The pending snapshot must be retried.');

    expect(visible).toEqual({
      kind: 'present',
      snapshot: next,
    });

    expect(persistence.state).toBe('failed');
    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot,
    });

    await expect(persistence.save(next))
      .rejects.toThrow('not ready for a new write');

    expect(save).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();

    await persistence.retry();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toBe(save.mock.calls[0]![0]);

    expect(persistence.state).toBe('idle');
    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot: next,
    });

    expect(load).not.toHaveBeenCalled();
  });

  it('retains the same pending snapshot through repeated failures', async () => {
    const { persistence, snapshot, save } = await setup();
    const next = cleared(snapshot);

    save.mockRejectedValueOnce(new Error('First failure.'));
    save.mockRejectedValueOnce(new Error('Second failure.'));

    await expect(persistence.save(next))
      .rejects.toThrow('The pending snapshot must be retried.');

    // Mutation of the caller's candidate cannot change a retained retry.
    next.nextNonce = 99n;

    await expect(persistence.retry())
      .rejects.toThrow('The pending snapshot must be retried.');

    expect(persistence.state).toBe('failed');
    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot,
    });

    await persistence.retry();

    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[1]![0]).toBe(save.mock.calls[0]![0]);
    expect(save.mock.calls[2]![0]).toBe(save.mock.calls[0]![0]);
    expect(save.mock.calls[2]![0].nextNonce).toBe(5n);
    expect(persistence.state).toBe('idle');
  });

  it('rejects overlapping writes and retries', async () => {
    const { persistence, snapshot, save } = await setup();
    const entered = deferred();
    const finish = deferred();

    save.mockImplementationOnce(() => {
      entered.resolve();
      return finish.promise;
    });

    const pending = persistence.save(cleared(snapshot));

    try {
      await entered.promise;

      await expect(persistence.save(snapshot))
        .rejects.toThrow('not ready for a new write');

      await expect(persistence.retry())
        .rejects.toThrow('No failed journal write');
    } finally {
      finish.resolve();
      await pending;
    }

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not latch a validation failure before storage is called', async () => {
    const { persistence, snapshot, save } = await setup();

    const invalid: TransactionJournalSnapshot = {
      ...snapshot,
      attempts: [{
        ...snapshot.attempts[0]!,
        signedTransactions: [{
          ...snapshot.attempts[0]!.signedTransactions[0],
          transactionHash: `0x${'00'.repeat(32)}`,
        }],
      }],
    };

    await expect(persistence.save(invalid))
      .rejects.toThrow('Invalid journal persistence snapshot.');

    expect(persistence.state).toBe('idle');
    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot,
    });

    expect(save).not.toHaveBeenCalled();
  });

  it('rejects retry when no write failed', async () => {
    const { persistence, save } = await setup();

    await expect(persistence.retry())
      .rejects.toThrow('No failed journal write');

    expect(save).not.toHaveBeenCalled();
  });

  it('retains the full queue until a failed prefix removal is retried', async () => {
    const first = await fixture();

    const bytes = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: IDENTITY.chainId,
      nonce: 5,
      gas: 21_000n,
      to: ACCOUNT.address,
      value: 0n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    const second = {
      ...first.attempts[0]!,
      attemptId: '22222222-2222-4222-8222-222222222222',
      workId: 'test-work:5',
      nonce: 5n,
      signedTransactions: [{
        transactionHash: keccak256(bytes),
        signedTransaction: bytes,
      }] as const,
    };

    const snapshot: TransactionJournalSnapshot = {
      ...first,
      nextNonce: 6n,
      attempts: [first.attempts[0]!, second],
    };

    const next: TransactionJournalSnapshot = {
      ...snapshot,
      durableNextNonce: 5n,
      lastObservation: {
        anchor: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        nonce: 5n,
      },
      attempts: [second],
    };

    let visible: TransactionJournalRead = {
      kind: 'present',
      snapshot,
    };

    const load = vi.fn<TransactionJournalStore['load']>()
      .mockImplementation(async () => visible);

    const save = vi.fn<TransactionJournalStore['save']>()
      .mockResolvedValue(undefined);

    const persistence = await JournalPersistence.create({
      store: { load, save },
      identity: IDENTITY,
      initial: visible,
    });

    save.mockImplementationOnce(async (candidate) => {
      visible = {
        kind: 'present',
        snapshot: candidate,
      };

      throw new Error('Injected failure after replacement.');
    });

    await expect(persistence.save(next))
      .rejects.toThrow('The pending snapshot must be retried.');

    expect(visible).toEqual({
      kind: 'present',
      snapshot: next,
    });

    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot,
    });
    expect(persistence.state).toBe('failed');

    await persistence.retry();

    expect(save.mock.calls[1]![0]).toBe(save.mock.calls[0]![0]);
    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot: next,
    });
    expect(persistence.state).toBe('idle');
    expect(load).not.toHaveBeenCalled();
  });

  it('reads failed preparation identity from the pending snapshot', async () => {
    const fixtureSnapshot = await fixture();

    const prepared: TransactionJournalSnapshot = {
      ...fixtureSnapshot,
      attempts: [{
        ...fixtureSnapshot.attempts[0]!,
        phase: 'signed',
        inclusion: null,
      }],
    };

    const initial: TransactionJournalSnapshot = {
      ...prepared,
      nextNonce: 4n,
      attempts: [],
    };

    let visibleSnapshot = initial;
    const visible = () => visibleSnapshot;

    const load = vi.fn<TransactionJournalStore['load']>();
    const save = vi.fn<TransactionJournalStore['save']>()
      .mockResolvedValue(undefined);

    const persistence = await JournalPersistence.create({
      identity: IDENTITY,
      store: { load, save },
      initial: {
        kind: 'present',
        snapshot: initial,
      },
    });

    const workId = prepared.attempts[0]!.workId;

    expect(persistence.failedWriteAttemptIdentity(workId))
      .toBeUndefined();

    save.mockImplementationOnce(async (snapshot) => {
      visibleSnapshot = snapshot;
      throw new Error('Injected failure after replacement.');
    });

    await expect(persistence.save(prepared))
      .rejects.toThrow('Journal persistence did not complete.');

    const visibleAttempt = visible().attempts[0]!;
    const captured = persistence.failedWriteAttemptIdentity(workId);

    expect(captured).toEqual({
      workId: visibleAttempt.workId,
      attemptId: visibleAttempt.attemptId,
    });
    expect(Object.isFrozen(captured)).toBe(true);

    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot: initial,
    });
    expect(persistence.state).toBe('failed');

    expect(persistence.failedWriteAttemptIdentity('unrelated-work'))
      .toBeUndefined();

    await persistence.retry();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toBe(save.mock.calls[0]![0]);

    expect(persistence.failedWriteAttemptIdentity(workId))
      .toBeUndefined();

    expect(persistence.current).toEqual({
      kind: 'present',
      snapshot: visible(),
    });

    expect(captured).toEqual({
      workId: visibleAttempt.workId,
      attemptId: visibleAttempt.attemptId,
    });
    expect(load).not.toHaveBeenCalled();
  });
});