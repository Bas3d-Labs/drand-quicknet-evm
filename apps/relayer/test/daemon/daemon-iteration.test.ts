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

vi.mock('../../src/chain/chain-heads.js', () => ({
  getChainHeads: vi.fn(),
}));

vi.mock('../../src/consumers/durable-requests.js', () => ({
  reconcileDurableRequests: vi.fn(),
}));

vi.mock('../../src/consumers/request-processor.js', () => ({
  processQuicknetRequests: vi.fn(),
}));

vi.mock('../../src/consumers/request-scanner.js', () => ({
  scanQuicknetRequests: vi.fn(),
}));

import {
  getChainHeads,
} from '../../src/chain/chain-heads.js';

import type {
  FinalityPolicy,
} from '../../src/chain/finality-policy.js';

import {
  reconcileDurableRequests,
  type DurableCheckpointDecision,
  type DurableRequestResult,
} from '../../src/consumers/durable-requests.js';

import {
  processQuicknetRequests,
  type ProcessedQuicknetRound,
  type QuicknetRoundOutcome,
} from '../../src/consumers/request-processor.js';

import type {
  QuicknetRandomnessRequest,
} from '../../src/consumers/request-events.js';

import {
  scanQuicknetRequests,
} from '../../src/consumers/request-scanner.js';

import {
  runDaemonIteration,
  type RunDaemonIterationOptions,
} from '../../src/daemon/daemon-iteration.js';

import type {
  OperationContext,
} from '../../src/diagnostics/operation-context.js';

import type {
  CheckpointStore,
} from '../../src/state/checkpoint.js';

const CONSUMER: Address =
  '0x1111111111111111111111111111111111111111';

const REGISTRY: Address =
  '0x2222222222222222222222222222222222222222';

const VERIFIER: Address =
  '0x5555555555555555555555555555555555555555';

const HASH_A: Hex = `0x${'aa'.repeat(32)}`;
const HASH_B: Hex = `0x${'bb'.repeat(32)}`;
const RANDOMNESS: Hex = `0x${'cc'.repeat(32)}`;

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;

const FINALITY: FinalityPolicy = {
  type: 'safe',
};

const DEPLOYMENT: RegistryDeployment = {
  chainId: 12_345,
  address: REGISTRY,
  runtimeCodehash: HASH_A,
  verifierAddress: VERIFIER,
  verifierRuntimeCodehash: HASH_B,
};

const COMPLETED: ProcessedQuicknetRound = {
  round: 31_192_648n,
  result: {
    status: 'imported',
    submission: 'witness',
    round: 31_192_648n,
    randomness: RANDOMNESS,
    transactionHash: HASH_B,
  },
};

const FAILED_ROUND = COMPLETED.round + 1n;

const SOFT_REQUEST: QuicknetRandomnessRequest = {
  consumer: CONSUMER,
  round: COMPLETED.round,
  blockNumber: 1_250n,
  transactionHash: HASH_B,
  logIndex: 3,
};

const FAILED_OPERATION: OperationContext = {
  name: 'import-round',
  scanType: 'durable',
  fromBlock: 1_000n,
  toBlock: 1_099n,
  round: FAILED_ROUND,
  phase: 'submit-transaction',
};

interface ScannedResultOptions {
  fromBlock?: bigint;
  toBlock?: bigint;
  durableBlock?: bigint;
  checkpoint?: DurableCheckpointDecision;
  imports?: readonly QuicknetRoundOutcome[];
  fulfillment?: DurableRequestResult['fulfillment'];
}

function scannedResult(
  options: ScannedResultOptions = {},
): DurableRequestResult {
  const fromBlock = options.fromBlock ?? 1_000n;
  const toBlock = options.toBlock ?? 1_099n;

  return {
    status: 'scanned',
    fromBlock,
    toBlock,
    anchor: {
      blockNumber: options.durableBlock ?? 1_200n,
      blockHash: HASH_A,
    },
    imports: options.imports ?? [],
    fulfillment: options.fulfillment ?? [],
    checkpoint: options.checkpoint ?? {
      status: 'verified',
      nextBlock: toBlock + 1n,
    },
  };
}

