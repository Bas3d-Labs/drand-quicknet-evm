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
  inspectNonceSync,
} from '../../src/chain/inspect-nonce-sync.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'11'.repeat(20)}` as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER_HASH = `0x${'bb'.repeat(32)}` as const;

const ANCHOR = {
  blockNumber: 100n,
  blockHash: HASH,
};

const OBSERVATION = {
  anchor: ANCHOR,
  nonce: 8n,
};

interface BlockRequest {
  blockTag?: 'safe' | 'finalized';
  blockNumber?: bigint;
}

interface NonceRequest {
  address: string;
  blockTag?: 'latest' | 'pending';
  blockNumber?: bigint;
}

function setup() {
  const events: string[] = [];

  // Numbered reads are:
  // 1. Select the durable anchor.
  // 2. Verify it before reading the durable nonce.
  // 3. Verify it after reading the durable nonce.
  // 4. Verify it after reading latest and pending.
  let numberedReads = 0;
  let changeAtRead: number | undefined;

  const getChainId = vi.fn(async () => {
    events.push('chain-id');
    return IDENTITY.chainId;
  });

  const getBlockNumber = vi.fn(async () => {
    events.push('latest-head');
    return 110n;
  });

  const getBlock = vi.fn(async (request: BlockRequest) => {
    if (request.blockTag !== undefined) {
      events.push(`head:${request.blockTag}`);

      return {
        number: ANCHOR.blockNumber,
        hash: HASH,
      };
    }

    if (request.blockNumber !== ANCHOR.blockNumber) {
      throw new Error('Unexpected block request.');
    }

    numberedReads += 1;
    events.push(`anchor:${numberedReads}`);

    return {
      number: ANCHOR.blockNumber,
      hash: numberedReads === changeAtRead ? OTHER_HASH : HASH,
    };
  });

  const getTransactionCount = vi.fn(
    async (request: NonceRequest): Promise<number> => {
      if (request.address !== IDENTITY.signer) {
        throw new Error('Unexpected signer.');
      }

      if (request.blockNumber !== undefined) {
        if (request.blockNumber !== ANCHOR.blockNumber) {
          throw new Error('Unexpected nonce anchor.');
        }

        events.push('nonce:durable');
        return 8;
      }

      if (
        request.blockTag !== 'latest' &&
        request.blockTag !== 'pending'
      ) {
        throw new Error('Unexpected nonce tag.');
      }

      events.push(`nonce:${request.blockTag}`);
      return 8;
    },
  );

  const publicClient = {
    getChainId,
    getBlockNumber,
    getBlock,
    getTransactionCount,
  } as unknown as PublicClient;

  return {
    options: {
      publicClient,
      identity: { ...IDENTITY },
      finality: { type: 'safe' as const },
    },
    events,
    getChainId,
    getBlockNumber,
    getBlock,
    getTransactionCount,
    changeAnchorAt(read: number) {
      changeAtRead = read;
    },
  };
}

