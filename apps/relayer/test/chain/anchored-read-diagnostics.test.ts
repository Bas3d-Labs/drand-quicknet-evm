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
  getBlockAnchor,
} from '../../src/chain/block-anchor.js';

import {
  readAnchoredNonce,
} from '../../src/chain/read-anchored-nonce.js';

import type {
  AnchoredReadScope,
} from '../../src/diagnostics/anchored-read-errors.js';

import {
  anchoredReadDetails,
} from '../../src/diagnostics/anchored-read-errors.js';

const SIGNER = `0x${'11'.repeat(20)}` as const;
const HASH = `0x${'aa'.repeat(32)}` as const;

function setup() {
  const getBlock = vi.fn(async () => ({
    number: 100n,
    hash: HASH,
  }));

  const getTransactionCount = vi.fn(async () => 4);

  const publicClient = {
    getBlock,
    getTransactionCount,
  } as unknown as PublicClient;

  const run = () => readAnchoredNonce({
    publicClient,
    signer: SIGNER,
    anchor: {
      blockNumber: 100n,
      blockHash: HASH,
    },
  });

  return {
    publicClient,
    getBlock,
    getTransactionCount,
    run,
  };
}

describe('anchored read diagnostics', () => {
  it.each([
    'opening',
    'nonce',
    'closing',
  ] as const)(
    'preserves and identifies the %s read failure',
    async stage => {
      const fixture = setup();
      const error = Object.freeze(new Error('RPC failed.'));

      let method = 'eth_getBlockByNumber';
      let blockCalls = 1;
      let nonceCalls = 0;

      if (stage === 'opening') {
        fixture.getBlock.mockRejectedValueOnce(error);
      } else if (stage === 'nonce') {
        fixture.getTransactionCount.mockRejectedValueOnce(error);
        method = 'eth_getTransactionCount';
        nonceCalls = 1;
      } else {
        fixture.getBlock
          .mockResolvedValueOnce({
            number: 100n,
            hash: HASH,
          })
          .mockRejectedValueOnce(error);

        blockCalls = 2;
        nonceCalls = 1;
      }

      await expect(fixture.run()).rejects.toBe(error);

      const details = anchoredReadDetails(error);

      expect(details).toEqual({
        method,
        blockNumber: '100',
        expectedBlockHash: HASH,
        durationMs: expect.any(Number),
      });

      expect(Number.isFinite(details!.durationMs)).toBe(true);
      expect(details!.durationMs).toBeGreaterThanOrEqual(0);

      expect(fixture.getBlock).toHaveBeenCalledTimes(blockCalls);
      expect(fixture.getTransactionCount)
        .toHaveBeenCalledTimes(nonceCalls);
    },
  );

  it('does not add reads to a successful observation', async () => {
    const fixture = setup();

    await expect(fixture.run()).resolves.toMatchObject({
      status: 'verified',
      observation: {
        nonce: 4n,
      },
    });

    expect(fixture.getBlock.mock.calls).toEqual([
      [{ blockNumber: 100n }],
      [{ blockNumber: 100n }],
    ]);

    expect(fixture.getTransactionCount)
      .toHaveBeenCalledExactlyOnceWith({
        address: SIGNER,
        blockNumber: 100n,
      });
  });

  it('omits an unknown expected hash for a direct block read', async () => {
    const fixture = setup();
    const error = new Error('Block unavailable.');

    fixture.getBlock.mockRejectedValueOnce(error);

    await expect(
      getBlockAnchor(fixture.publicClient, 100n),
    ).rejects.toBe(error);

    expect(anchoredReadDetails(error)).toEqual({
      method: 'eth_getBlockByNumber',
      blockNumber: '100',
      durationMs: expect.any(Number),
    });
  });

  it('preserves a cancellation reason object', async () => {
    const fixture = setup();
    const controller = new AbortController();

    controller.abort(new Error('Cancelled.'));
    fixture.getTransactionCount.mockRejectedValueOnce(
      controller.signal.reason,
    );

    await expect(fixture.run())
      .rejects.toBe(controller.signal.reason);
  });

  it('preserves primitive failures without context', async () => {
    const fixture = setup();

    fixture.getTransactionCount.mockRejectedValueOnce('RPC failed.');

    await expect(fixture.run()).rejects.toBe('RPC failed.');
    expect(anchoredReadDetails('RPC failed.')).toBeUndefined();
  });

  it.each([
    'opening',
    'nonce',
    'closing',
  ] as const)(
    'carries scope to the %s failure',
    async stage => {
      const fixture = setup();
      const error = new Error('RPC failed.');

      if (stage === 'opening') {
        fixture.getBlock.mockRejectedValueOnce(error);
      } else if (stage === 'nonce') {
        fixture.getTransactionCount.mockRejectedValueOnce(error);
      } else {
        fixture.getBlock
          .mockResolvedValueOnce({
            number: 100n,
            hash: HASH,
          })
          .mockRejectedValueOnce(error);
      }

      await expect(readAnchoredNonce({
        publicClient: fixture.publicClient,
        signer: SIGNER,
        anchor: {
          blockNumber: 100n,
          blockHash: HASH,
        },
        scope: {
          operation: 'nonce-sync',
          finality: { type: 'safe' },
        },
      })).rejects.toBe(error);

      expect(anchoredReadDetails(error)).toMatchObject({
        operation: 'nonce-sync',
        finality: { type: 'safe' },
      });
    },
  );

  it('captures scope before awaiting the opening read', async () => {
    const fixture = setup();
    const error = new Error('RPC failed.');

    const finality = {
      type: 'confirmations' as const,
      confirmations: 12n,
    };

    const scope: AnchoredReadScope = {
      operation: 'nonce-sync',
      finality,
    };

    fixture.getBlock.mockImplementationOnce(async () => {
      finality.confirmations = 99n;

      return {
        number: 100n,
        hash: HASH,
      };
    });

    fixture.getTransactionCount.mockRejectedValueOnce(error);

    await expect(readAnchoredNonce({
      publicClient: fixture.publicClient,
      signer: SIGNER,
      anchor: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      scope,
    })).rejects.toBe(error);

    expect(anchoredReadDetails(error)?.finality).toEqual({
      type: 'confirmations',
      confirmations: '12',
    });
  });
});