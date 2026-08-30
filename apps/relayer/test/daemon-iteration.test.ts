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

vi.mock(
  '../src/chain-heads.js',
  () => ({
    getChainHeads: vi.fn(),
  }),
);

vi.mock(
  '../src/request-processor.js',
  () => ({
    processQuicknetRequests: vi.fn(),
  }),
);

vi.mock(
  '../src/request-scanner.js',
  () => ({
    scanQuicknetRequests: vi.fn(),
  }),
);

import {
  getChainHeads,
} from '../src/chain-heads.js';

import type {
  CheckpointStore,
} from '../src/checkpoint.js';

import {
  runDaemonIteration,
} from '../src/daemon-iteration.js';

import type {
  FinalityPolicy,
} from '../src/finality-policy.js';

import {
  processQuicknetRequests,
  type ProcessQuicknetRequestsResult,
} from '../src/request-processor.js';

import type {
  QuicknetRandomnessRequest,
} from '../src/request-events.js';

import {
  scanQuicknetRequests,
} from '../src/request-scanner.js';

const CONSUMER: Address = '0x1111111111111111111111111111111111111111';
const REGISTRY_ADDRESS: Address = '0x2222222222222222222222222222222222222222';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const TRANSACTION_HASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ORACLE_ADDRESS = '0x5555555555555555555555555555555555555555';
const ORACLE_RUNTIME_CODEHASH =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;

const FINALITY: FinalityPolicy = {
  type: 'safe',
};

const DEPLOYMENT: RegistryDeployment = {
  chainId: 46630,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
  oracleAddress: ORACLE_ADDRESS,
  oracleRuntimeCodehash: ORACLE_RUNTIME_CODEHASH,
};

const REQUEST: QuicknetRandomnessRequest = {
  consumer: CONSUMER,
  round: 31_192_648n,
  blockNumber: 1_050n,
  transactionHash: TRANSACTION_HASH,
  logIndex: 3,
};

const PROCESSING_RESULT: ProcessQuicknetRequestsResult = {
  rounds: [],
};

interface MockCheckpointStore {
  checkpointStore: CheckpointStore;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function createCheckpointStore(): MockCheckpointStore {
  const load = vi.fn();
  const save = vi.fn();

  const checkpointStore = {
    load,
    save,
  } as unknown as CheckpointStore;

  return {
    checkpointStore,
    load,
    save,
  };
}

function firstInvocationOrder(
  mock: {
    mock: {
      invocationCallOrder: number[];
    };
  },
): number {
  const order =
    mock.mock.invocationCallOrder[0];

  if (order === undefined) {
    throw new Error(
      'Expected mock to have been called.'
    );
  }

  return order;
}

describe('runDaemonIteration', () => {
  let checkpointStore: CheckpointStore;
  let load: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(
      getChainHeads,
    ).mockReset();

    vi.mocked(
      scanQuicknetRequests,
    ).mockReset();

    vi.mocked(
      processQuicknetRequests,
    ).mockReset();

    const checkpoint =
      createCheckpointStore();

    checkpointStore =
      checkpoint.checkpointStore;

    load =
      checkpoint.load;

    save =
      checkpoint.save;

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_200n,
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue(
      PROCESSING_RESULT
    );
  });

  it('rejects a negative startBlock', async () => {
    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: -1n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toThrow(
      'startBlock must not be negative.'
    );

    expect(
      load,
    ).not.toHaveBeenCalled();

    expect(
      getChainHeads,
    ).not.toHaveBeenCalled();

    expect(
      scanQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      processQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('rejects a zero maxBlockRange', async () => {
    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 1_000n,
        maxBlockRange: 0n,
        finality: FINALITY,
      })
    ).rejects.toThrow(
      'maxBlockRange must be greater than zero.'
    );

    expect(
      load,
    ).not.toHaveBeenCalled();

    expect(
      getChainHeads,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative maxBlockRange', async () => {
    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 1_000n,
        maxBlockRange: -1n,
        finality: FINALITY,
      })
    ).rejects.toThrow(
      'maxBlockRange must be greater than zero.'
    );

    expect(
      load,
    ).not.toHaveBeenCalled();

