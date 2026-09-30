import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Account,
  Address,
  Hex,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const registryMocks = vi.hoisted(() => ({
  isStored: vi.fn<
    (round: bigint, blockNumber?: bigint) => Promise<unknown>
  >(),
}));

vi.mock('@based-labs/drand-quicknet-registry', () => ({
  createRegistryReader: vi.fn(() => registryMocks),
}));

vi.mock('../../src/consumers/request-scanner.js', () => ({
  scanQuicknetRequests: vi.fn(),
}));

vi.mock('../../src/rounds/import-round-when-available.js', () => ({
  importQuicknetRoundWhenAvailable: vi.fn(),
}));

import {
  createRegistryReader,
} from '@based-labs/drand-quicknet-registry';

import {
  reconcileDurableRequests,
  type ReconcileDurableRequestsOptions,
} from '../../src/consumers/durable-requests.js';

import type {
  QuicknetRandomnessRequest,
} from '../../src/consumers/request-events.js';

import {
  scanQuicknetRequests,
} from '../../src/consumers/request-scanner.js';

import type {
  ImportQuicknetRoundResult,
} from '../../src/rounds/import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../../src/rounds/import-round-when-available.js';

const CONSUMER: Address =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const OTHER_CONSUMER: Address =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const REGISTRY: Address =
  '0x1111111111111111111111111111111111111111';

const VERIFIER: Address =
  '0x2222222222222222222222222222222222222222';

const HASH_A: Hex = `0x${'11'.repeat(32)}`;
const HASH_B: Hex = `0x${'22'.repeat(32)}`;
const RANDOMNESS: Hex = `0x${'33'.repeat(32)}`;
const TRANSACTION_HASH: Hex = `0x${'44'.repeat(32)}`;

const ROUND_A = 100n;
const ROUND_B = 101n;
const ROUND_C = 102n;

const FROM_BLOCK = 1_000n;
const TO_BLOCK = 1_099n;
const DURABLE_BLOCK = 1_200n;

const ANCHOR = {
  blockNumber: DURABLE_BLOCK,
  blockHash: HASH_A,
};

const DEPLOYMENT: RegistryDeployment = {
  chainId: 12_345,
  address: REGISTRY,
  runtimeCodehash: HASH_A,
  verifierAddress: VERIFIER,
  verifierRuntimeCodehash: HASH_B,
};

const getBlock = vi.fn<
  (options: { blockNumber: bigint }) => Promise<{
    number: bigint;
    hash: Hex;
  }>
>();

const PUBLIC_CLIENT = {
  getBlock,
} as unknown as PublicClient;

const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;

function options(
  overrides: Partial<ReconcileDurableRequestsOptions> = {},
): ReconcileDurableRequestsOptions {
  return {
    publicClient: PUBLIC_CLIENT,
    walletClient: WALLET_CLIENT,
    account: ACCOUNT,
    deployment: DEPLOYMENT,
    consumer: CONSUMER,
    nextBlock: FROM_BLOCK,
    durableBlock: DURABLE_BLOCK,
    maxBlockRange: 100n,
    ...overrides,
  };
}

function request(
  round: bigint,
  blockNumber: bigint,
  overrides: Partial<QuicknetRandomnessRequest> = {},
): QuicknetRandomnessRequest {
  return {
    consumer: CONSUMER,
    round,
    blockNumber,
    transactionHash: TRANSACTION_HASH,
    logIndex: 0,
    ...overrides,
  };
}

function imported(round: bigint): ImportQuicknetRoundResult {
  return {
    status: 'imported',
    submission: 'witness',
    round,
    randomness: RANDOMNESS,
    transactionHash: TRANSACTION_HASH,
  };
}

function setScan(
  requests: readonly QuicknetRandomnessRequest[],
): void {
  vi.mocked(scanQuicknetRequests).mockResolvedValue({
    status: 'scanned',
    throughBlock: DURABLE_BLOCK,
    fromBlock: FROM_BLOCK,
    toBlock: TO_BLOCK,
    nextBlock: TO_BLOCK + 1n,
    requests,
  });
}

