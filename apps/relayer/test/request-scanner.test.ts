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
  '../src/request-events.js',
  () => ({
    getQuicknetRandomnessRequests: vi.fn(),
  }),
);

import {
  getQuicknetRandomnessRequests,
  type QuicknetRandomnessRequest,
} from '../src/request-events.js';
import {
  scanQuicknetRequests,
} from '../src/request-scanner.js';

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
        maxBlockRange: 100n,
      }),
    ).rejects.toThrow('nextBlock must not be negative.');

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
        maxBlockRange: 0n,
      }),
    ).rejects.toThrow('maxBlockRange must be greater than zero.');

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
        maxBlockRange: -1n,
      }),
    ).rejects.toThrow('maxBlockRange must be greater than zero.');

    expect(
      getBlockNumber,
    ).not.toHaveBeenCalled();

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('returns caught-up when nextBlock is greater than the chain head', async () => {
    getBlockNumber.mockResolvedValue(
      1_000n,
    );

    const result =
      await scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_001n,
        maxBlockRange: 100n,
      });

    expect(result).toEqual({
      status: 'caught-up',
      headBlock: 1_000n,
      nextBlock: 1_001n,
    });

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('scans when nextBlock equals the chain head', async () => {
    getBlockNumber.mockResolvedValue(
      1_000n,
    );

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'scanned',
      headBlock: 1_000n,
      fromBlock: 1_000n,
      toBlock: 1_000n,
      nextBlock: 1_001n,
      requests: [],
    });
  });

  it('scans one full bounded block range', async () => {
    getBlockNumber.mockResolvedValue(1_500n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [],
    });
  });

  it('truncates the scan range at the chain head', async () => {
    getBlockNumber.mockResolvedValue(1_050n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'scanned',
      headBlock: 1_050n,
      fromBlock: 1_000n,
      toBlock: 1_050n,
      nextBlock: 1_051n,
      requests: [],
    });
  });

  it('scans exactly maxBlockRange blocks', async () => {
    getBlockNumber.mockResolvedValue(1_099n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'scanned',
      headBlock: 1_099n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [],
    });
  });

  it('supports a maxBlockRange of one block', async () => {
    getBlockNumber.mockResolvedValue(1_500n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 1n,
    });

    expect(result).toEqual({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_000n,
      nextBlock: 1_001n,
      requests: [],
    });
  });

  it('queries request events for the selected consumers and block range', async () => {
    getBlockNumber.mockResolvedValue(1_500n);

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
    getBlockNumber.mockResolvedValue(1_500n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue([
      REQUEST,
    ]);

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [
        REQUEST,
      ],
    });
  });

  it('returns a scanned result even when the range contains no requests', async () => {
    getBlockNumber.mockResolvedValue(1_500n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result.status).toBe(
      'scanned',
    );

    if (result.status !== 'scanned') {
      throw new Error('Expected a scanned result.');
    }

    expect(
      result.requests,
    ).toEqual([]);

    expect(
      result.nextBlock,
    ).toBe(1_100n);
  });

  it('supports scanning from block zero', async () => {
    getBlockNumber.mockResolvedValue(500n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    const result = await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 0n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'scanned',
      headBlock: 500n,
      fromBlock: 0n,
      toBlock: 99n,
      nextBlock: 100n,
      requests: [],
    });
  });

  it('reads the chain head once per scan', async () => {
    getBlockNumber.mockResolvedValue(1_500n);

    vi.mocked(
      getQuicknetRandomnessRequests,
    ).mockResolvedValue(
      [],
    );

    await scanQuicknetRequests({
      publicClient,
      consumers: [CONSUMER_A],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(
      getBlockNumber,
    ).toHaveBeenCalledOnce();
  });

  it('propagates getBlockNumber failures', async () => {
    const failure = new Error('Failed to read chain head.');

    getBlockNumber.mockRejectedValue(failure);

    await expect(
      scanQuicknetRequests({
        publicClient,
        consumers: [CONSUMER_A],
        nextBlock: 1_000n,
        maxBlockRange: 100n,
      }),
    ).rejects.toBe(
      failure,
    );

    expect(
      getQuicknetRandomnessRequests,
    ).not.toHaveBeenCalled();
  });

  it('propagates request event retrieval failures', async () => {
    const failure = new Error('Failed to retrieve request events.');

    getBlockNumber.mockResolvedValue(1_500n);

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
        maxBlockRange: 100n,
      }),
    ).rejects.toBe(
      failure,
    );
  });
});