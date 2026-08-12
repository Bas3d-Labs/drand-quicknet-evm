import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  PublicClient,
} from 'viem';

import {
  FinalityPolicy,
  getDurableBlockNumber,
} from '../src/finality-policy.js';

const SAFE_BLOCK_NUMBER = 123_456n;
const FINALIZED_BLOCK_NUMBER = 123_400n;
const LATEST_BLOCK_NUMBER = 123_500n;

const getBlock = vi.fn();
const getBlockNumber = vi.fn();

const PUBLIC_CLIENT = {
  getBlock,
  getBlockNumber,
} as unknown as PublicClient;

describe('getDurableBlockNumber', () => {
  beforeEach(() => {
    getBlock.mockReset();
    getBlockNumber.mockReset();
  });

  describe('safe finality', () => {
    const policy: FinalityPolicy = {
      type: 'safe',
    };

    it('returns the safe block number', async () => {
      getBlock.mockResolvedValue({
        number: SAFE_BLOCK_NUMBER,
      });

      const result =
        await getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        );

      expect(result).toBe(
        SAFE_BLOCK_NUMBER
      );
    });

    it('requests the safe block tag', async () => {
      getBlock.mockResolvedValue({
        number: SAFE_BLOCK_NUMBER,
      });

      await getDurableBlockNumber(
        PUBLIC_CLIENT,
        policy,
      );

      expect(
        getBlock,
      ).toHaveBeenCalledOnce();

      expect(
        getBlock,
      ).toHaveBeenCalledWith({
        blockTag: 'safe',
      });
    });

    it('does not request the latest block number', async () => {
      getBlock.mockResolvedValue({
        number: SAFE_BLOCK_NUMBER,
      });

      await getDurableBlockNumber(
        PUBLIC_CLIENT,
        policy,
      );

      expect(
        getBlockNumber,
      ).not.toHaveBeenCalled();
    });

    it('propagates safe block RPC failures', async () => {
      const failure =
        new Error('Safe block unavailable.');

      getBlock.mockRejectedValue(
        failure,
      );

      await expect(
        getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        )
      ).rejects.toBe(
        failure
      );
    });
  });

  describe('finalized finality', () => {
    const policy: FinalityPolicy = {
      type: 'finalized',
    };

    it('returns the finalized block number', async () => {
      getBlock.mockResolvedValue({
        number: FINALIZED_BLOCK_NUMBER,
      });

      const result =
        await getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        );

      expect(result).toBe(
        FINALIZED_BLOCK_NUMBER
      );
    });

    it('requests the finalized block tag', async () => {
      getBlock.mockResolvedValue({
        number: FINALIZED_BLOCK_NUMBER,
      });

      await getDurableBlockNumber(
        PUBLIC_CLIENT,
        policy,
      );

      expect(
        getBlock,
      ).toHaveBeenCalledOnce();

      expect(
        getBlock,
      ).toHaveBeenCalledWith({
        blockTag: 'finalized',
      });
    });

    it('does not request the latest block number', async () => {
      getBlock.mockResolvedValue({
        number: FINALIZED_BLOCK_NUMBER,
      });

      await getDurableBlockNumber(
        PUBLIC_CLIENT,
        policy,
      );

      expect(
        getBlockNumber,
      ).not.toHaveBeenCalled();
    });

    it('propagates finalized block RPC failures', async () => {
      const failure =
        new Error('Finalized block unavailable.');

      getBlock.mockRejectedValue(
        failure,
      );

      await expect(
        getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        )
      ).rejects.toBe(
        failure
      );
    });
  });

  describe('confirmation finality', () => {
    it('subtracts confirmations from the latest block', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: 20n,
      };

      getBlockNumber.mockResolvedValue(
        LATEST_BLOCK_NUMBER,
      );

      const result =
        await getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        );

      expect(result).toBe(
        123_480n
      );
    });

    it('requests the latest block number', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: 20n,
      };

      getBlockNumber.mockResolvedValue(
        LATEST_BLOCK_NUMBER,
      );

      await getDurableBlockNumber(
        PUBLIC_CLIENT,
        policy,
      );

      expect(
        getBlockNumber,
      ).toHaveBeenCalledOnce();
    });

    it('does not request a tagged block', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: 20n,
      };

      getBlockNumber.mockResolvedValue(
        LATEST_BLOCK_NUMBER,
      );

      await getDurableBlockNumber(
        PUBLIC_CLIENT,
        policy,
      );

      expect(
        getBlock,
      ).not.toHaveBeenCalled();
    });

    it('accepts zero confirmations', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: 0n,
      };

      getBlockNumber.mockResolvedValue(
        LATEST_BLOCK_NUMBER,
      );

      const result =
        await getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        );

      expect(result).toBe(
        LATEST_BLOCK_NUMBER
      );
    });

    it('returns block zero when the latest block is less than confirmations', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: 100n,
      };

      getBlockNumber.mockResolvedValue(
        50n,
      );

      const result =
        await getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        );

      expect(result).toBe(
        0n
      );
    });

    it('returns block zero when the latest block equals confirmations', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: 100n,
      };

      getBlockNumber.mockResolvedValue(
        100n,
      );

      const result =
        await getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        );

      expect(result).toBe(
        0n
      );
    });

    it('rejects negative confirmations', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: -1n,
      };

      await expect(
        getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        )
      ).rejects.toThrow(
        'Finality confirmations must not be negative.'
      );
    });

    it('does not access the RPC when confirmations are negative', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: -1n,
      };

      await expect(
        getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        )
      ).rejects.toThrow(
        'Finality confirmations must not be negative.'
      );

      expect(
        getBlockNumber,
      ).not.toHaveBeenCalled();

      expect(
        getBlock,
      ).not.toHaveBeenCalled();
    });

    it('propagates latest block RPC failures', async () => {
      const policy: FinalityPolicy = {
        type: 'confirmations',
        confirmations: 20n,
      };

      const failure = new Error('Latest block unavailable.');

      getBlockNumber.mockRejectedValue(
        failure,
      );

      await expect(
        getDurableBlockNumber(
          PUBLIC_CLIENT,
          policy,
        )
      ).rejects.toBe(
        failure
      );
    });
  });
});

