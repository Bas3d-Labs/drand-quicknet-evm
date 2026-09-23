import {
  beforeEach,
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
  blockAnchorsMatch,
  getBlockAnchor,
  type BlockAnchor,
} from '../../src/chain/block-anchor.js';

const BLOCK_HASH_A =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash;

const BLOCK_HASH_B =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hash;

interface MockPublicClient {
  publicClient: PublicClient;
  getBlock: ReturnType<typeof vi.fn>;
}

function createPublicClient(): MockPublicClient {
  const getBlock = vi.fn();

  const publicClient = {
    getBlock,
  } as unknown as PublicClient;

  return {
    publicClient,
    getBlock,
  };
}

describe('getBlockAnchor', () => {
  let publicClient: PublicClient;
  let getBlock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const client =
      createPublicClient();

    publicClient =
      client.publicClient;

    getBlock =
      client.getBlock;
  });

  it('returns the block number and hash', async () => {
    getBlock.mockResolvedValue({
      hash: BLOCK_HASH_A,
    });

    const result =
      await getBlockAnchor(
        publicClient,
        1_500n,
      );

    expect(result).toEqual({
      blockNumber: 1_500n,
      blockHash: BLOCK_HASH_A,
    });
  });

  it('requests the exact block number', async () => {
    getBlock.mockResolvedValue({
      hash: BLOCK_HASH_A,
    });

    await getBlockAnchor(
      publicClient,
      1_500n,
    );

    expect(
      getBlock,
    ).toHaveBeenCalledOnce();

    expect(
      getBlock,
    ).toHaveBeenCalledWith({
      blockNumber: 1_500n,
    });
  });

  it('supports block zero', async () => {
    getBlock.mockResolvedValue({
      hash: BLOCK_HASH_A,
    });

    const result =
      await getBlockAnchor(
        publicClient,
        0n,
      );

    expect(result).toEqual({
      blockNumber: 0n,
      blockHash: BLOCK_HASH_A,
    });
  });

  it('rejects a negative block number', async () => {
    await expect(
      getBlockAnchor(
        publicClient,
        -1n,
      ),
    ).rejects.toThrow(
      'Block anchor number must not be negative.'
    );

    expect(
      getBlock,
    ).not.toHaveBeenCalled();
  });

  it('propagates block retrieval failures', async () => {
    const failure = new Error('Failed to retrieve block.');

    getBlock.mockRejectedValue(
      failure,
    );

    await expect(
      getBlockAnchor(
        publicClient,
        1_500n,
      ),
    ).rejects.toBe(
      failure,
    );
  });
});

describe('blockAnchorsMatch', () => {
  it('returns true for the same block number and hash', () => {
    const first: BlockAnchor = {
      blockNumber: 1_500n,
      blockHash: BLOCK_HASH_A,
    };

    const second: BlockAnchor = {
      blockNumber: 1_500n,
      blockHash: BLOCK_HASH_A,
    };

    expect(
      blockAnchorsMatch(
        first,
        second,
      ),
    ).toBe(
      true
    );
  });

  it('returns false for different block numbers', () => {
    const first: BlockAnchor = {
      blockNumber: 1_500n,
      blockHash: BLOCK_HASH_A,
    };

    const second: BlockAnchor = {
      blockNumber: 1_501n,
      blockHash: BLOCK_HASH_A,
    };

    expect(
      blockAnchorsMatch(
        first,
        second,
      ),
    ).toBe(
      false
    );
  });

  it('returns false for different block hashes', () => {
    const first: BlockAnchor = {
      blockNumber: 1_500n,
      blockHash: BLOCK_HASH_A,
    };

    const second: BlockAnchor = {
      blockNumber: 1_500n,
      blockHash: BLOCK_HASH_B,
    };

    expect(
      blockAnchorsMatch(
        first,
        second,
      ),
    ).toBe(
      false
    );
  });

  it('compares block hashes case-insensitively', () => {
    const lower =
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Hash;
    const upper = `0x${lower.slice(2).toUpperCase()}` as Hash;

    const first: BlockAnchor = {
      blockNumber: 1_500n,
      blockHash: lower,
    };
    const second: BlockAnchor = {
      blockNumber: 1_500n,
      blockHash: upper,
    };

    expect(
      blockAnchorsMatch(
        first,
        second,
      ),
    ).toBe(
      true
    );
  });
});