describe('reconcileDurableRequests', () => {
  beforeEach(() => {
    getBlock.mockReset().mockResolvedValue({
      number: DURABLE_BLOCK,
      hash: HASH_A,
    });

    registryMocks.isStored.mockReset().mockResolvedValue(true);
    vi.mocked(createRegistryReader).mockClear();

    vi.mocked(scanQuicknetRequests).mockReset();
    setScan([]);

    vi.mocked(importQuicknetRoundWhenAvailable)
      .mockReset()
      .mockImplementation(async ({ round }) => imported(round));
  });

  it.each([
    {
      name: 'negative next block',
      overrides: { nextBlock: -1n },
    },
    {
      name: 'negative durable block',
      overrides: { durableBlock: -1n },
    },
    {
      name: 'zero maximum block range',
      overrides: { maxBlockRange: 0n },
    },
    {
      name: 'negative maximum block range',
      overrides: { maxBlockRange: -1n },
    },
  ])('rejects $name', async ({ overrides }) => {
    await expect(
      reconcileDurableRequests(options(overrides)),
    ).rejects.toThrow('Invalid durable scan bounds.');

    expect(getBlock).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    expect(createRegistryReader).not.toHaveBeenCalled();
  });

  it('returns caught-up before performing any RPC work', async () => {
    const result = await reconcileDurableRequests(options({
      nextBlock: DURABLE_BLOCK + 1n,
    }));

    expect(result).toEqual({
      status: 'caught-up',
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'verified',
        nextBlock: DURABLE_BLOCK + 1n,
      },
    });

    expect(getBlock).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    expect(createRegistryReader).not.toHaveBeenCalled();
  });

  it('defers when the initial anchor is unavailable', async () => {
    const failure = new Error('Anchor unavailable.');
    getBlock.mockRejectedValueOnce(failure);

    const result = await reconcileDurableRequests(options());

    expect(result).toEqual({
      status: 'anchor-unavailable',
      durableBlock: DURABLE_BLOCK,
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'anchor-unavailable',
        error: failure,
      },
    });

    if (result.checkpoint.status !== 'anchor-unavailable') {
      throw new Error('Expected unavailable anchor.');
    }

    expect(result.checkpoint.error).toBe(failure);
    expect(result.checkpoint).not.toHaveProperty('nextBlock');
    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    expect(createRegistryReader).not.toHaveBeenCalled();
  });

  it('rechecks the anchor before advancing an empty scanned range', async () => {
    const result = await reconcileDurableRequests(options());

    expect(scanQuicknetRequests).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [CONSUMER],
      nextBlock: FROM_BLOCK,
      throughBlock: DURABLE_BLOCK,
      maxBlockRange: 100n,
    });

    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(getBlock).toHaveBeenNthCalledWith(1, {
      blockNumber: DURABLE_BLOCK,
    });
    expect(getBlock).toHaveBeenNthCalledWith(2, {
      blockNumber: DURABLE_BLOCK,
    });

    expect(result).toEqual({
      status: 'scanned',
      fromBlock: FROM_BLOCK,
      toBlock: TO_BLOCK,
      anchor: ANCHOR,
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'verified',
        nextBlock: TO_BLOCK + 1n,
      },
    });

    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    expect(registryMocks.isStored).not.toHaveBeenCalled();
  });

  it('rejects checkpoint advancement for an empty scan if the anchor changes', async () => {
    getBlock
      .mockResolvedValueOnce({
        number: DURABLE_BLOCK,
        hash: HASH_A,
      })
      .mockResolvedValueOnce({
        number: DURABLE_BLOCK,
        hash: HASH_B,
      });

    const result = await reconcileDurableRequests(options());

    expect(result.status).toBe('scanned');
    expect(result.checkpoint).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: DURABLE_BLOCK,
        blockHash: HASH_B,
      },
    });
    expect(result.checkpoint).not.toHaveProperty('nextBlock');
  });

  it('advances past the scanned range when every round is durably stored', async () => {
    setScan([
      request(ROUND_A, 1_010n),
      request(ROUND_B, 1_020n),
    ]);

    const result = await reconcileDurableRequests(options());

    expect(createRegistryReader).toHaveBeenCalledExactlyOnceWith({
      client: PUBLIC_CLIENT,
      deployment: DEPLOYMENT,
    });

    expect(registryMocks.isStored).toHaveBeenCalledTimes(2);
    expect(registryMocks.isStored).toHaveBeenNthCalledWith(
      1,
      ROUND_A,
      DURABLE_BLOCK,
    );
    expect(registryMocks.isStored).toHaveBeenNthCalledWith(
      2,
      ROUND_B,
      DURABLE_BLOCK,
    );

    expect(result.fulfillment).toEqual([
      {
        round: ROUND_A,
        firstRequestBlock: 1_010n,
        fulfillment: { status: 'stored' },
      },
      {
        round: ROUND_B,
        firstRequestBlock: 1_020n,
        fulfillment: { status: 'stored' },
      },
    ]);

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: TO_BLOCK + 1n,
    });
  });

  it('holds at the earliest unresolved request regardless of log order', async () => {
    setScan([
      request(ROUND_A, 1_080n),
      request(ROUND_B, 1_020n),
      request(ROUND_C, 1_050n),
    ]);

    registryMocks.isStored.mockImplementation(async (round) => {
      return round === ROUND_C;
    });

    const result = await reconcileDurableRequests(options());

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: 1_020n,
    });
    expect(registryMocks.isStored).toHaveBeenCalledTimes(3);
  });

  it('does not advance when the first request at the cursor is unresolved', async () => {
    setScan([request(ROUND_A, FROM_BLOCK)]);
    registryMocks.isStored.mockResolvedValue(false);

    const result = await reconcileDurableRequests(options());

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: FROM_BLOCK,
    });
  });

  it('does not pass a block containing both stored and unresolved requests', async () => {
    setScan([
      request(ROUND_A, 1_020n, { logIndex: 0 }),
      request(ROUND_B, 1_020n, { logIndex: 1 }),
    ]);

    registryMocks.isStored
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await reconcileDurableRequests(options());

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: 1_020n,
    });
  });

  it('deduplicates rounds while retaining their earliest request block', async () => {
    setScan([
      request(ROUND_A, 1_080n),
      request(ROUND_B, 1_050n),
      request(ROUND_A, 1_010n),
    ]);

    registryMocks.isStored.mockImplementation(async (round) => {
      return round === ROUND_B;
    });

    const result = await reconcileDurableRequests(options());

    expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledTimes(2);
    expect(registryMocks.isStored).toHaveBeenCalledTimes(2);

    expect(result.imports).toEqual([
      {
        status: 'completed',
        round: ROUND_A,
        firstRequestBlock: 1_010n,
        result: imported(ROUND_A),
      },
      {
        status: 'completed',
        round: ROUND_B,
        firstRequestBlock: 1_050n,
        result: imported(ROUND_B),
      },
    ]);

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: 1_010n,
    });
  });

  it('retains a successful import without treating it as durable fulfillment', async () => {
    setScan([request(ROUND_A, 1_030n)]);
    registryMocks.isStored.mockResolvedValue(false);

    const onCompleted = vi.fn();

    const result = await reconcileDurableRequests(options({
      onCompleted,
    }));

    expect(onCompleted).toHaveBeenCalledExactlyOnceWith({
      round: ROUND_A,
      result: imported(ROUND_A),
    });

    expect(result.imports).toEqual([
      {
        status: 'completed',
        round: ROUND_A,
        firstRequestBlock: 1_030n,
        result: imported(ROUND_A),
      },
    ]);

    expect(result.fulfillment).toEqual([
      {
        round: ROUND_A,
        firstRequestBlock: 1_030n,
        fulfillment: { status: 'not-stored' },
      },
    ]);

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: 1_030n,
    });
  });

  it('distinguishes unavailable fulfillment from not-stored and continues checking', async () => {
    const failure = new Error('Historical state unavailable.');

    setScan([
      request(ROUND_A, 1_010n),
      request(ROUND_B, 1_020n),
      request(ROUND_C, 1_030n),
    ]);

    registryMocks.isStored
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(false);

    const result = await reconcileDurableRequests(options());

    expect(result.fulfillment).toEqual([
      {
        round: ROUND_A,
        firstRequestBlock: 1_010n,
        fulfillment: { status: 'stored' },
      },
      {
        round: ROUND_B,
        firstRequestBlock: 1_020n,
        fulfillment: {
          status: 'unavailable',
          error: failure,
        },
      },
      {
        round: ROUND_C,
        firstRequestBlock: 1_030n,
        fulfillment: { status: 'not-stored' },
      },
    ]);

    const state = result.fulfillment[1]?.fulfillment;

    if (state?.status !== 'unavailable') {
      throw new Error('Expected unavailable fulfillment.');
    }

    expect(state.error).toBe(failure);
    expect(registryMocks.isStored).toHaveBeenCalledTimes(3);
    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: 1_020n,
    });
  });

  it.each([undefined, null, 'true', 1])(
    'treats a malformed storage response as unavailable: %s',
    async (value) => {
      setScan([request(ROUND_A, 1_010n)]);
      registryMocks.isStored.mockResolvedValue(value);

      const result = await reconcileDurableRequests(options());
      const state = result.fulfillment[0]?.fulfillment;

      if (state?.status !== 'unavailable') {
        throw new Error('Expected unavailable fulfillment.');
      }

      expect(state.error).toBeInstanceOf(TypeError);
      expect(result.checkpoint).toEqual({
        status: 'verified',
        nextBlock: 1_010n,
      });
    },
  );

  it('invalidates all checkpoint progress after an anchor change', async () => {
    setScan([request(ROUND_A, 1_010n)]);

    getBlock
      .mockResolvedValueOnce({
        number: DURABLE_BLOCK,
        hash: HASH_A,
      })
      .mockResolvedValueOnce({
        number: DURABLE_BLOCK,
        hash: HASH_B,
      });

    const onCompleted = vi.fn();

    const result = await reconcileDurableRequests(options({
      onCompleted,
    }));

    expect(result.checkpoint).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: DURABLE_BLOCK,
        blockHash: HASH_B,
      },
    });
    expect(result.checkpoint).not.toHaveProperty('nextBlock');

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.status).toBe('completed');
    expect(result.fulfillment).toEqual([
      {
        round: ROUND_A,
        firstRequestBlock: 1_010n,
        fulfillment: { status: 'stored' },
      },
    ]);
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it('retains completed imports when the final anchor read fails', async () => {
    const failure = new Error('Final anchor read failed.');
    setScan([request(ROUND_A, 1_010n)]);

    getBlock
      .mockResolvedValueOnce({
        number: DURABLE_BLOCK,
        hash: HASH_A,
      })
      .mockRejectedValueOnce(failure);

    const onCompleted = vi.fn();

    const result = await reconcileDurableRequests(options({
      onCompleted,
    }));

    expect(result.status).toBe('scanned');
    expect(result.checkpoint).toEqual({
      status: 'anchor-unavailable',
      error: failure,
    });

    if (result.checkpoint.status !== 'anchor-unavailable') {
      throw new Error('Expected unavailable anchor.');
    }

    expect(result.checkpoint.error).toBe(failure);
    expect(result.checkpoint).not.toHaveProperty('nextBlock');
    expect(result.imports[0]?.status).toBe('completed');
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'checks failed and deferred rounds for durable fulfillment: stored=%s',
    async (stored) => {
      const failure = new Error('Round B import failed.');

      setScan([
        request(ROUND_A, 1_010n),
        request(ROUND_B, 1_020n),
        request(ROUND_C, 1_030n),
      ]);

      vi.mocked(importQuicknetRoundWhenAvailable)
        .mockResolvedValueOnce(imported(ROUND_A))
        .mockRejectedValueOnce(failure);

      registryMocks.isStored
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(stored)
        .mockResolvedValueOnce(stored);

      const onCompleted = vi.fn();

      const result = await reconcileDurableRequests(options({
        onCompleted,
      }));

      expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledTimes(2);

      expect(result.imports).toEqual([
        {
          status: 'completed',
          round: ROUND_A,
          firstRequestBlock: 1_010n,
          result: imported(ROUND_A),
        },
        {
          status: 'failed',
          round: ROUND_B,
          firstRequestBlock: 1_020n,
          error: failure,
        },
        {
          status: 'deferred',
          round: ROUND_C,
          firstRequestBlock: 1_030n,
          reason: 'earlier-import-failed',
        },
      ]);

      const failed = result.imports[1];

      if (failed?.status !== 'failed') {
        throw new Error('Expected failed import.');
      }

      expect(failed.error).toBe(failure);

      expect(registryMocks.isStored).toHaveBeenCalledTimes(3);
      expect(registryMocks.isStored).toHaveBeenNthCalledWith(
        2,
        ROUND_B,
        DURABLE_BLOCK,
      );
      expect(registryMocks.isStored).toHaveBeenNthCalledWith(
        3,
        ROUND_C,
        DURABLE_BLOCK,
      );

      let expectedNextBlock = 1_020n;

      if (stored) {
        expectedNextBlock = TO_BLOCK + 1n;
      }

      expect(result.checkpoint).toEqual({
        status: 'verified',
        nextBlock: expectedNextBlock,
      });

      expect(onCompleted).toHaveBeenCalledExactlyOnceWith({
        round: ROUND_A,
        result: imported(ROUND_A),
      });
    },
  );

  it('brackets scanning, imports, and fulfillment reads with the same anchor', async () => {
    const calls: string[] = [];

    getBlock.mockImplementation(async ({ blockNumber }) => {
      calls.push(`anchor:${blockNumber}`);

      return {
        number: blockNumber,
        hash: HASH_A,
      };
    });

    vi.mocked(scanQuicknetRequests).mockImplementation(async () => {
      calls.push('scan');

      return {
        status: 'scanned',
        throughBlock: DURABLE_BLOCK,
        fromBlock: FROM_BLOCK,
        toBlock: TO_BLOCK,
        nextBlock: TO_BLOCK + 1n,
        requests: [
          request(ROUND_A, 1_010n),
          request(ROUND_B, 1_020n),
        ],
      };
    });

    vi.mocked(importQuicknetRoundWhenAvailable)
      .mockImplementation(async ({ round }) => {
        calls.push(`import:${round}`);
        return imported(round);
      });

    registryMocks.isStored.mockImplementation(
      async (round, blockNumber) => {
        calls.push(`stored:${round}:${blockNumber}`);
        return true;
      },
    );

    await reconcileDurableRequests(options());

    expect(calls).toEqual([
      `anchor:${DURABLE_BLOCK}`,
      'scan',
      `import:${ROUND_A}`,
      `import:${ROUND_B}`,
      `stored:${ROUND_A}:${DURABLE_BLOCK}`,
      `stored:${ROUND_B}:${DURABLE_BLOCK}`,
      `anchor:${DURABLE_BLOCK}`,
    ]);
  });

  it('propagates a log-scan failure unchanged', async () => {
    const failure = new Error('Log scan failed.');
    vi.mocked(scanQuicknetRequests).mockRejectedValue(failure);

    await expect(
      reconcileDurableRequests(options()),
    ).rejects.toBe(failure);

    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    expect(createRegistryReader).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'another consumer',
      entry: request(ROUND_A, 1_010n, {
        consumer: OTHER_CONSUMER,
      }),
    },
    {
      name: 'a block before the scanned range',
      entry: request(ROUND_A, FROM_BLOCK - 1n),
    },
    {
      name: 'a block after the scanned range',
      entry: request(ROUND_A, TO_BLOCK + 1n),
    },
  ])('rejects a request from $name', async ({ entry }) => {
    setScan([entry]);

    await expect(
      reconcileDurableRequests(options()),
    ).rejects.toThrow('Request log is outside the durable scan.');

    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    expect(createRegistryReader).not.toHaveBeenCalled();
  });

  it('accepts consumer addresses with different letter casing', async () => {
    setScan([
      request(ROUND_A, 1_010n, {
        consumer: `0x${'AA'.repeat(20)}` as Address,
      }),
    ]);

    const result = await reconcileDurableRequests(options());

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: TO_BLOCK + 1n,
    });
    expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledOnce();
  });

  it('preserves block zero in anchor and fulfillment reads', async () => {
    getBlock.mockResolvedValue({
      number: 0n,
      hash: HASH_A,
    });

    vi.mocked(scanQuicknetRequests).mockResolvedValue({
      status: 'scanned',
      throughBlock: 0n,
      fromBlock: 0n,
      toBlock: 0n,
      nextBlock: 1n,
      requests: [request(ROUND_A, 0n)],
    });

    const result = await reconcileDurableRequests(options({
      nextBlock: 0n,
      durableBlock: 0n,
      maxBlockRange: 1n,
    }));

    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(getBlock).toHaveBeenNthCalledWith(1, {
      blockNumber: 0n,
    });
    expect(getBlock).toHaveBeenNthCalledWith(2, {
      blockNumber: 0n,
    });

    expect(registryMocks.isStored).toHaveBeenCalledExactlyOnceWith(
      ROUND_A,
      0n,
    );

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: 1n,
    });
  });

  it('continues reconciliation when a completion observer throws', async () => {
    setScan([
      request(ROUND_A, 1_010n),
      request(ROUND_B, 1_020n),
    ]);

    const onCompleted = vi.fn(() => {
      throw new Error('Reporting failed.');
    });

    const result = await reconcileDurableRequests(options({
      onCompleted,
    }));

    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledTimes(2);
    expect(registryMocks.isStored).toHaveBeenCalledTimes(2);

    expect(result.imports.map(outcome => outcome.status)).toEqual([
      'completed',
      'completed',
    ]);

    expect(result.checkpoint).toEqual({
      status: 'verified',
      nextBlock: TO_BLOCK + 1n,
    });
  });
});