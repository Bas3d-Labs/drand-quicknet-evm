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

import type {
  CheckpointStore,
} from '../src/checkpoint.js';

import {
  runDaemonIteration,
} from '../src/daemon-iteration.js';

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

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;

const DEPLOYMENT: RegistryDeployment = {
  chainId: 46630,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
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
  const order = mock.mock.invocationCallOrder[0];
  if (order === undefined) {
    throw new Error('Expected mock to have been called.');
  }

  return order;
}

describe('runDaemonIteration', () => {
  let checkpointStore: CheckpointStore;
  let load: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(
      scanQuicknetRequests,
    ).mockReset();

    vi.mocked(
      processQuicknetRequests,
    ).mockReset();

    const checkpoint = createCheckpointStore();

    checkpointStore = checkpoint.checkpointStore;
    load = checkpoint.load;
    save = checkpoint.save;
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
      })
    ).rejects.toThrow(
      'startBlock must not be negative.'
    );

    expect(
      load,
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

  it('uses startBlock when no checkpoint exists', async () => {
    load.mockResolvedValue(undefined);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'caught-up',
      headBlock: 999n,
      nextBlock: 1_000n,
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
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [CONSUMER],
      nextBlock: 1_000n,
      maxBlockRange: 100n,
    });
  });

  it('uses the persisted checkpoint instead of startBlock', async () => {
    load.mockResolvedValue(2_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'caught-up',
      headBlock: 1_999n,
      nextBlock: 2_000n,
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
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [CONSUMER],
      nextBlock: 2_000n,
      maxBlockRange: 100n,
    });
  });

  it('loads the checkpoint for the current consumer', async () => {
    load.mockResolvedValue(undefined);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'caught-up',
      headBlock: 999n,
      nextBlock: 1_000n,
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

  it('scans only the current consumer', async () => {
    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'caught-up',
      headBlock: 999n,
      nextBlock: 1_000n,
    });

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 250n,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [CONSUMER],
      nextBlock: 1_000n,
      maxBlockRange: 250n,
    });
  });

  it('returns caught-up without processing or saving', async () => {
    load.mockResolvedValue(1_001n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'caught-up',
      headBlock: 1_000n,
      nextBlock: 1_001n,
    });

    const result = await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'caught-up',
      consumer: CONSUMER,
      headBlock: 1_000n,
      nextBlock: 1_001n,
    });

    expect(
      processQuicknetRequests,
    ).not.toHaveBeenCalled();

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('processes requests returned by the scanner', async () => {
    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [REQUEST],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue(
      PROCESSING_RESULT
    );

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
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
      requests: [REQUEST],
    });
  });

  it('advances the checkpoint after successful processing', async () => {
    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [REQUEST],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue(
      PROCESSING_RESULT
    );

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
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

  it('advances the checkpoint for an empty successfully scanned range', async () => {
    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue({
      rounds: [],
    });

    const result = await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
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

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      processing: {
        rounds: [],
      },
    });
  });

  it('returns the processed scan result', async () => {
    load.mockResolvedValue(1_000n);

    const processing: ProcessQuicknetRequestsResult = {
      rounds: [],
    };

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [REQUEST],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue(
      processing
    );

    const result = await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      processing,
    });
  });

  it('does not save the checkpoint when request processing fails', async () => {
    const failure = new Error('Request processing failed.');

    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [REQUEST],
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
      })
    ).rejects.toBe(
      failure
    );

    expect(
      save,
    ).not.toHaveBeenCalled();
  });

  it('does not process or save when scanning fails', async () => {
    const failure = new Error('Request scan failed.');

    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
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

  it('does not scan, process, or save when checkpoint loading fails', async () => {
    const failure = new Error('Checkpoint load failed.');

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

  it('propagates checkpoint save failures', async () => {
    const failure = new Error('Checkpoint save failed.');

    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [REQUEST],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue(
      PROCESSING_RESULT
    );

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
      })
    ).rejects.toBe(
      failure
    );

    expect(
      processQuicknetRequests,
    ).toHaveBeenCalledOnce();

    expect(
      save,
    ).toHaveBeenCalledOnce();
  });

  it('supports block zero as the initial start block', async () => {
    load.mockResolvedValue(undefined);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 500n,
      fromBlock: 0n,
      toBlock: 99n,
      nextBlock: 100n,
      requests: [],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue(
      PROCESSING_RESULT
    );

    const result = await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 0n,
      maxBlockRange: 100n,
    });

    expect(
      scanQuicknetRequests,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [CONSUMER],
      nextBlock: 0n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      headBlock: 500n,
      fromBlock: 0n,
      toBlock: 99n,
      nextBlock: 100n,
      processing: PROCESSING_RESULT,
    });
  });

  it('loads the checkpoint before scanning', async () => {
    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'caught-up',
      headBlock: 999n,
      nextBlock: 1_000n,
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
    });

    expect(
      firstInvocationOrder(load)
    ).toBeLessThan(
      firstInvocationOrder(
        vi.mocked(
          scanQuicknetRequests
        )
      )
    );
  });

  it('processes requests before advancing the checkpoint', async () => {
    load.mockResolvedValue(1_000n);

    vi.mocked(
      scanQuicknetRequests,
    ).mockResolvedValue({
      status: 'scanned',
      headBlock: 1_500n,
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      requests: [REQUEST],
    });

    vi.mocked(
      processQuicknetRequests,
    ).mockResolvedValue(
      PROCESSING_RESULT
    );

    await runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 500n,
      maxBlockRange: 100n,
    });

    expect(
      firstInvocationOrder(
        vi.mocked(
          processQuicknetRequests
        )
      )
    ).toBeLessThan(
      firstInvocationOrder(save)
    );
  });
});