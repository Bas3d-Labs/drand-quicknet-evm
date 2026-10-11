import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  waitForSignerJournal,
} from '../../src/cli/wait-for-signer-journal.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  SignerRecoveryCycleResult,
} from '../../src/state/signer-recovery-cycle.js';

const ANCHOR = {
  blockNumber: 100n,
  blockHash: `0x${'aa'.repeat(32)}` as const,
};

const OBSERVATION = {
  anchor: ANCHOR,
  nonce: 4n,
};

function deferredResult(): SignerRecoveryCycleResult {
  return {
    inspection: {
      status: 'bootstrap-deferred',
      reason: 'nonce-count-mismatch',
      observation: OBSERVATION,
      latestNonce: 4n,
      pendingNonce: 5n,
    },
    inclusions: null,
    broadcast: null,
    retryDelayMs: null,
  };
}

function readyResult(): SignerRecoveryCycleResult {
  return {
    inspection: {
      status: 'no-attempt',
      observation: OBSERVATION,
    },
    inclusions: null,
    broadcast: null,
    retryDelayMs: null,
  };
}

function setup(initialized = false) {
  let journalInitialized = initialized;

  const coordinator = {
    get journalInitialized() {
      return journalInitialized;
    },
  };

  const recover = vi.fn<BeaconSubmitter['recover']>()
    .mockImplementation(async () => {
      journalInitialized = true;
      return readyResult();
    });

  const sleep = vi.fn<
    (milliseconds: number, signal?: AbortSignal) => Promise<void>
  >().mockResolvedValue(undefined);

  const controller = new AbortController();

  return {
    recover,
    sleep,
    controller,
    initialize() {
      journalInitialized = true;
    },
    run: () => waitForSignerJournal({
      coordinator,
      submitter: { recover },
      pollIntervalMs: 100,
      signal: controller.signal,
      sleep,
    }),
  };
}

describe('waitForSignerJournal', () => {
  it('returns without recovery for an existing journal', async () => {
    const t = setup(true);

    await t.run();

    expect(t.recover).not.toHaveBeenCalled();
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('returns after initialization without sleeping', async () => {
    const t = setup();

    await t.run();

    expect(t.recover).toHaveBeenCalledOnce();
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('retries deferred initialization at the polling interval', async () => {
    const t = setup();
    const events: string[] = [];

    t.recover
      .mockImplementationOnce(async () => {
        events.push('deferred');
        return deferredResult();
      })
      .mockImplementationOnce(async () => {
        events.push('initialized');
        t.initialize();
        return readyResult();
      });

    t.sleep.mockImplementationOnce(async () => {
      events.push('sleep');
    });

    await t.run();

    expect(events).toEqual([
      'deferred',
      'sleep',
      'initialized',
    ]);

    expect(t.recover).toHaveBeenCalledTimes(2);
    expect(t.sleep).toHaveBeenCalledExactlyOnceWith(
      100,
      t.controller.signal,
    );
  });

  it('retries an anchor change before initialization', async () => {
    const t = setup();

    t.recover.mockResolvedValueOnce({
      inspection: {
        status: 'anchor-changed',
        observedAnchor: {
          blockNumber: 100n,
          blockHash: `0x${'bb'.repeat(32)}`,
        },
      },
      inclusions: null,
      broadcast: null,
      retryDelayMs: null,
    });

    await t.run();

    expect(t.recover).toHaveBeenCalledTimes(2);
    expect(t.sleep).toHaveBeenCalledOnce();
  });

  it('propagates recovery failures without retrying', async () => {
    const t = setup();
    const failure = new Error('Recovery failed');

    t.recover.mockRejectedValueOnce(failure);

    await expect(t.run()).rejects.toBe(failure);

    expect(t.recover).toHaveBeenCalledOnce();
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('rejects an unexpected result while the journal remains missing', async () => {
    const t = setup();

    t.recover.mockResolvedValueOnce(readyResult());

    await expect(t.run()).rejects.toThrow(
      'Signer recovery completed without initializing the journal.',
    );

    expect(t.recover).toHaveBeenCalledOnce();
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('honors cancellation before recovery', async () => {
    const t = setup();
    const reason = new Error('Cancelled');

    t.controller.abort(reason);

    await expect(t.run()).rejects.toBe(reason);

    expect(t.recover).not.toHaveBeenCalled();
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('honors cancellation during recovery even if initialization completes', async () => {
    const t = setup();
    const reason = new Error('Cancelled');

    t.recover.mockImplementationOnce(async () => {
      t.initialize();
      t.controller.abort(reason);
      return readyResult();
    });

    await expect(t.run()).rejects.toBe(reason);

    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('does not recover again after cancellation during sleep', async () => {
    const t = setup();
    const reason = new Error('Cancelled');

    t.recover.mockResolvedValueOnce(deferredResult());

    t.sleep.mockImplementationOnce(async () => {
      t.controller.abort(reason);
    });

    await expect(t.run()).rejects.toBe(reason);

    expect(t.recover).toHaveBeenCalledOnce();
    expect(t.sleep).toHaveBeenCalledOnce();
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    2_147_483_648,
  ])('rejects invalid polling interval: %s', async (pollIntervalMs) => {
    const recover = vi.fn<BeaconSubmitter['recover']>();

    await expect(waitForSignerJournal({
      coordinator: { journalInitialized: false },
      submitter: { recover },
      pollIntervalMs,
    })).rejects.toThrow('Invalid signer startup polling interval.');

    expect(recover).not.toHaveBeenCalled();
  });
});