function unavailableResult(
  error: unknown,
): DurableRequestResult {
  return {
    status: 'anchor-unavailable',
    durableBlock: 1_200n,
    imports: [],
    fulfillment: [],
    checkpoint: {
      status: 'anchor-unavailable',
      error,
    },
  };
}

function completedOutcome(): QuicknetRoundOutcome {
  return {
    status: 'completed',
    round: COMPLETED.round,
    firstRequestBlock: 1_010n,
    result: COMPLETED.result,
  };
}

function failedResult(
  error: unknown,
  nextBlock = 1_050n,
): DurableRequestResult {
  return scannedResult({
    imports: [
      completedOutcome(),
      {
        status: 'failed',
        round: FAILED_ROUND,
        firstRequestBlock: 1_050n,
        error,
      },
    ],
    fulfillment: [
      {
        round: COMPLETED.round,
        firstRequestBlock: 1_010n,
        fulfillment: { status: 'stored' },
      },
      {
        round: FAILED_ROUND,
        firstRequestBlock: 1_050n,
        fulfillment: { status: 'not-stored' },
      },
    ],
    checkpoint: {
      status: 'verified',
      nextBlock,
    },
  });
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
  const load = vi.fn<CheckpointStore['load']>();
  const save = vi.fn<CheckpointStore['save']>();

  const checkpointStore: CheckpointStore = {
    load,
    save,
  };

  function run(
    overrides: Partial<RunDaemonIterationOptions> = {},
  ) {
    return runDaemonIteration({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumer: CONSUMER,
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      ...overrides,
    });
  }

  function installImportFailure(
    error: unknown,
    nextBlock = 1_050n,
  ): DurableRequestResult {
    const reconciliation = failedResult(error, nextBlock);

    vi.mocked(reconcileDurableRequests).mockImplementation(
      async ({ onCompleted, onProgress }) => {
        onCompleted?.(COMPLETED);

        onProgress?.({
          round: FAILED_ROUND,
          phase: 'submit-transaction',
        });

        return reconciliation;
      },
    );

    return reconciliation;
  }

  beforeEach(() => {
    load.mockReset().mockResolvedValue(1_000n);
    save.mockReset().mockResolvedValue(undefined);

    vi.mocked(getChainHeads).mockReset().mockResolvedValue({
      latestBlock: 1_500n,
      durableBlock: 1_200n,
    });

    // Default durable fixture: an empty, verified bounded range.
    vi.mocked(reconcileDurableRequests)
      .mockReset()
      .mockImplementation(async (options) => {
        let toBlock =
          options.nextBlock + options.maxBlockRange - 1n;

        if (toBlock > options.durableBlock) {
          toBlock = options.durableBlock;
        }

        return scannedResult({
          fromBlock: options.nextBlock,
          toBlock,
          durableBlock: options.durableBlock,
        });
      });

    // This mock is used only by the soft path in this suite.
    vi.mocked(scanQuicknetRequests)
      .mockReset()
      .mockImplementation(async (options) => {
        if (options.nextBlock > options.throughBlock) {
          return {
            status: 'caught-up',
            throughBlock: options.throughBlock,
            nextBlock: options.nextBlock,
          };
        }

        let toBlock =
          options.nextBlock + options.maxBlockRange - 1n;

        if (toBlock > options.throughBlock) {
          toBlock = options.throughBlock;
        }

        return {
          status: 'scanned',
          throughBlock: options.throughBlock,
          fromBlock: options.nextBlock,
          toBlock,
          nextBlock: toBlock + 1n,
          requests: [],
        };
      });

    vi.mocked(processQuicknetRequests)
      .mockReset()
      .mockResolvedValue({ rounds: [] });
  });

  it.each([
    {
      name: 'negative start block',
      overrides: { startBlock: -1n },
      message: 'startBlock must not be negative.',
    },
    {
      name: 'zero maximum block range',
      overrides: { maxBlockRange: 0n },
      message: 'maxBlockRange must be greater than zero.',
    },
    {
      name: 'negative maximum block range',
      overrides: { maxBlockRange: -1n },
      message: 'maxBlockRange must be greater than zero.',
    },
    {
      name: 'negative soft cursor',
      overrides: { softCursor: { nextBlock: -1n } },
      message: 'Soft cursor nextBlock must not be negative.',
    },
  ])('rejects $name before doing work', async ({
    overrides,
    message,
  }) => {
    await expect(run(overrides)).rejects.toThrow(message);

    expect(load).not.toHaveBeenCalled();
    expect(getChainHeads).not.toHaveBeenCalled();
    expect(reconcileDurableRequests).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(processQuicknetRequests).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('loads the consumer checkpoint before reading heads', async () => {
    await run();

    expect(load).toHaveBeenCalledExactlyOnceWith(CONSUMER);

    expect(firstInvocationOrder(load)).toBeLessThan(
      firstInvocationOrder(vi.mocked(getChainHeads)),
    );
  });

  it('uses the configured finality policy', async () => {
    await run();

    expect(getChainHeads).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      finality: FINALITY,
    });
  });

  it('uses a supplied head reader instead of getChainHeads', async () => {
    const readChainHeads = vi.fn().mockResolvedValue({
      latestBlock: 1_600n,
      durableBlock: 1_300n,
    });

    const result = await run({ readChainHeads });

    expect(readChainHeads).toHaveBeenCalledOnce();
    expect(getChainHeads).not.toHaveBeenCalled();

    expect(result.latestBlock).toBe(1_600n);
    expect(result.durableBlock).toBe(1_300n);

    expect(reconcileDurableRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        durableBlock: 1_300n,
      }),
    );
  });

  it.each([
    {
      name: 'startBlock without a checkpoint',
      checkpoint: undefined,
      startBlock: 1_000n,
      expected: 1_000n,
    },
    {
      name: 'persisted checkpoint instead of startBlock',
      checkpoint: 1_100n,
      startBlock: 500n,
      expected: 1_100n,
    },
    {
      name: 'zero checkpoint instead of startBlock',
      checkpoint: 0n,
      startBlock: 500n,
      expected: 0n,
    },
    {
      name: 'zero startBlock without a checkpoint',
      checkpoint: undefined,
      startBlock: 0n,
      expected: 0n,
    },
  ])('uses $name for durable reconciliation', async ({
    checkpoint,
    startBlock,
    expected,
  }) => {
    load.mockResolvedValue(checkpoint);

    await run({ startBlock });

    expect(reconcileDurableRequests).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      consumer: CONSUMER,
      nextBlock: expected,
      durableBlock: 1_200n,
      maxBlockRange: 100n,
      onCompleted: expect.any(Function),
      onProgress: expect.any(Function),
    });
  });

  it('includes the durable block when it equals the cursor', async () => {
    load.mockResolvedValue(1_200n);

    const result = await run();

    expect(reconcileDurableRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        nextBlock: 1_200n,
        durableBlock: 1_200n,
      }),
    );

    expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_201n);
    expect(result.durableNextBlock).toBe(1_201n);
  });

  it('skips durable reconciliation when already caught up', async () => {
    load.mockResolvedValue(1_201n);

    const result = await run();

    expect(reconcileDurableRequests).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    expect(result.durableNextBlock).toBe(1_201n);
    expect(result.durableHeadRegressed).toBe(false);
    expect(result.durableScan).toBeUndefined();
  });

  it('saves a verified empty range before starting soft work', async () => {
    await run();

    expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_100n);

    expect(
      firstInvocationOrder(vi.mocked(reconcileDurableRequests)),
    ).toBeLessThan(firstInvocationOrder(save));

    expect(firstInvocationOrder(save)).toBeLessThan(
      firstInvocationOrder(vi.mocked(scanQuicknetRequests)),
    );
  });

  it('saves only the verified prefix of a scanned range', async () => {
    const reconciliation = scannedResult({
      imports: [completedOutcome()],
      fulfillment: [
        {
          round: COMPLETED.round,
          firstRequestBlock: 1_010n,
          fulfillment: { status: 'not-stored' },
        },
      ],
      checkpoint: {
        status: 'verified',
        nextBlock: 1_010n,
      },
    });

    vi.mocked(reconcileDurableRequests)
      .mockResolvedValue(reconciliation);

    const result = await run();

    expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_010n);
    expect(result.durableNextBlock).toBe(1_010n);

    expect(result.durableScan).toEqual({
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_010n,
      processing: {
        rounds: [COMPLETED],
      },
      reconciliation,
    });
  });

  it.each([
    {
      name: 'not stored',
      fulfillment: { status: 'not-stored' } as const,
    },
    {
      name: 'read unavailable',
      fulfillment: {
        status: 'unavailable',
        error: new Error('Historical read failed.'),
      } as const,
    },
  ])('does not save an unchanged prefix when fulfillment is $name', async ({
    fulfillment,
  }) => {
    vi.mocked(reconcileDurableRequests).mockResolvedValue(
      scannedResult({
        fulfillment: [
          {
            round: COMPLETED.round,
            firstRequestBlock: 1_000n,
            fulfillment,
          },
        ],
        checkpoint: {
          status: 'verified',
          nextBlock: 1_000n,
        },
      }),
    );

    const result = await run({
      softCursor: { nextBlock: 1_501n },
    });

    expect(save).not.toHaveBeenCalled();
    expect(result.durableNextBlock).toBe(1_000n);
    expect(result.status).toBe('processed');
    expect(result.durableScan).toBeDefined();
  });

  it.each([
    {
      name: 'changed anchor',
      checkpoint: {
        status: 'anchor-changed',
        observedAnchor: {
          blockNumber: 1_200n,
          blockHash: HASH_B,
        },
      } satisfies DurableCheckpointDecision,
    },
    {
      name: 'unavailable final anchor',
      checkpoint: {
        status: 'anchor-unavailable',
        error: new Error('Final anchor unavailable.'),
      } satisfies DurableCheckpointDecision,
    },
  ])('does not save after a $name', async ({ checkpoint }) => {
    const reconciliation = scannedResult({ checkpoint });

    vi.mocked(reconcileDurableRequests)
      .mockResolvedValue(reconciliation);

    const onReconciliation = vi.fn();

    const result = await run({
      onReconciliation,
      softCursor: { nextBlock: 1_501n },
    });

    expect(save).not.toHaveBeenCalled();
    expect(result.status).toBe('processed');
    expect(result.durableNextBlock).toBe(1_000n);
    expect(result.durableScan?.reconciliation).toBe(reconciliation);

    expect(onReconciliation)
      .toHaveBeenCalledExactlyOnceWith(reconciliation);
  });

  it('returns deferred when the initial anchor is unavailable and soft work is caught up', async () => {
    const reconciliation = unavailableResult(
      new Error('Initial anchor unavailable.'),
    );

    vi.mocked(reconcileDurableRequests)
      .mockResolvedValue(reconciliation);

    const onReconciliation = vi.fn();

    const result = await run({
      onReconciliation,
      softCursor: { nextBlock: 1_501n },
    });

    expect(result).toEqual({
      status: 'deferred',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_000n,
      durableHeadRegressed: false,
      softCursor: { nextBlock: 1_501n },
      durableScan: undefined,
      softScan: undefined,
    });

    expect(save).not.toHaveBeenCalled();
    expect(processQuicknetRequests).not.toHaveBeenCalled();

    expect(onReconciliation)
      .toHaveBeenCalledExactlyOnceWith(reconciliation);
  });

  it('continues soft processing when the initial anchor is unavailable', async () => {
    vi.mocked(reconcileDurableRequests).mockResolvedValue(
      unavailableResult(new Error('Initial anchor unavailable.')),
    );

    const result = await run();

    expect(save).not.toHaveBeenCalled();
    expect(processQuicknetRequests).toHaveBeenCalledOnce();

    expect(result.status).toBe('processed');
    expect(result.durableNextBlock).toBe(1_000n);
    expect(result.durableScan).toBeUndefined();
    expect(result.softCursor.nextBlock).toBe(1_301n);
    expect(result.softScan).toBeDefined();
  });

  it('preserves completed reporting and restores import context after saving a prefix', async () => {
    const failure = new Error('Import failed.');
    const reconciliation = installImportFailure(failure);

    const onOperation = vi.fn();
    const onCompleted = vi.fn();
    const onReconciliation = vi.fn();

    await expect(run({
      onOperation,
      onCompleted,
      onReconciliation,
    })).rejects.toBe(failure);

    expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_050n);

    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
      'durable',
      COMPLETED,
    );
    expect(onReconciliation)
      .toHaveBeenCalledExactlyOnceWith(reconciliation);

    expect(onOperation).toHaveBeenCalledWith({
      name: 'save-checkpoint',
      nextBlock: 1_050n,
    });
    expect(onOperation).toHaveBeenLastCalledWith(FAILED_OPERATION);

    expect(firstInvocationOrder(onCompleted)).toBeLessThan(
      firstInvocationOrder(save),
    );

    expect(scanQuicknetRequests).not.toHaveBeenCalled();
  });

  it('rethrows the original import error without saving an unchanged prefix', async () => {
    const failure = new Error('Import failed.');
    installImportFailure(failure, 1_000n);

    await expect(run()).rejects.toBe(failure);

    expect(save).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
  });

  it('does not save an invalidated prefix even when an import also failed', async () => {
    const failure = new Error('Import failed.');

    vi.mocked(reconcileDurableRequests).mockResolvedValue(
      scannedResult({
        imports: [
          {
            status: 'failed',
            round: FAILED_ROUND,
            firstRequestBlock: 1_050n,
            error: failure,
          },
        ],
        checkpoint: {
          status: 'anchor-changed',
          observedAnchor: {
            blockNumber: 1_200n,
            blockHash: HASH_B,
          },
        },
      }),
    );

    await expect(run()).rejects.toBe(failure);

    expect(save).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
  });

  it('preserves both failures and save context when checkpoint persistence also fails', async () => {
    const importError = new Error('Import failed.');
    const saveError = new Error('Checkpoint save failed.');

    installImportFailure(importError);
    save.mockRejectedValue(saveError);

    const onOperation = vi.fn();
    const onCompleted = vi.fn();

    const failure: unknown = await run({
      onOperation,
      onCompleted,
    }).then(
      () => {
        throw new Error('Expected iteration to reject.');
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);

    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected AggregateError.');
    }

    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(saveError);
    expect(failure.errors[1]).toBe(importError);

    expect(onOperation).toHaveBeenLastCalledWith({
      name: 'save-checkpoint',
      nextBlock: 1_050n,
    });

    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
      'durable',
      COMPLETED,
    );
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
  });

  it('propagates a save failure unchanged when there is no import failure', async () => {
    const failure = new Error('Checkpoint save failed.');
    save.mockRejectedValue(failure);

    await expect(run()).rejects.toBe(failure);

    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(processQuicknetRequests).not.toHaveBeenCalled();
  });

  it('waits for checkpoint persistence before starting soft work', async () => {
    let finishSave: () => void = () => {};
    let notifySaving: () => void = () => {};

    const saving = new Promise<void>((resolve) => {
      notifySaving = resolve;
    });

    const saved = new Promise<void>((resolve) => {
      finishSave = resolve;
    });

    save.mockImplementation(async () => {
      notifySaving();
      await saved;
    });

    const pending = run();

    try {
      await Promise.race([saving, pending]);

      expect(save).toHaveBeenCalledOnce();
      expect(scanQuicknetRequests).not.toHaveBeenCalled();
    } finally {
      finishSave();
    }

    const result = await pending;

    expect(result.durableNextBlock).toBe(1_100n);
    expect(scanQuicknetRequests).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'durable backlog',
      checkpoint: 1_000n,
      startBlock: 500n,
      durableBlock: 1_200n,
      softCursor: undefined,
      expected: 1_201n,
      regressed: false,
    },
    {
      name: 'existing soft cursor',
      checkpoint: 1_201n,
      startBlock: 500n,
      durableBlock: 1_200n,
      softCursor: { nextBlock: 1_400n },
      expected: 1_400n,
      regressed: false,
    },
    {
      name: 'stale soft cursor',
      checkpoint: 1_201n,
      startBlock: 500n,
      durableBlock: 1_200n,
      softCursor: { nextBlock: 1_100n },
      expected: 1_201n,
      regressed: false,
    },
    {
      name: 'finality overtaking the soft cursor',
      checkpoint: 1_301n,
      startBlock: 500n,
      durableBlock: 1_500n,
      softCursor: { nextBlock: 1_350n },
      expected: 1_501n,
      regressed: false,
    },
    {
      name: 'restart during durable-head regression',
      checkpoint: 1_301n,
      startBlock: 500n,
      durableBlock: 1_250n,
      softCursor: undefined,
      expected: 1_301n,
      regressed: true,
    },
    {
      name: 'existing cursor during durable-head regression',
      checkpoint: 1_301n,
      startBlock: 500n,
      durableBlock: 1_250n,
      softCursor: { nextBlock: 1_400n },
      expected: 1_400n,
      regressed: true,
    },
    {
      name: 'initial start ahead of the durable head',
      checkpoint: undefined,
      startBlock: 1_200n,
      durableBlock: 1_000n,
      softCursor: undefined,
      expected: 1_200n,
      regressed: false,
    },
  ])('selects the soft cursor for $name', async ({
    checkpoint,
    startBlock,
    durableBlock,
    softCursor,
    expected,
    regressed,
  }) => {
    load.mockResolvedValue(checkpoint);

    vi.mocked(getChainHeads).mockResolvedValue({
      latestBlock: 1_600n,
      durableBlock,
    });

    const overrides: Partial<RunDaemonIterationOptions> = {
      startBlock,
    };

    if (softCursor !== undefined) {
      overrides.softCursor = softCursor;
    }

    const result = await run(overrides);

    expect(scanQuicknetRequests).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      consumers: [CONSUMER],
      nextBlock: expected,
      throughBlock: 1_600n,
      maxBlockRange: 100n,
    });

    expect(result.durableHeadRegressed).toBe(regressed);

    if (regressed) {
      expect(reconcileDurableRequests).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(result.durableNextBlock).toBe(checkpoint);
    }
  });

  it('resumes durable reconciliation after the head recovers', async () => {
    load.mockResolvedValue(1_301n);

    vi.mocked(getChainHeads).mockResolvedValue({
      latestBlock: 1_600n,
      durableBlock: 1_400n,
    });

    const result = await run();

    expect(reconcileDurableRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        nextBlock: 1_301n,
        durableBlock: 1_400n,
      }),
    );

    expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_401n);
    expect(result.durableHeadRegressed).toBe(false);
  });

  it('processes soft requests with progress and completion callbacks', async () => {
    load.mockResolvedValue(1_201n);

    vi.mocked(scanQuicknetRequests).mockResolvedValue({
      status: 'scanned',
      throughBlock: 1_500n,
      fromBlock: 1_201n,
      toBlock: 1_300n,
      nextBlock: 1_301n,
      requests: [SOFT_REQUEST],
    });

    vi.mocked(processQuicknetRequests).mockImplementation(
      async ({ onProgress, onCompleted }) => {
        onProgress?.({
          round: COMPLETED.round,
          phase: 'submit-transaction',
        });
        onCompleted?.(COMPLETED);

        return { rounds: [COMPLETED] };
      },
    );

    const onOperation = vi.fn();
    const onCompleted = vi.fn();

    const result = await run({ onOperation, onCompleted });

    expect(processQuicknetRequests).toHaveBeenCalledExactlyOnceWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [SOFT_REQUEST],
      onProgress: expect.any(Function),
      onCompleted: expect.any(Function),
    });

    expect(onOperation).toHaveBeenCalledWith({
      name: 'import-round',
      scanType: 'soft',
      fromBlock: 1_201n,
      toBlock: 1_300n,
      round: COMPLETED.round,
      phase: 'submit-transaction',
    });

    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
      'soft',
      COMPLETED,
    );

    expect(result.softCursor).toEqual({ nextBlock: 1_301n });
    expect(result.softScan?.processing).toEqual({
      rounds: [COMPLETED],
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('advances an empty soft range without persisting it', async () => {
    load.mockResolvedValue(1_201n);

    const result = await run();

    expect(processQuicknetRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [],
      }),
    );

    expect(result.softCursor.nextBlock).toBe(1_301n);
    expect(result.durableNextBlock).toBe(1_201n);
    expect(save).not.toHaveBeenCalled();
  });

  it('preserves the supplied soft cursor when soft processing fails', async () => {
    const failure = new Error('Soft processing failed.');
    const softCursor = { nextBlock: 1_201n };

    load.mockResolvedValue(1_201n);
    vi.mocked(processQuicknetRequests).mockRejectedValue(failure);

    await expect(run({ softCursor })).rejects.toBe(failure);

    expect(softCursor).toEqual({ nextBlock: 1_201n });
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['scan', 'processing'] as const)(
    'keeps saved durable progress when later soft %s fails',
    async (stage) => {
      const failure = new Error('Soft work failed.');

      if (stage === 'scan') {
        vi.mocked(scanQuicknetRequests).mockRejectedValue(failure);
      } else {
        vi.mocked(processQuicknetRequests).mockRejectedValue(failure);
      }

      await expect(run()).rejects.toBe(failure);

      expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_100n);
    },
  );

  it('returns caught-up when neither path has work', async () => {
    load.mockResolvedValue(1_201n);

    const result = await run({
      softCursor: { nextBlock: 1_501n },
    });

    expect(result).toEqual({
      status: 'caught-up',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_201n,
      durableHeadRegressed: false,
      softCursor: { nextBlock: 1_501n },
      durableScan: undefined,
      softScan: undefined,
    });

    expect(reconcileDurableRequests).not.toHaveBeenCalled();
    expect(processQuicknetRequests).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('returns processed when only durable history is scanned', async () => {
    const reconciliation = scannedResult();

    vi.mocked(reconcileDurableRequests)
      .mockResolvedValue(reconciliation);

    const result = await run({
      softCursor: { nextBlock: 1_501n },
    });

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_100n,
      durableHeadRegressed: false,
      softCursor: { nextBlock: 1_501n },
      durableScan: {
        fromBlock: 1_000n,
        toBlock: 1_099n,
        nextBlock: 1_100n,
        processing: { rounds: [] },
        reconciliation,
      },
      softScan: undefined,
    });

    expect(processQuicknetRequests).not.toHaveBeenCalled();
  });

  it('returns processed when only soft history is scanned', async () => {
    load.mockResolvedValue(1_201n);

    const result = await run();

    expect(result).toEqual({
      status: 'processed',
      consumer: CONSUMER,
      latestBlock: 1_500n,
      durableBlock: 1_200n,
      durableNextBlock: 1_201n,
      durableHeadRegressed: false,
      softCursor: { nextBlock: 1_301n },
      durableScan: undefined,
      softScan: {
        fromBlock: 1_201n,
        toBlock: 1_300n,
        nextBlock: 1_301n,
        processing: { rounds: [] },
      },
    });
  });

  it('returns both scans when both paths run', async () => {
    const reconciliation = scannedResult();

    vi.mocked(reconcileDurableRequests)
      .mockResolvedValue(reconciliation);

    const result = await run();

    expect(result.status).toBe('processed');
    expect(result.durableNextBlock).toBe(1_100n);
    expect(result.softCursor.nextBlock).toBe(1_301n);

    expect(result.durableScan).toEqual({
      fromBlock: 1_000n,
      toBlock: 1_099n,
      nextBlock: 1_100n,
      processing: { rounds: [] },
      reconciliation,
    });

    expect(result.softScan).toEqual({
      fromBlock: 1_201n,
      toBlock: 1_300n,
      nextBlock: 1_301n,
      processing: { rounds: [] },
    });
  });

  it('propagates checkpoint loading failures before reading heads', async () => {
    const failure = new Error('Checkpoint load failed.');
    load.mockRejectedValue(failure);

    await expect(run()).rejects.toBe(failure);

    expect(getChainHeads).not.toHaveBeenCalled();
    expect(reconcileDurableRequests).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('propagates chain-head failures before either scan', async () => {
    const failure = new Error('Chain-head read failed.');
    vi.mocked(getChainHeads).mockRejectedValue(failure);

    await expect(run()).rejects.toBe(failure);

    expect(reconcileDurableRequests).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('propagates durable reconciliation failures before saving or soft work', async () => {
    const failure = new Error('Durable log scan failed.');

    vi.mocked(reconcileDurableRequests).mockRejectedValue(failure);

    await expect(run()).rejects.toBe(failure);

    expect(save).not.toHaveBeenCalled();
    expect(scanQuicknetRequests).not.toHaveBeenCalled();
    expect(processQuicknetRequests).not.toHaveBeenCalled();
  });

  it('propagates soft scan failures without saving when durable work is caught up', async () => {
    const failure = new Error('Soft log scan failed.');

    load.mockResolvedValue(1_201n);
    vi.mocked(scanQuicknetRequests).mockRejectedValue(failure);

    await expect(run()).rejects.toBe(failure);

    expect(save).not.toHaveBeenCalled();
    expect(processQuicknetRequests).not.toHaveBeenCalled();
  });

  it('isolates throwing operation, completion, and reconciliation observers', async () => {
    const reportError = new Error('Observer failed.');

    const onOperation = vi.fn(() => {
      throw reportError;
    });
    const onCompleted = vi.fn(() => {
      throw reportError;
    });
    const onReconciliation = vi.fn(() => {
      throw reportError;
    });

    const reconciliation = scannedResult({
      imports: [completedOutcome()],
      fulfillment: [
        {
          round: COMPLETED.round,
          firstRequestBlock: 1_010n,
          fulfillment: { status: 'stored' },
        },
      ],
    });

    vi.mocked(reconcileDurableRequests).mockImplementation(
      async ({ onProgress, onCompleted }) => {
        onProgress?.({
          round: COMPLETED.round,
          phase: 'submit-transaction',
        });
        onCompleted?.(COMPLETED);

        return reconciliation;
      },
    );

    vi.mocked(processQuicknetRequests).mockImplementation(
      async ({ onProgress, onCompleted }) => {
        onProgress?.({
          round: COMPLETED.round,
          phase: 'check-stored',
        });
        onCompleted?.(COMPLETED);

        return { rounds: [COMPLETED] };
      },
    );

    const result = await run({
      onOperation,
      onCompleted,
      onReconciliation,
    });

    expect(result.status).toBe('processed');
    expect(result.durableNextBlock).toBe(1_100n);
    expect(result.softCursor.nextBlock).toBe(1_301n);

    expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_100n);
    expect(onOperation).toHaveBeenCalled();
    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(onCompleted).toHaveBeenNthCalledWith(
      1,
      'durable',
      COMPLETED,
    );
    expect(onCompleted).toHaveBeenNthCalledWith(
      2,
      'soft',
      COMPLETED,
    );
    expect(onReconciliation)
      .toHaveBeenCalledExactlyOnceWith(reconciliation);
  });

  it('preserves the import failure when operation reporting throws', async () => {
    const failure = new Error('Import failed.');
    installImportFailure(failure);

    await expect(run({
      onOperation() {
        throw new Error('Reporting failed.');
      },
    })).rejects.toBe(failure);

    expect(save).toHaveBeenCalledExactlyOnceWith(CONSUMER, 1_050n);
  });

  it('preserves soft completion reporting before a later soft failure', async () => {
    const failure = new Error('Later soft import failed.');

    load.mockResolvedValue(1_201n);

    vi.mocked(processQuicknetRequests).mockImplementation(
      async ({ onCompleted }) => {
        onCompleted?.(COMPLETED);
        throw failure;
      },
    );

    const onCompleted = vi.fn();

    await expect(run({ onCompleted })).rejects.toBe(failure);

    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
      'soft',
      COMPLETED,
    );
    expect(save).not.toHaveBeenCalled();
  });
});