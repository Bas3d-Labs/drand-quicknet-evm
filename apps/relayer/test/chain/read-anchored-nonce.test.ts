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
  readAnchoredNonce,
} from '../../src/chain/read-anchored-nonce.js';

const SIGNER = `0x${'11'.repeat(20)}` as const;
const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER_HASH = `0x${'bb'.repeat(32)}` as const;

function setup() {
  const calls: string[] = [];

  const anchor = {
    blockNumber: 110n,
    blockHash: HASH as Hash,
  };

  const getBlock = vi.fn(async () => {
    calls.push('anchor');

    return {
      number: 110n,
      hash: HASH as Hash,
    };
  });

  const getTransactionCount = vi.fn(async () => {
    calls.push('nonce');
    return 4;
  });

  const publicClient = {
    getBlock,
    getTransactionCount,
  } as unknown as PublicClient;

  const run = () => readAnchoredNonce({
    publicClient,
    signer: SIGNER,
    anchor,
  });

  return {
    calls,
    anchor,
    getBlock,
    getTransactionCount,
    publicClient,
    run,
  };
}

describe('anchored nonce observation', () => {
  it.each([
    0,
    4,
    Number.MAX_SAFE_INTEGER,
  ])(
    'reads nonce %s at the explicit anchor block',
    async (nonce) => {
      const fixture = setup();

      fixture.getTransactionCount.mockImplementation(async () => {
        fixture.calls.push('nonce');
        return nonce;
      });

      expect(await fixture.run()).toEqual({
        status: 'verified',
        observation: {
          anchor: fixture.anchor,
          nonce: BigInt(nonce),
        },
      });

      expect(fixture.calls).toEqual([
        'anchor',
        'nonce',
        'anchor',
      ]);

      expect(fixture.getTransactionCount)
        .toHaveBeenCalledExactlyOnceWith({
          address: SIGNER,
          blockNumber: 110n,
        });

      expect(fixture.getBlock.mock.calls).toEqual([
        [{ blockNumber: 110n }],
        [{ blockNumber: 110n }],
      ]);
    },
  );

  it('captures the anchor before awaiting and returns a detached frozen observation', async () => {
    const fixture = setup();
    const pending = fixture.run();

    fixture.anchor.blockNumber = 999n;
    fixture.anchor.blockHash = OTHER_HASH;

    const result = await pending;

    expect(result).toEqual({
      status: 'verified',
      observation: {
        anchor: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        nonce: 4n,
      },
    });

    if (result.status !== 'verified') {
      throw new Error('Expected observation.');
    }

    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.anchor)).toBe(true);
  });

  it('does not read the nonce when the opening anchor changed', async () => {
    const fixture = setup();

    fixture.getBlock.mockResolvedValueOnce({
      number: 110n,
      hash: OTHER_HASH,
    });

    expect(await fixture.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 110n,
        blockHash: OTHER_HASH,
      },
    });

    expect(fixture.getTransactionCount).not.toHaveBeenCalled();
  });

  it('discards the nonce when the closing anchor changed', async () => {
    const fixture = setup();

    fixture.getBlock
      .mockResolvedValueOnce({
        number: 110n,
        hash: HASH,
      })
      .mockResolvedValueOnce({
        number: 110n,
        hash: OTHER_HASH,
      });

    expect(await fixture.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 110n,
        blockHash: OTHER_HASH,
      },
    });
  });

  it.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    '4',
    4n,
    null,
  ])(
    'rejects invalid nonce %# without echoing it',
    async (nonce) => {
      const fixture = setup();

      fixture.getTransactionCount.mockResolvedValueOnce(
        nonce as never,
      );

      await expect(fixture.run()).rejects.toThrow(
        'Invalid anchored nonce response.',
      );
    },
  );

  it.each([
    'opening',
    'nonce',
    'closing',
  ])(
    'propagates %s RPC failure',
    async (stage) => {
      const fixture = setup();
      const failure = new Error('RPC unavailable');

      if (stage === 'nonce') {
        fixture.getTransactionCount.mockRejectedValueOnce(failure);
      } else {
        if (stage === 'closing') {
          fixture.getBlock.mockResolvedValueOnce({
            number: 110n,
            hash: HASH,
          });
        }

        fixture.getBlock.mockRejectedValueOnce(failure);
      }

      await expect(fixture.run()).rejects.toBe(failure);
    },
  );

  it('rejects invalid input before making RPC calls', async () => {
    const fixture = setup();
    fixture.anchor.blockNumber = -1n;

    await expect(fixture.run()).rejects.toThrow(
      'Invalid anchored nonce input.',
    );

    expect(fixture.getBlock).not.toHaveBeenCalled();
    expect(fixture.getTransactionCount).not.toHaveBeenCalled();
  });
});