describe('FinalityPolicy.parseJson', () => {
  it('parses safe finality', () => {
    expect(
      FinalityPolicy.parseJson({
        type: 'safe',
      }),
    ).toEqual({
      type: 'safe',
    });
  });

  it('parses finalized finality', () => {
    expect(
      FinalityPolicy.parseJson({
        type: 'finalized',
      }),
    ).toEqual({
      type: 'finalized',
    });
  });

  it('parses confirmation finality', () => {
    expect(
      FinalityPolicy.parseJson({
        type: 'confirmations',
        confirmations: '20',
      }),
    ).toEqual({
      type: 'confirmations',
      confirmations: 20n,
    });
  });

  it('allows zero confirmations', () => {
    expect(
      FinalityPolicy.parseJson({
        type: 'confirmations',
        confirmations: '0',
      }),
    ).toEqual({
      type: 'confirmations',
      confirmations: 0n,
    });
  });

  it('rejects a non-object policy', () => {
    expect(
      () =>
        FinalityPolicy.parseJson(
          'safe',
        ),
    ).toThrow(
      'Finality policy must be an object.'
    );
  });

  it('rejects an unknown policy type', () => {
    expect(
      () =>
        FinalityPolicy.parseJson({
          type: 'unknown',
        }),
    ).toThrow(
      'Finality policy type must be safe, finalized, or confirmations.'
    );
  });

  it('requires confirmations', () => {
    expect(
      () =>
        FinalityPolicy.parseJson({
          type: 'confirmations',
        }),
    ).toThrow(
      'Missing finality policy field: confirmations.'
    );
  });

  it('rejects numeric confirmations', () => {
    expect(
      () =>
        FinalityPolicy.parseJson({
          type: 'confirmations',
          confirmations: 20,
        }),
    ).toThrow(
      'Finality confirmations must be a non-negative decimal integer string.'
    );
  });

  it('rejects negative confirmations', () => {
    expect(
      () =>
        FinalityPolicy.parseJson({
          type: 'confirmations',
          confirmations: '-1',
        }),
    ).toThrow(
      'Finality confirmations must be a non-negative decimal integer string.'
    );
  });

  it('rejects hexadecimal confirmations', () => {
    expect(
      () =>
        FinalityPolicy.parseJson({
          type: 'confirmations',
          confirmations: '0x14',
        }),
    ).toThrow(
      'Finality confirmations must be a non-negative decimal integer string.'
    );
  });

  it('rejects unexpected safe finality fields', () => {
    expect(
      () =>
        FinalityPolicy.parseJson({
          type: 'safe',
          confirmations: '20',
        }),
    ).toThrow(
      'Unexpected finality policy field: confirmations.'
    );
  });
});