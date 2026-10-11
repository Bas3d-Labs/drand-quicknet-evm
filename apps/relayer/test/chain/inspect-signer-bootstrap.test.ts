import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import {
  inspectSignerBootstrap,
} from '../../src/chain/inspect-signer-bootstrap.js';

const SIGNER = `0x${'11'.repeat(20)}` as const;
const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER_HASH = `0x${'bb'.repeat(32)}` as const;

const ANCHOR = {
  blockNumber: 100n,
  blockHash: HASH,
};

function setup() {
  const getBlock = vi.fn<PublicClient['getBlock']>()
    .mockResolvedValue({
      number: ANCHOR.blockNumber,
      hash: ANCHOR.blockHash,
    } as never);

  const getTransactionCount =
    vi.fn<PublicClient['getTransactionCount']>()
      .mockResolvedValue(4);

  const publicClient = {
    getBlock,
    getTransactionCount,
  } as unknown as PublicClient;

  return {
    getBlock,
    getTransactionCount,
    inspect: () => inspectSignerBootstrap({
      publicClient,
      signer: SIGNER,
      anchor: ANCHOR,
    }),
  };
}

describe('inspectSignerBootstrap', () => {
  it.each([0, 4, Number.MAX_SAFE_INTEGER])(
    'accepts matching nonce counts: %s',
    async (nonce) => {
      const t = setup();
      t.getTransactionCount.mockResolvedValue(nonce);

      expect(await t.inspect()).toEqual({
        status: 'ready',
        observation: {
          anchor: ANCHOR,
          nonce: BigInt(nonce),
        },
      });

      expect(t.getTransactionCount.mock.calls).toEqual([
        [{
          address: SIGNER,
          blockNumber: ANCHOR.blockNumber,
        }],
        [{
          address: SIGNER,
          blockTag: 'latest',
        }],
        [{
          address: SIGNER,
          blockTag: 'pending',
        }],
      ]);

      // Before and after the anchored nonce, then after both live counts.
      expect(t.getBlock).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { latest: 5, pending: 5 },
    { latest: 4, pending: 5 },
    { latest: 3, pending: 4 },
    { latest: 4, pending: 3 },
    { latest: 5, pending: 4 },
  ])(
    'defers when durable=4, latest=$latest, pending=$pending',
    async ({ latest, pending }) => {
      const t = setup();

      t.getTransactionCount
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(latest)
        .mockResolvedValueOnce(pending);

      expect(await t.inspect()).toEqual({
        status: 'bootstrap-deferred',
        reason: 'nonce-count-mismatch',
        observation: {
          anchor: ANCHOR,
          nonce: 4n,
        },
        latestNonce: BigInt(latest),
        pendingNonce: BigInt(pending),
      });

      expect(t.getTransactionCount).toHaveBeenCalledTimes(3);
      expect(t.getBlock).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { stage: 'before the anchored read', blockReads: 1, nonceReads: 0 },
    { stage: 'after the anchored read', blockReads: 2, nonceReads: 1 },
    { stage: 'after the live counts', blockReads: 3, nonceReads: 3 },
  ])(
    'reports an anchor change $stage',
    async ({ blockReads, nonceReads }) => {
      const t = setup();

      for (let index = 1; index < blockReads; index += 1) {
        t.getBlock.mockResolvedValueOnce({
          number: ANCHOR.blockNumber,
          hash: HASH,
        } as never);
      }

      t.getBlock.mockResolvedValueOnce({
        number: ANCHOR.blockNumber,
        hash: OTHER_HASH,
      } as never);

      expect(await t.inspect()).toEqual({
        status: 'anchor-changed',
        observedAnchor: {
          blockNumber: ANCHOR.blockNumber,
          blockHash: OTHER_HASH,
        },
      });

      expect(t.getBlock).toHaveBeenCalledTimes(blockReads);
      expect(t.getTransactionCount).toHaveBeenCalledTimes(nonceReads);
    },
  );

  it('reports a closing anchor change even when nonce counts disagree', async () => {
    const t = setup();

    t.getTransactionCount
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5);

    t.getBlock
      .mockResolvedValueOnce({
        number: ANCHOR.blockNumber,
        hash: HASH,
      } as never)
      .mockResolvedValueOnce({
        number: ANCHOR.blockNumber,
        hash: HASH,
      } as never)
      .mockResolvedValueOnce({
        number: ANCHOR.blockNumber,
        hash: OTHER_HASH,
      } as never);

    expect(await t.inspect()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: ANCHOR.blockNumber,
        blockHash: OTHER_HASH,
      },
    });
  });

  describe.each(['latest', 'pending'] as const)(
    '%s nonce response',
    (blockTag) => {
      it.each([
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '4',
        4n,
        null,
        undefined,
      ])('rejects an invalid value: %#', async (value) => {
        const t = setup();

        t.getTransactionCount.mockImplementation(async (options) => {
          if (options.blockTag === blockTag) {
            return value as never;
          }

          return 4;
        });

        await expect(t.inspect())
          .rejects.toThrow('Invalid bootstrap nonce response.');
      });

      it('propagates an RPC failure', async () => {
        const t = setup();
        const failure = new Error('RPC unavailable');

        t.getTransactionCount.mockImplementation(async (options) => {
          if (options.blockTag === blockTag) {
            throw failure;
          }

          return 4;
        });

        await expect(t.inspect()).rejects.toBe(failure);
      });
    },
  );

  it('propagates a failure of the closing anchor read', async () => {
    const t = setup();
    const failure = new Error('Anchor unavailable');

    t.getBlock
      .mockResolvedValueOnce({
        number: ANCHOR.blockNumber,
        hash: HASH,
      } as never)
      .mockResolvedValueOnce({
        number: ANCHOR.blockNumber,
        hash: HASH,
      } as never)
      .mockRejectedValueOnce(failure);

    await expect(t.inspect()).rejects.toBe(failure);
  });
});