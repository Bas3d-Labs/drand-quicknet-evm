import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  Address,
  PublicClient,
} from 'viem';

vi.mock(
  '../../src/consumers/request-events.js',
  () => ({
    getQuicknetRandomnessRequests: vi.fn(),
  }),
);

import {
  getQuicknetRandomnessRequests,
  type QuicknetRandomnessRequest,
} from '../../src/consumers/request-events.js';
import {
  scanQuicknetRequests,
} from '../../src/consumers/request-scanner.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';

const TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

const REQUEST: QuicknetRandomnessRequest = {
  consumer: CONSUMER_A,
  round: 31_192_648n,
  blockNumber: 1_050n,
  transactionHash: TRANSACTION_HASH,
  logIndex: 3,
};

interface MockPublicClient {
  publicClient: PublicClient;
  getBlockNumber: ReturnType<typeof vi.fn>;
}

function createPublicClient(): MockPublicClient {
  const getBlockNumber = vi.fn();

  const publicClient = {
    getBlockNumber,
  } as unknown as PublicClient;

  return {
    publicClient,
    getBlockNumber,
  };
}

describe('scanQuicknetRequests', () => {
  let publicClient: PublicClient;
  let getBlockNumber: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockReset();

    const client = createPublicClient();

    publicClient = client.publicClient;
    getBlockNumber = client.getBlockNumber;
  });

  it('rejects a negative nextBlock', async () => {
    await expect(
      scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: -1n,
        throughBlock: 1_000n,
        maxBlockRange: 100n,
      }),
    ).rejects.toThrow(
      'nextBlock must not be negative.'
    );

    expect(
      getBlockNumber,
    ).not.toHaveBeenCalled();

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative throughBlock', async () => {
    await expect(
      scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 0n,
        throughBlock: -1n,
        maxBlockRange: 100n,
      }),
    ).rejects.toThrow(
      'throughBlock must not be negative.'
    );

    expect(
      getBlockNumber,
    ).not.toHaveBeenCalled();

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('rejects a zero maxBlockRange', async () => {
    await expect(
      scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_500n,
        maxBlockRange: 0n,
      }),
    ).rejects.toThrow(
      'maxBlockRange must be greater than zero.'
    );

    expect(
      getBlockNumber,
    ).not.toHaveBeenCalled();

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative maxBlockRange', async () => {
    await expect(
      scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_500n,
        maxBlockRange: -1n,
      }),
    ).rejects.toThrow(
      'maxBlockRange must be greater than zero.'
    );

    expect(
      getBlockNumber,
    ).not.toHaveBeenCalled();

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('returns caught-up when nextBlock is greater than throughBlock', async () => {
    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_001n,
        throughBlock: 1_000n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'caught-up',
      throughBlock: 1_000n,
      nextBlock: 1_001n,
    });

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('scans when nextBlock equals throughBlock', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_000n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 1_000n,
      fromBlock: 1_000n,
      toBlock: 1_000n,
      nextBlock: 1_001n,
      requests: [],
    });
  });

  it('scans one full bounded block range', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_500n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [],
    });
  });

  it('truncates the scan range at throughBlock', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_050n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 1_050n,
      fromBlock: 1_000n,
      toBlock: 1_050n,
      nextBlock: 1_051n,
      requests: [],
    });
  });

  it('scans exactly maxBlockRange blocks', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_099n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 1_099n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [],
    });
  });

  it('supports a maxBlockRange of one block', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_500n,
        maxBlockRange: 1n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_000n,
      nextBlock: 1_001n,
      requests: [],
    });
  });

  it('queries request events for the selected consumers and block range', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    await scanQuicknetRequests({
      publicClient,
      consumers: [
        CONSUMER_A,
        CONSUMER_B,
      ],
      nextBlock: 1_000n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });

    expect(
      getQuicknetRandomnessRequests,
    ).toHaveBeenCalledOnce();

    expect(
      getQuicknetRandomnessRequests,
    ).toHaveBeenCalledWith({
      publicClient,
      consumers: [
        CONSUMER_A,
        CONSUMER_B,
      ],
      fromBlock: 1_000n,
      toBlock: 1_099n,
    });
  });

  it('returns request events from the scanned range', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue([
      REQUEST,
    ]);

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_500n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [
        REQUEST,
      ],
    });
  });

  it('returns a scanned result even when the range contains no requests', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_500n,
        maxBlockRange: 100n,
      });

    expect(result.status).toBe(
      'scanned',
    );

    if (result.status !== 'scanned') {
      throw new Error(
        'Expected a scanned result.'
      );
    }

    expect(
      result.requests,
    ).toEqual([]);

    expect(
      result.nextBlock,
    ).toBe(
      1_100n
    );
  });

  it('supports scanning from block zero', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 0n,
        throughBlock: 500n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 500n,
      fromBlock: 0n,
      toBlock: 99n,
      nextBlock: 100n,
      requests: [],
    });
  });

  it('supports scanning only block zero', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 0n,
        throughBlock: 0n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'scanned',
      throughBlock: 0n,
      fromBlock: 0n,
      toBlock: 0n,
      nextBlock: 1n,
      requests: [],
    });
  });

  it('does not determine the chain head itself', async () => {
    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });

    expect(
      getBlockNumber,
    ).not.toHaveBeenCalled();
  });

  it('propagates request event retrieval failures', async () => {
    const failure =
      new Error(
        'Failed to retrieve request events.',
      );

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        throughBlock: 1_500n,
        maxBlockRange: 100n,
      }),
    ).rejects.toBe(
      failure,
    );
  });
});