describe('inspectNonceSync', () => {
  it('verifies the chain before collecting anchored nonce counts', async () => {
    const t = setup();

    const result = await inspectNonceSync(t.options);

    expect(result).toEqual({
      status: 'observed',
      observation: OBSERVATION,
      latestNonce: 8n,
      pendingNonce: 8n,
    });

    expect(Object.isFrozen(result)).toBe(true);

    expect(t.events).toEqual([
      'chain-id',
      'head:safe',
      'latest-head',
      'anchor:1',
      'anchor:2',
      'nonce:durable',
      'anchor:3',
      'nonce:latest',
      'nonce:pending',
      'anchor:4',
    ]);

    expect(t.getChainId).toHaveBeenCalledOnce();

    expect(t.getBlockNumber).toHaveBeenCalledExactlyOnceWith({
      cacheTime: 0,
    });

    expect(t.getTransactionCount.mock.calls).toEqual([
      [{
        address: IDENTITY.signer,
        blockNumber: ANCHOR.blockNumber,
      }],
      [{
        address: IDENTITY.signer,
        blockTag: 'latest',
      }],
      [{
        address: IDENTITY.signer,
        blockTag: 'pending',
      }],
    ]);
  });

  it('rejects the wrong chain before reading blocks or nonces', async () => {
    const t = setup();

    t.getChainId.mockResolvedValueOnce(1);

    await expect(
      inspectNonceSync(t.options),
    ).rejects.toThrow(
      'Nonce sync RPC chain ID does not match journal identity.',
    );

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.getBlockNumber).not.toHaveBeenCalled();
    expect(t.getTransactionCount).not.toHaveBeenCalled();
  });

  it('propagates a chain-ID RPC failure without further reads', async () => {
    const t = setup();
    const failure = new Error('Chain ID unavailable');

    t.getChainId.mockRejectedValueOnce(failure);

    await expect(
      inspectNonceSync(t.options),
    ).rejects.toBe(failure);

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.getBlockNumber).not.toHaveBeenCalled();
    expect(t.getTransactionCount).not.toHaveBeenCalled();
  });

  it.each(['latest', 'pending'] as const)(
    'preserves a differing %s nonce for planner classification',
    async (tag) => {
      const t = setup();
      const read = t.getTransactionCount.getMockImplementation()!;

      t.getTransactionCount.mockImplementation(async (request) => {
        const nonce = await read(request);
        return request.blockTag === tag ? 9 : nonce;
      });

      expect(await inspectNonceSync(t.options)).toEqual({
        status: 'observed',
        observation: OBSERVATION,
        latestNonce: tag === 'latest' ? 9n : 8n,
        pendingNonce: tag === 'pending' ? 9n : 8n,
      });
    },
  );

  it.each([
    {
      phase: 'before the durable nonce read',
      read: 2,
      nonceReads: 0,
    },
    {
      phase: 'after the durable nonce read',
      read: 3,
      nonceReads: 1,
    },
    {
      phase: 'after the live nonce reads',
      read: 4,
      nonceReads: 3,
    },
  ])(
    'reports an anchor change $phase',
    async ({ read, nonceReads }) => {
      const t = setup();

      t.changeAnchorAt(read);

      const result = await inspectNonceSync(t.options);

      expect(result).toEqual({
        status: 'anchor-changed',
        observedAnchor: {
          blockNumber: ANCHOR.blockNumber,
          blockHash: OTHER_HASH,
        },
      });

      expect(t.getTransactionCount).toHaveBeenCalledTimes(nonceReads);
    },
  );

  it('honors cancellation before starting RPC work', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    controller.abort(reason);

    await expect(inspectNonceSync({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.getChainId).not.toHaveBeenCalled();
    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.getBlockNumber).not.toHaveBeenCalled();
    expect(t.getTransactionCount).not.toHaveBeenCalled();
  });

  it('starts no further work when cancelled during the chain-ID read', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    t.getChainId.mockImplementationOnce(async () => {
      controller.abort(reason);
      return IDENTITY.chainId;
    });

    await expect(inspectNonceSync({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.getBlockNumber).not.toHaveBeenCalled();
    expect(t.getTransactionCount).not.toHaveBeenCalled();
  });

  it('returns no observation when cancelled during nonce inspection', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');
    const read = t.getTransactionCount.getMockImplementation()!;

    t.getTransactionCount.mockImplementation(async (request) => {
      const nonce = await read(request);

      if (request.blockTag === 'pending') {
        controller.abort(reason);
      }

      return nonce;
    });

    await expect(inspectNonceSync({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    // The existing inspector finishes its closing anchor check.
    // The outer boundary then rejects instead of exposing the result.
    expect(t.events.at(-1)).toBe('anchor:4');
  });

  it('preserves an RPC failure when cancellation also occurs', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');
    const failure = new Error('Nonce lookup failed');

    t.getTransactionCount.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw failure;
    });

    await expect(inspectNonceSync({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(failure);
  });
});