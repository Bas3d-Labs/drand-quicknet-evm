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
  anchoredReadDetails,
} from '../../src/diagnostics/anchored-read-errors.js';

import {
  MAX_UINT256,
} from '../../src/shared/uint.js';

import {
  readSearchLowerBoundProbe,
} from '../../src/chain/read-search-lower-bound-probe.js';

const SIGNER = `0x${'11'.repeat(20)}` as const;
const HASH = `0x${'ab'.repeat(32)}` as const;
const PARENT_HASH = `0x${'cd'.repeat(32)}` as const;
const OTHER_HASH = `0x${'ef'.repeat(32)}` as const;

function header(blockNumber = 97n) {
  return {
    number: blockNumber,
    hash: HASH as Hash,
    parentHash: PARENT_HASH as Hash,
  };
}

function setup() {
  const calls: string[] = [];

  const getBlock = vi.fn(async (request: {
    blockNumber: bigint;
    includeTransactions: boolean;
  }) => {
    calls.push('header');
    return header(request.blockNumber);
  });

  const getTransactionCount = vi.fn(async () => {
    calls.push('nonce');
    return 4;
  });

  const publicClient = {
    getBlock,
    getTransactionCount,
  } as unknown as PublicClient;

  const options = {
    publicClient,
    signer: SIGNER,
    blockNumber: 97n,
    scope: {
      operation: 'signer-recovery' as const,
      finality: {
        type: 'confirmations' as const,
        confirmations: 12n,
      },
    },
  };

  return {
    calls,
    getBlock,
    getTransactionCount,
    options,
    run: () => readSearchLowerBoundProbe(options),
  };
}

