import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  JournalPersistence,
} from '../../src/state/journal-persistence.js';

import type {
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

import {
  retryJournalWrite,
  saveJournalWrite,
} from '../../src/state/write-outcome.js';

import {
  IDENTITY,
  fixture,
} from '../helpers/operator-attribution-fixture.js';

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function setup() {
  const snapshot = await fixture();

  const save = vi.fn<TransactionJournalStore['save']>(async () => {});

  const persistence = await JournalPersistence.create({
    identity: IDENTITY,
    initial: { kind: 'missing' },
    store: {
      load: async () => ({ kind: 'missing' }),
      save,
    },
  });

  return { snapshot, persistence, save };
}

afterEach(() => vi.restoreAllMocks());

describe('journal write outcomes', () => {
  it(
    'acknowledges only after the save settles and the journal commits',
    async () => {
      const t = await setup();

      const entered = deferred();

      const finish = deferred();

      t.save.mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;
      });

      let settled = false;

      const writing = saveJournalWrite(t.persistence, t.snapshot).then(
        (outcome) => {
          settled = true;
          return outcome;
        }
      );

      try {
        await entered.promise;

        expect(settled).toBe(false);
        expect(t.persistence.state).toBe('writing');
        expect(t.persistence.current).toEqual({ kind: 'missing' });
      } finally {
        finish.resolve();
      }

      expect(await writing).toEqual({ status: 'acknowledged' });
      expect(t.persistence.state).toBe('idle');
      expect(t.persistence.current).toEqual({
        kind: 'present',
        snapshot: t.snapshot
      });
      expect(t.save).toHaveBeenCalledOnce();
    }
  );

  it(
    'reports verification rejection as not-written and preserves the previous journal',
    async () => {
      const t = await setup();

      const previous = t.persistence.current;

      const outcome = await saveJournalWrite(t.persistence, {
        ...t.snapshot,
        nextNonce: -1n,
      });

      expect(outcome).toEqual({
        status: 'not-written',
        error: new TypeError('Invalid journal persistence snapshot.'),
      });
      expect(t.persistence.state).toBe('idle');
      expect(t.persistence.current).toBe(previous);
      expect(t.save).not.toHaveBeenCalled();

      await expect(t.persistence.retry()).rejects.toThrow(
        'No failed journal write is available to retry.',
      );

      expect(await saveJournalWrite(t.persistence, t.snapshot))
        .toEqual({ status: 'acknowledged' });
    }
  );

  it.each([false, true])(
    'reports unacknowledged storage as uncertain even if visible=%s',
    async (visible) => {
      const t = await setup();

      const previous = t.persistence.current;

      let stored: TransactionJournalSnapshot | undefined;

      t.save.mockImplementationOnce(async (next) => {
        if (visible) {
          stored = next;
        }

        throw new Error('Store did not confirm durability');
      });

      const outcome = await saveJournalWrite(t.persistence, t.snapshot);

      expect(outcome).toMatchObject({
        status: 'uncertain',
        error: {
          message: expect.stringContaining(
            'Journal persistence did not complete.'
          ),
        },
      });
      expect(t.persistence.state).toBe('failed');
      expect(t.persistence.current).toBe(previous);
      expect(t.save).toHaveBeenCalledOnce();

      if (visible) {
        expect(stored).toBe(t.save.mock.calls[0]![0]);
      } else {
        expect(stored).toBeUndefined();
      }
    },
  );

  it(
    'retries the retained verified object through another failure and acknowledgement',
    async () => {
      const t = await setup();

      t.save.mockRejectedValueOnce(new Error('First failure'));

      expect((await saveJournalWrite(t.persistence, t.snapshot)).status)
        .toBe('uncertain');

      const retained = t.save.mock.calls[0]![0];

      const previous = t.persistence.current;

      t.save.mockRejectedValueOnce(new Error('Second failure'));

      expect(await retryJournalWrite(t.persistence)).toMatchObject({
        status: 'uncertain',
        error: {
          message: expect.stringContaining(
            'Journal persistence did not complete.'
          ),
        },
      });
      expect(t.persistence.current).toBe(previous);
      expect(t.persistence.state).toBe('failed');
      expect(t.save.mock.calls[1]![0]).toBe(retained);

      expect(await retryJournalWrite(t.persistence)).toEqual({
        status: 'acknowledged'
      });
      expect(t.save.mock.calls[2]![0]).toBe(retained);
      expect(t.persistence.current).toEqual({
        kind: 'present',
        snapshot: retained
      });
      expect(t.persistence.state).toBe('idle');
    }
  );

  it.each(['not-written', 'uncertain'] as const)(
    'returns the original persistence rejection for %s',
    async (status) => {
      const t = await setup();

      const save = t.persistence.save.bind(t.persistence);

      let rejection: unknown;

      vi.spyOn(t.persistence, 'save').mockImplementationOnce(
        async (snapshot) => {
          try {
            await save(snapshot);
          } catch (error) {
            rejection = error;
            throw error;
          }
        }
      );

      let snapshot = t.snapshot;

      if (status === 'not-written') {
        snapshot = { ...snapshot, nextNonce: -1n };
      } else {
        t.save.mockRejectedValueOnce(new Error('Store failure'));
      }

      const outcome = await saveJournalWrite(t.persistence, snapshot);

      expect(outcome.status).toBe(status);
      expect(rejection).toBeInstanceOf(Error);

      if (outcome.status === 'acknowledged') {
        throw new Error('Expected the injected failure.');
      }

      expect(outcome.error).toBe(rejection);
    },
  );
});
