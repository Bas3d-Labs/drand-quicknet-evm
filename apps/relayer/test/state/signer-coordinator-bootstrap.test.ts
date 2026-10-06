import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  SignerCoordinator,
  type RecoverSignerOptions,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalRead,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'11'.repeat(20)}` as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;

const ANCHOR = {
  blockNumber: 100n,
  blockHash: HASH,
};

async function setup(nonce = 7) {
  let visible: TransactionJournalRead = {
    kind: 'missing',
  };

  const load = vi.fn(async () => visible);

  const save = vi.fn<TransactionJournalStore['save']>(
    async (snapshot) => {
      visible = {
        kind: 'present',
        snapshot,
      };
    },
  );

  const lines: string[] = [];

  const create = () => SignerCoordinator.create({
    identity: IDENTITY,
    store: { load, save },
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    }),
    createErrorSummary: () => ({
      scrubText: () => ({
        text: 'redacted',
        removed: true,
      }),
    }),
  });

  const coordinator = await create();
  lines.length = 0;

  const getBlock = vi.fn(async () => ({
    number: 100n,
    hash: HASH as string,
  }));

  const getTransactionCount = vi.fn(async () => nonce);

  const options: RecoverSignerOptions = {
    publicClient: {
      getBlock,
      getTransactionCount,
    } as unknown as PublicClient,
    anchor: { ...ANCHOR },
    maxBlockRange: 2n,
    bootstrap: {
      expectedNonce: BigInt(nonce),
      confirmNoUntrackedTransactions: true,
    },
  };

  const recover = () => coordinator.recover({
    publicClient: options.publicClient,
    anchor: ANCHOR,
    maxBlockRange: 2n,
  });

  return {
    coordinator,
    create,
    options,
    load,
    save,
    getBlock,
    getTransactionCount,
    lines,
    recover,
    setVisible: (next: TransactionJournalRead) => {
      visible = next;
    },
    events: () => lines.map((line) => JSON.parse(line).event),
  };
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('signer bootstrap during recovery', () => {
  it.each([0, 7])(
    'bootstraps authorized nonce %i in one recovery call',
    async (nonce) => {
      const t = await setup(nonce);

      expect(t.save).not.toHaveBeenCalled();
      expect(t.getTransactionCount).not.toHaveBeenCalled();

      const result = await t.coordinator.recover(t.options);

      expect(result).toEqual({
        status: 'no-attempt',
        observation: {
          anchor: ANCHOR,
          nonce: BigInt(nonce),
        },
      });

      expect(t.save.mock.calls[0]![0]).toEqual({
        version: 1,
        identity: IDENTITY,
        baseline: {
          anchor: ANCHOR,
          nonce: BigInt(nonce),
        },
        lastObservation: {
          anchor: ANCHOR,
          nonce: BigInt(nonce),
        },
        nextNonce: BigInt(nonce),
        attempt: null,
      });

      expect(t.getTransactionCount.mock.calls).toEqual([
        [{ address: IDENTITY.signer, blockNumber: 100n }],
        [{ address: IDENTITY.signer, blockTag: 'latest' }],
        [{ address: IDENTITY.signer, blockTag: 'pending' }],
      ]);

      expect(t.coordinator.status).toMatchObject({
        open: true,
        recoveryComplete: true,
      });

      expect(t.events()).toEqual(['signer_gate_released']);

      await t.recover();

      expect(t.coordinator.status.open).toBe(true);
      expect(t.events()).toEqual(['signer_gate_released']);
    },
  );

  it.each([false, undefined, 'true'])(
    'rejects confirmation %s before RPC or persistence',
    async (confirmation) => {
      const t = await setup();

      const options = {
        ...t.options,
        bootstrap: {
          ...t.options.bootstrap!,
          confirmNoUntrackedTransactions: confirmation,
        },
      };

      await expect(
        t.coordinator.recover(options as RecoverSignerOptions),
      ).rejects.toThrow('authorization');

      expect(t.getBlock).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it.each([-1n, 1n << 256n, 7, undefined])(
    'rejects invalid expected nonce %s before RPC',
    async (expectedNonce) => {
      const t = await setup();

      await expect(t.coordinator.recover({
        ...t.options,
        bootstrap: {
          ...t.options.bootstrap!,
          expectedNonce,
        },
      } as RecoverSignerOptions)).rejects.toThrow('authorization');

      expect(t.getBlock).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('rejects an anchored nonce different from the approved value', async () => {
    const t = await setup();

    await expect(t.coordinator.recover({
      ...t.options,
      bootstrap: {
        ...t.options.bootstrap!,
        expectedNonce: 6n,
      },
    })).rejects.toThrow('authorized baseline');

    expect(t.getTransactionCount).toHaveBeenCalledTimes(1);
    expect(t.save).not.toHaveBeenCalled();
  });

  it.each(['latest', 'pending'] as const)(
    'refuses activity reflected in the %s count',
    async (tag) => {
      const t = await setup();

      t.getTransactionCount.mockResolvedValueOnce(7);

      if (tag === 'pending') {
        t.getTransactionCount.mockResolvedValueOnce(7);
      }

      t.getTransactionCount.mockResolvedValueOnce(8);

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toThrow('nonce counts');

      expect(t.save).not.toHaveBeenCalled();
      expect(t.coordinator.status.open).toBe(false);
    },
  );

  it.each([-1, 7.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid live nonce %s without saving',
    async (nonce) => {
      const t = await setup();

      t.getTransactionCount
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(nonce);

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toThrow('nonce response');

      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('discards bootstrap when the final anchor check changes', async () => {
    const t = await setup();

    t.getBlock
      .mockResolvedValueOnce({ number: 100n, hash: HASH })
      .mockResolvedValueOnce({ number: 100n, hash: HASH })
      .mockResolvedValueOnce({ number: 100n, hash: OTHER });

    expect(await t.coordinator.recover(t.options)).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 100n,
        blockHash: OTHER,
      },
    });

    expect(t.save).not.toHaveBeenCalled();
    expect(t.coordinator.status.recoveryComplete).toBe(false);
  });

  it('stops on an opening anchor change before reading a nonce', async () => {
    const t = await setup();

    t.getBlock.mockResolvedValueOnce({
      number: 100n,
      hash: OTHER,
    });

    expect(await t.coordinator.recover(t.options)).toMatchObject({
      status: 'anchor-changed',
    });

    expect(t.getTransactionCount).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it.each(['anchored', 'latest', 'pending', 'closing-anchor'] as const)(
    'propagates %s RPC failure without establishing a baseline',
    async (phase) => {
      const t = await setup();
      const error = new Error('Unavailable');

      if (phase === 'closing-anchor') {
        t.getBlock
          .mockResolvedValueOnce({ number: 100n, hash: HASH })
          .mockResolvedValueOnce({ number: 100n, hash: HASH })
          .mockRejectedValueOnce(error);
      } else {
        if (phase !== 'anchored') {
          t.getTransactionCount.mockResolvedValueOnce(7);
        }

        if (phase === 'pending') {
          t.getTransactionCount.mockResolvedValueOnce(7);
        }

        t.getTransactionCount.mockRejectedValueOnce(error);
      }

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toBe(error);

      expect(t.save).not.toHaveBeenCalled();

      expect(t.coordinator.status).toMatchObject({
        open: false,
        persistenceState: 'idle',
      });
    },
  );

  it('holds exclusive access during RPC and persistence', async () => {
    const t = await setup();

    const rpcEntered = deferred();
    const finishRpc = deferred();
    const saveEntered = deferred();
    const finishSave = deferred();

    t.getTransactionCount.mockImplementationOnce(async () => {
      rpcEntered.resolve();
      await finishRpc.promise;
      return 7;
    });

    t.save.mockImplementationOnce(async () => {
      saveEntered.resolve();
      await finishSave.promise;
    });

    const pending = t.coordinator.recover(t.options);

    try {
      await Promise.race([rpcEntered.promise, pending]);

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toThrow('already in progress');

      await expect(t.recover()).rejects.toThrow('already in progress');

      finishRpc.resolve();

      await Promise.race([saveEntered.promise, pending]);

      expect(() => t.coordinator.completeRecovery())
        .toThrow('already in progress');

      await expect(
        t.coordinator.retryPersistence(),
      ).rejects.toThrow('already in progress');

      expect(t.coordinator.status.open).toBe(false);
      expect(t.events()).toEqual([]);
    } finally {
      finishRpc.resolve();
      finishSave.resolve();
      await pending;
    }

    expect(t.coordinator.status.open).toBe(true);
  });

  it('retries the same failed baseline without rereading RPC or opening the gate', async () => {
    const t = await setup();

    t.save.mockImplementationOnce(async (snapshot) => {
      t.setVisible({
        kind: 'present',
        snapshot,
      });

      throw new Error('Durability uncertain');
    });

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('Journal persistence');

    const first = t.save.mock.calls[0]![0];

    Object.assign(t.options.bootstrap!, {
      expectedNonce: 8n,
    });

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('must be retried');

    await expect(t.recover()).rejects.toThrow('must be retried');

    t.save.mockRejectedValueOnce(new Error('Retry failed'));

    await expect(
      t.coordinator.retryPersistence(),
    ).rejects.toThrow('Journal persistence');

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[1]![0]).toBe(first);
    expect(t.save.mock.calls[2]![0]).toBe(first);

    expect(t.getTransactionCount).toHaveBeenCalledTimes(3);
    expect(t.load).toHaveBeenCalledTimes(1);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });

    expect(t.events()).not.toContain('signer_gate_released');

    t.getTransactionCount.mockResolvedValue(8);

    await t.recover();

    expect(t.coordinator.status.primaryReason)
      .toBe('unattributed-signer-activity');

    expect(t.save.mock.calls[3]![0].nextNonce).toBe(7n);
  });

  it('uses existing state instead of reapplying bootstrap authorization', async () => {
    const t = await setup();

    await t.coordinator.recover(t.options);

    const baseline = t.save.mock.calls[0]![0].baseline;
    const restarted = await t.create();

    expect(restarted.status.open).toBe(false);

    Object.assign(t.options.bootstrap!, {
      expectedNonce: 0n,
    });

    await restarted.recover(t.options);

    expect(t.save.mock.calls[1]![0].baseline).toEqual(baseline);
    expect(t.save.mock.calls[1]![0].nextNonce).toBe(7n);
    expect(t.getTransactionCount).toHaveBeenCalledTimes(4);
    expect(restarted.status.open).toBe(true);
  });

  it('does not override an explicit coordinator blocker', async () => {
    const t = await setup();

    t.coordinator.block('unattributed-signer-activity');

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('blockers remain');

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it('captures authorization and anchor before awaiting RPC', async () => {
    const t = await setup();

    t.getBlock.mockImplementationOnce(async () => {
      Object.assign(t.options.bootstrap!, {
        expectedNonce: 8n,
        confirmNoUntrackedTransactions: false,
      });

      Object.assign(t.options.anchor, {
        blockNumber: 200n,
        blockHash: OTHER,
      });

      return {
        number: 100n,
        hash: HASH,
      };
    });

    expect(await t.coordinator.recover(t.options)).toEqual({
      status: 'no-attempt',
      observation: {
        anchor: ANCHOR,
        nonce: 7n,
      },
    });

    expect(t.save.mock.calls[0]![0].baseline).toEqual({
      anchor: ANCHOR,
      nonce: 7n,
    });
  });
});

describe('missing journal policy', () => {
  it.each([0, 7])(
    'does not infer authorization from nonce %i',
    async (nonce) => {
      const t = await setup(nonce);

      await expect(
        t.recover(),
      ).rejects.toThrow('explicit bootstrap authorization');

      expect(t.getBlock).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
      expect(t.coordinator.status.open).toBe(false);
    },
  );

  it('rejects an invalid recovery budget before bootstrapping', async () => {
    const t = await setup();

    await expect(t.coordinator.recover({
      ...t.options,
      maxBlockRange: 0n,
    })).rejects.toThrow('Invalid signer recovery input');

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it('does not replace journal read failures with bootstrap', async () => {
    const t = await setup();
    const failure = new Error('Invalid journal');

    t.load.mockRejectedValueOnce(failure);

    await expect(t.create()).rejects.toBe(failure);

    expect(t.save).not.toHaveBeenCalled();
    expect(t.getBlock).not.toHaveBeenCalled();
  });
});