describe('search lower-bound nonce probe', () => {
  it.each([
    0,
    4,
    Number.MAX_SAFE_INTEGER,
  ])('brackets nonce %s with exactly two header-only reads', async (nonce) => {
    const fixture = setup();

    fixture.getTransactionCount.mockImplementation(async () => {
      fixture.calls.push('nonce');
      return nonce;
    });

    expect(await fixture.run()).toEqual({
      status: 'verified',
      observation: {
        anchor: {
          blockNumber: 97n,
          blockHash: HASH,
        },
        nonce: BigInt(nonce),
      },
      parentHash: PARENT_HASH,
    });

    expect(fixture.calls).toEqual([
      'header',
      'nonce',
      'header',
    ]);
    expect(fixture.getBlock.mock.calls).toEqual([
      [{ blockNumber: 97n, includeTransactions: false }],
      [{ blockNumber: 97n, includeTransactions: false }],
    ]);
    expect(fixture.getTransactionCount).toHaveBeenCalledExactlyOnceWith({
      address: SIGNER,
      blockNumber: 97n,
    });
  });

  it.each([
    0n,
    MAX_UINT256,
  ])('supports valid block-number boundary %s', async (blockNumber) => {
    const fixture = setup();
    fixture.options.blockNumber = blockNumber;

    expect(await fixture.run()).toMatchObject({
      status: 'verified',
      observation: {
        anchor: { blockNumber },
      },
    });

    expect(fixture.getBlock).toHaveBeenCalledTimes(2);
  });

  it('accepts hash casing differences while preserving the opening values', async () => {
    const fixture = setup();

    fixture.getBlock
      .mockResolvedValueOnce(header())
      .mockResolvedValueOnce({
        number: 97n,
        hash: `0x${HASH.slice(2).toUpperCase()}`,
        parentHash: `0x${PARENT_HASH.slice(2).toUpperCase()}`,
      });

    expect(await fixture.run()).toMatchObject({
      status: 'verified',
      observation: {
        anchor: { blockHash: HASH },
      },
      parentHash: PARENT_HASH,
    });
  });

  it('detaches the opening header and captures input before asynchronous work', async () => {
    const fixture = setup();
    const opening = header();

    fixture.getBlock
      .mockResolvedValueOnce(opening)
      .mockResolvedValueOnce(header());

    fixture.getTransactionCount.mockImplementation(async () => {
      opening.hash = OTHER_HASH;
      opening.parentHash = OTHER_HASH;
      opening.number = 999n;
      return 4;
    });

    const pending = fixture.run();
    fixture.options.blockNumber = 999n;
    const result = await pending;

    expect(result).toEqual({
      status: 'verified',
      observation: {
        anchor: {
          blockNumber: 97n,
          blockHash: HASH,
        },
        nonce: 4n,
      },
      parentHash: PARENT_HASH,
    });

    if (result.status !== 'verified') {
      throw new Error('Expected a verified probe.');
    }

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.anchor)).toBe(true);
    expect(result.observation.anchor).not.toHaveProperty('parentHash');
    expect(fixture.getBlock.mock.calls).toEqual([
      [{ blockNumber: 97n, includeTransactions: false }],
      [{ blockNumber: 97n, includeTransactions: false }],
    ]);
  });

  it('discards the nonce when the closing hash changes', async () => {
    const fixture = setup();

    fixture.getBlock
      .mockResolvedValueOnce(header())
      .mockResolvedValueOnce({
        ...header(),
        hash: OTHER_HASH,
      });

    const result = await fixture.run();

    expect(result).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 97n,
        blockHash: OTHER_HASH,
      },
    });
    expect(result).not.toHaveProperty('observation');
    expect(result).not.toHaveProperty('parentHash');
    expect(fixture.getBlock).toHaveBeenCalledTimes(2);
    expect(fixture.getTransactionCount).toHaveBeenCalledTimes(1);

    if (result.status !== 'anchor-changed') {
      throw new Error('Expected a changed anchor.');
    }

    expect(Object.isFrozen(result.observedAnchor)).toBe(true);
  });

  it('rejects different parents for the same hash without exposing nonce evidence', async () => {
    const fixture = setup();

    fixture.getBlock
      .mockResolvedValueOnce(header())
      .mockResolvedValueOnce({
        ...header(),
        parentHash: OTHER_HASH,
      });

    expect(await fixture.run()).toEqual({
      status: 'inconsistent-observations',
    });
    expect(fixture.getBlock).toHaveBeenCalledTimes(2);
    expect(fixture.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it('classifies a changed hash before a changed parent', async () => {
    const fixture = setup();

    fixture.getBlock
      .mockResolvedValueOnce(header())
      .mockResolvedValueOnce({
        ...header(),
        hash: OTHER_HASH,
        parentHash: OTHER_HASH,
      });

    expect(await fixture.run()).toMatchObject({
      status: 'anchor-changed',
    });
  });

  describe.each([
    'opening',
    'closing',
  ] as const)('%s header validation', (stage) => {
    it.each([
      { label: 'wrong height', patch: { number: 98n } },
      { label: 'numeric height', patch: { number: 97 } },
      { label: 'missing hash', patch: { hash: null } },
      { label: 'short hash', patch: { hash: '0xab' } },
      { label: 'non-hex hash', patch: { hash: `0x${'gg'.repeat(32)}` } },
      { label: 'missing parent', patch: { parentHash: undefined } },
      { label: 'short parent', patch: { parentHash: '0xcd' } },
      { label: 'non-hex parent', patch: { parentHash: `0x${'gg'.repeat(32)}` } },
    ])('rejects $label before publishing evidence', async ({ patch }) => {
      const fixture = setup();

      if (stage === 'closing') {
        fixture.getBlock.mockResolvedValueOnce(header());
      }

      fixture.getBlock.mockResolvedValueOnce({
        ...header(),
        ...patch,
      } as never);

      await expect(fixture.run()).rejects.toThrow(
        'Invalid search lower-bound probe header.',
      );

      if (stage === 'opening') {
        expect(fixture.getBlock).toHaveBeenCalledTimes(1);
        expect(fixture.getTransactionCount).not.toHaveBeenCalled();
      } else {
        expect(fixture.getBlock).toHaveBeenCalledTimes(2);
        expect(fixture.getTransactionCount).toHaveBeenCalledTimes(1);
      }
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
  ])('rejects invalid nonce %# without closing or retrying', async (nonce) => {
    const fixture = setup();
    fixture.getTransactionCount.mockResolvedValueOnce(nonce as never);

    await expect(fixture.run()).rejects.toThrow('Invalid nonce response.');

    expect(fixture.getBlock).toHaveBeenCalledTimes(1);
    expect(fixture.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it.each([
    -1n,
    MAX_UINT256 + 1n,
    97,
    '97',
    null,
  ])('rejects invalid height %# before RPC', async (blockNumber) => {
    const fixture = setup();
    fixture.options.blockNumber = blockNumber as never;

    await expect(fixture.run()).rejects.toThrow(
      'Invalid search lower-bound probe input.',
    );

    expect(fixture.getBlock).not.toHaveBeenCalled();
    expect(fixture.getTransactionCount).not.toHaveBeenCalled();
  });

  it.each([
    '0x11',
    `0x${'gg'.repeat(20)}`,
    null,
  ])('rejects invalid signer %# before RPC', async (signer) => {
    const fixture = setup();
    fixture.options.signer = signer as never;

    await expect(fixture.run()).rejects.toThrow(
      'Invalid search lower-bound probe input.',
    );

    expect(fixture.getBlock).not.toHaveBeenCalled();
    expect(fixture.getTransactionCount).not.toHaveBeenCalled();
  });

  it.each([
    'opening',
    'nonce',
    'closing',
  ] as const)('propagates %s RPC failure with captured diagnostic context', async (stage) => {
    const fixture = setup();
    const failure = new Error('Historical RPC unavailable');

    if (stage === 'nonce') {
      fixture.getTransactionCount.mockRejectedValueOnce(failure);
    } else {
      if (stage === 'closing') {
        fixture.getBlock.mockResolvedValueOnce(header());
      }

      fixture.getBlock.mockRejectedValueOnce(failure);
    }

    const pending = fixture.run();
    fixture.options.blockNumber = 999n;
    fixture.options.scope.finality.confirmations = 99n;

    await expect(pending).rejects.toBe(failure);

    const details = anchoredReadDetails(failure);

    expect(details).toMatchObject({
      operation: 'signer-recovery',
      finality: {
        type: 'confirmations',
        confirmations: '12',
      },
      blockNumber: '97',
    });
    expect(details!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(details!.durationMs)).toBe(true);

    if (stage === 'opening') {
      expect(details!.method).toBe('eth_getBlockByNumber');
      expect(details).not.toHaveProperty('expectedBlockHash');
      expect(fixture.getBlock).toHaveBeenCalledTimes(1);
      expect(fixture.getTransactionCount).not.toHaveBeenCalled();
    } else if (stage === 'nonce') {
      expect(details!.method).toBe('eth_getTransactionCount');
      expect(details!.expectedBlockHash).toBe(HASH);
      expect(fixture.getBlock).toHaveBeenCalledTimes(1);
      expect(fixture.getTransactionCount).toHaveBeenCalledTimes(1);
    } else {
      expect(details!.method).toBe('eth_getBlockByNumber');
      expect(details!.expectedBlockHash).toBe(HASH);
      expect(fixture.getBlock).toHaveBeenCalledTimes(2);
      expect(fixture.getTransactionCount).toHaveBeenCalledTimes(1);
    }
  });
});

it('supports a probe without optional diagnostic scope', async () => {
  const fixture = setup();

  expect(await readSearchLowerBoundProbe({
    publicClient: fixture.options.publicClient,
    signer: SIGNER,
    blockNumber: 97n,
  })).toEqual({
    status: 'verified',
    observation: {
      anchor: { blockNumber: 97n, blockHash: HASH },
      nonce: 4n,
    },
    parentHash: PARENT_HASH,
  });
  expect(fixture.calls).toEqual(['header', 'nonce', 'header']);
});