    expect(
      getChainHeads,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative soft cursor', async () => {
    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursor: {
          nextBlock: -1n,
        },
      })
    ).rejects.toThrow(
      'Soft cursor nextBlock must not be negative.'
    );

    expect(
      load,
    ).not.toHaveBeenCalled();

    expect(
      getChainHeads,
    ).not.toHaveBeenCalled();
  });

  it('loads the checkpoint for the current consumer', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    expect(
      load,
    ).toHaveBeenCalledOnce();

    expect(
      load,
    ).toHaveBeenCalledWith(
      CONSUMER
    );
  });

  it('loads the checkpoint before reading chain heads', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    expect(
      firstInvocationOrder(
        load
      )
    ).toBeLessThan(
      firstInvocationOrder(
        vi.mocked(
          getChainHeads
        )
      )
    );
  });

  it('uses the configured finality policy', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    expect(
      getChainHeads,
    ).toHaveBeenCalledOnce();

    expect(
      getChainHeads,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      finality: FINALITY,
    });
  });

  it('uses startBlock as the durable cursor when no checkpoint exists', async () => {
    load.mockResolvedValue(
      undefined
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 1_000n,
        throughBlock: 1_200n,
        maxBlockRange: 100n,
      },
    );
  });

  it('uses the persisted checkpoint instead of startBlock for durable scanning', async () => {
    load.mockResolvedValue(
      1_100n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_100n,
        toBlock: 1_199n,
        nextBlock: 1_200n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 1_100n,
        throughBlock: 1_200n,
        maxBlockRange: 100n,
      },
    );
  });

  it('continues soft scanning when the durable head regresses', async () => {
    load.mockResolvedValue(
      1_301n
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_250n,
    });

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValueOnce({
      status: 'scanned',
      throughBlock: 1_500n,
      fromBlock: 1_400n,
      toBlock: 1_499n,
      nextBlock: 1_500n,
      requests: [
        REQUEST,
      ],
    });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursor: {
          nextBlock: 1_400n,
        },
      });

    expect(
      processQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      processQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        REQUEST,
      ],
    });

    expect(
      save,
    ).not.toHaveBeenCalled();

    expect(
      result.durableNextBlock,
    ).toBe(
      1_301n
    );

    expect(
      result.durableHeadRegressed,
    ).toBe(
      true
    );
  });

  it('skips durable scanning when the checkpoint is caught up to the durable head', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_200n,
    });

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValueOnce({
      status: 'scanned',
      throughBlock: 1_500n,
      fromBlock: 1_201n,
      toBlock: 1_300n,
      nextBlock: 1_301n,
      requests: [],
    });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [
        CONSUMER,
      ],
      nextBlock: 1_201n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });

    expect(
      save,
    ).not.toHaveBeenCalled();

    expect(
      result.durableHeadRegressed,
    ).toBe(
      false
    );
  });

  it('starts soft scanning at the checkpoint after a durable head regression on restart', async () => {
    load.mockResolvedValue(
      1_301n
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_250n,
    });

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValueOnce({
      status: 'scanned',
      throughBlock: 1_500n,
      fromBlock: 1_301n,
      toBlock: 1_400n,
      nextBlock: 1_401n,
      requests: [],
    });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [
        CONSUMER,
      ],
      nextBlock: 1_301n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });

    expect(
      save,
    ).not.toHaveBeenCalled();

    expect(
      result.durableNextBlock,
    ).toBe(
      1_301n
    );

    expect(
      result.durableHeadRegressed,
    ).toBe(
      true
    );
  });

  it('allows an initial startBlock ahead of the durable head', async () => {
    load.mockResolvedValue(
      undefined
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 999n,
    });

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      result.durableHeadRegressed,
    ).toBe(
      false
    );

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [
        CONSUMER,
      ],
      nextBlock: 1_000n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });
  });

  it('scans durable history only through the durable block', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 1_000n,
        throughBlock: 1_200n,
        maxBlockRange: 100n,
      },
    );
  });

  it('processes durable requests returned by the scanner', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [
          REQUEST,
        ],
      })
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    expect(
      processQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        requests: [
          REQUEST,
        ],
      },
    );
  });

  it('advances the durable checkpoint after successful processing', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    expect(
      save,
    ).toHaveBeenCalledOnce();

    expect(
      save,
    ).toHaveBeenCalledWith(
      CONSUMER,
      1_100n
    );
  });

  it('advances the durable checkpoint for an empty successfully scanned range', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    expect(
      processQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [],
    });

    expect(
      save,
    ).toHaveBeenCalledWith(
      CONSUMER,
      1_100n
    );
  });

  it('processes durable requests before advancing the checkpoint', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [
          REQUEST,
        ],
      })
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    expect(
      firstInvocationOrder(
        vi.mocked(
          processQuicknetRequests
        )
      )
    ).toBeLessThan(
      firstInvocationOrder(
        save
      )
    );
  });

  it('does not save the durable checkpoint when durable processing fails', async () => {
    const failure =
      new Error(
        'Durable request processing failed.',
      );

    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValueOnce({
      status: 'scanned',
      throughBlock: 1_200n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [
        REQUEST,
      ],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockRejectedValue(
      failure
    );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      save,
    ).not.toHaveBeenCalled();

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();
  });

  it('does not run the soft scan when durable checkpoint saving fails', async () => {
    const failure =
      new Error(
        'Checkpoint save failed.',
      );

    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValueOnce({
      status: 'scanned',
      throughBlock: 1_200n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [],
    });

    save.mockRejectedValue(
      failure
    );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();
  });

  it('starts soft scanning after the durable head when durable history has a backlog', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      2,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 1_201n,
        throughBlock: 1_500n,
        maxBlockRange: 100n,
      },
    );
  });

  it('preserves a soft cursor that is ahead of the durable boundary', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_400n,
        toBlock: 1_499n,
        nextBlock: 1_500n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_400n,
      },
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [
        CONSUMER,
      ],
      nextBlock: 1_400n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });
  });

  it('moves a stale soft cursor forward to the first non-durable block', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_100n,
      },
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [
        CONSUMER,
      ],
      nextBlock: 1_201n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });
  });

  it('moves the soft cursor forward when finality overtakes it', async () => {
    load.mockResolvedValue(
      1_301n
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_600n,
      durableBlock: 1_500n,
    });

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_301n,
        toBlock: 1_400n,
        nextBlock: 1_401n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_600n,
        fromBlock: 1_501n,
        toBlock: 1_600n,
        nextBlock: 1_601n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursor: {
        nextBlock: 1_350n,
      },
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      2,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 1_501n,
        throughBlock: 1_600n,
        maxBlockRange: 100n,
      },
    );
  });

  it('uses the initial startBlock for soft scanning when it is ahead of the durable boundary', async () => {
    load.mockResolvedValue(
      undefined
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_000n,
    });

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_200n,
        toBlock: 1_299n,
        nextBlock: 1_300n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 1_200n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [
        CONSUMER,
      ],
      nextBlock: 1_200n,
      throughBlock: 1_500n,
      maxBlockRange: 100n,
    });
  });

  it('processes soft requests returned by the scanner', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [
          REQUEST,
        ],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      processQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      processQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        REQUEST,
      ],
    });
  });

  it('advances the in-memory soft cursor after successful processing', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      result.softCursor,
    ).toEqual({
      nextBlock: 1_301n,
    });
  });

  it('does not persist soft scan progress', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      save,
    ).not.toHaveBeenCalled();

    expect(
      result.durableNextBlock,
    ).toBe(
      1_201n
    );

    expect(
      result.softCursor.nextBlock,
    ).toBe(
      1_301n
    );
  });

  it('advances the soft cursor for an empty successfully scanned range', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      processQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [],
    });

    expect(
      result.softCursor.nextBlock,
    ).toBe(
      1_301n
    );
  });

  it('does not persist soft progress when soft request processing fails', async () => {
    const failure =
      new Error(
        'Soft request processing failed.',
      );

    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [
          REQUEST,
        ],
      });

    vi.mocked(
      processQuicknetRequests,
    ).mockRejectedValue(
      failure
    );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('keeps successful durable progress when later soft processing fails', async () => {
    const failure =
      new Error(
        'Soft request processing failed.',
      );

    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [
          REQUEST,
        ],
      });

    vi.mocked(
      processQuicknetRequests,
    )
      .mockResolvedValueOnce(
        PROCESSING_RESULT
      )
      .mockRejectedValueOnce(
        failure
      );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      save,
    ).toHaveBeenCalledOnce();

    expect(
      save,
    ).toHaveBeenCalledWith(
      CONSUMER,
      1_100n
    );
  });

  it('returns caught-up when neither durable nor soft history needs scanning', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_200n,
    });

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursor: {
          nextBlock: 1_501n,
        },
      });

    expect(result).toEqual({
      status: 'caught-up',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_201n,
      durableHeadRegressed: false,
      softCursor: {
        nextBlock: 1_501n,
      },
      durableScan: undefined,
      softScan: undefined,
    });

    expect(
      processQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('returns processed when only durable history is scanned', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'caught-up',
        throughBlock: 1_500n,
        nextBlock: 1_501n,
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursor: {
          nextBlock: 1_501n,
        },
      });

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_100n,
      durableHeadRegressed: false,
      softCursor: {
        nextBlock: 1_501n,
      },
      durableScan: {
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        processing: PROCESSING_RESULT,
      },
      softScan: undefined,
    });
  });

  it('returns processed when only soft history is scanned', async () => {
    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_201n,
      durableHeadRegressed: false,
      softCursor: {
        nextBlock: 1_301n,
      },
      durableScan: undefined,
      softScan: {
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        processing: PROCESSING_RESULT,
      },
    });
  });

  it('returns both durable and soft scan results when both paths make progress', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_100n,
      durableHeadRegressed: false,
      softCursor: {
        nextBlock: 1_301n,
      },
      durableScan: {
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        processing: PROCESSING_RESULT,
      },
      softScan: {
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        processing: PROCESSING_RESULT,
      },
    });
  });

  it('runs the durable scan before the soft scan', async () => {
    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledTimes(
      2
    );

    const firstCall =
      vi.mocked(
        scanQuicknetRequests
      ).mock.calls[0];

    const secondCall =
      vi.mocked(
        scanQuicknetRequests
      ).mock.calls[1];

    expect(
      firstCall?.[0].throughBlock,
    ).toBe(
      1_200n
    );

    expect(
      secondCall?.[0].throughBlock,
    ).toBe(
      1_500n
    );
  });

  it('propagates checkpoint loading failures before reading chain heads', async () => {
    const failure =
      new Error(
        'Checkpoint load failed.',
      );

    load.mockRejectedValue(
      failure
    );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      getChainHeads,
    ).not.toHaveBeenCalled();

    expect(
      scanQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      processQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('propagates chain head failures before scanning', async () => {
    const failure =
      new Error(
        'Failed to read chain heads.',
      );

    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      getChainHeads,
    ).mockRejectedValue(
      failure
    );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      scanQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      processQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('propagates durable scan failures before processing or saving', async () => {
    const failure =
      new Error(
        'Durable request scan failed.',
      );

    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    ).mockRejectedValueOnce(
      failure
    );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      processQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('propagates soft scan failures without changing the durable checkpoint when no durable progress occurred', async () => {
    const failure =
      new Error(
        'Soft request scan failed.',
      );

    load.mockResolvedValue(
      1_201n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockRejectedValueOnce(
        failure
      );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      save,
    ).not.toHaveBeenCalled();

    expect(
      processQuicknetRequests,
    ).not.toHaveBeenCalled();
  });

  it('keeps successful durable progress when the later soft scan fails', async () => {
    const failure =
      new Error(
        'Soft request scan failed.',
      );

    load.mockResolvedValue(
      1_000n
    );

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        requests: [],
      })
      .mockRejectedValueOnce(
        failure
      );

    await expect(
      runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      save,
    ).toHaveBeenCalledOnce();

    expect(
      save,
    ).toHaveBeenCalledWith(
      CONSUMER,
      1_100n
    );
  });

  it('supports block zero as the initial start block', async () => {
    load.mockResolvedValue(
      undefined
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 500n,
      durableBlock: 199n,
    });

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 199n,
        fromBlock: 0n,
        toBlock: 99n,
        nextBlock: 100n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 500n,
        fromBlock: 200n,
        toBlock: 299n,
        nextBlock: 300n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 0n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 0n,
        throughBlock: 199n,
        maxBlockRange: 100n,
      },
    );

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      2,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 200n,
        throughBlock: 500n,
        maxBlockRange: 100n,
      },
    );

    expect(
      result.durableNextBlock,
    ).toBe(
      100n
    );

    expect(
      result.softCursor.nextBlock,
    ).toBe(
      300n
    );
  });

  it('resumes durable scanning after the durable head recovers', async () => {
    load.mockResolvedValue(
      1_301n
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_600n,
      durableBlock: 1_400n,
    });

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_400n,
        fromBlock: 1_301n,
        toBlock: 1_400n,
        nextBlock: 1_401n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_600n,
        fromBlock: 1_401n,
        toBlock: 1_500n,
        nextBlock: 1_501n,
        requests: [],
      });

    const result =
      await runDaemonIteration({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore,
        consumer: CONSUMER,
        startBlock: 500n,
        maxBlockRange: 100n,
        finality: FINALITY,
      });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 1_301n,
        throughBlock: 1_400n,
        maxBlockRange: 100n,
      },
    );

    expect(
      save,
    ).toHaveBeenCalledWith(
      CONSUMER,
      1_401n
    );

    expect(
      result.durableHeadRegressed,
    ).toBe(
      false
    );
  });

  it('scans the durable block when it equals the durable cursor', async () => {
    load.mockResolvedValue(
      1_200n
    );

    vi.mocked(
      getChainHeads,
    ).mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_200n,
    });

    vi.mocked(
      scanQuicknetRequests,
    )
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_200n,
        fromBlock: 1_200n,
        toBlock: 1_200n,
        nextBlock: 1_201n,
        requests: [],
      })
      .mockResolvedValueOnce({
        status: 'scanned',
        throughBlock: 1_500n,
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        requests: [],
      });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
      finality: FINALITY,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        consumers: [
          CONSUMER,
        ],
        nextBlock: 1_200n,
        throughBlock: 1_200n,
        maxBlockRange: 100n,
      },
    );
  });
});