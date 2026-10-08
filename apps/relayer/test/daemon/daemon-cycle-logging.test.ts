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

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

vi.mock('../../src/daemon/daemon-iteration.js', () => ({
  runDaemonIteration: vi.fn(),
}));

import type {
  ValidatedQuicknetConsumer,
} from '../../src/consumers/consumer.js';

import type {
  DurableRequestResult,
} from '../../src/consumers/durable-requests.js';

import type {
  ProcessedQuicknetRound,
} from '../../src/consumers/request-processor.js';

import {
  runDaemonCycle,
} from '../../src/daemon/daemon-cycle.js';

import {
  runDaemonIteration,
  type RunDaemonIterationResult,
  type SoftScanCursor,
} from '../../src/daemon/daemon-iteration.js';

import {
  createDaemonLogger,
} from '../../src/daemon/daemon-logging.js';

import type {
  OperationContext,
} from '../../src/diagnostics/operation-context.js';

import type {
  RelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import type {
  CheckpointStore,
} from '../../src/state/checkpoint.js';

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const REGISTRY: Address =
  '0x3333333333333333333333333333333333333333';

const VERIFIER: Address =
  '0x4444444444444444444444444444444444444444';

const HASH_A: Hex = `0x${'aa'.repeat(32)}`;
const HASH_B: Hex = `0x${'bb'.repeat(32)}`;
const RANDOMNESS: Hex = `0x${'cc'.repeat(32)}`;

const ROUND = 31_250_000n;

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;
const CHECKPOINT_STORE = {} as CheckpointStore;

const DEPLOYMENT: RegistryDeployment = {
  chainId: 12_345,
  address: REGISTRY,
  runtimeCodehash: HASH_A,
  verifierAddress: VERIFIER,
  verifierRuntimeCodehash: HASH_B,
};

const CONSUMERS: readonly ValidatedQuicknetConsumer[] = [
  {
    address: CONSUMER_A,
    registry: REGISTRY,
  },
  {
    address: CONSUMER_B,
    registry: REGISTRY,
  },
];

const IMPORTED: ProcessedQuicknetRound = {
  round: ROUND,
  result: {
    status: 'imported',
    submission: 'witness',
    round: ROUND,
    randomness: RANDOMNESS,
    transactionHash: HASH_B,
  },
};

const ALREADY_STORED: ProcessedQuicknetRound = {
  round: ROUND + 1n,
  result: {
    status: 'already-stored',
    round: ROUND + 1n,
    randomness: RANDOMNESS,
  },
};

const OPERATION: OperationContext = {
  name: 'import-round',
  scanType: 'soft',
  fromBlock: 901n,
  toBlock: 1_000n,
  round: ROUND + 2n,
  phase: 'submit-transaction',
};

const loggerMocks = {
  consumerFailed: vi.fn<RelayerLog['consumerFailed']>(),
  durableHeadRegressed:
    vi.fn<RelayerLog['durableHeadRegressed']>(),
  checkpointAdvanced:
    vi.fn<RelayerLog['checkpointAdvanced']>(),
  roundImported: vi.fn<RelayerLog['roundImported']>(),
  roundAlreadyStored:
    vi.fn<RelayerLog['roundAlreadyStored']>(),
  heartbeat: vi.fn<RelayerLog['heartbeat']>(),
  loggingFailed: vi.fn<RelayerLog['loggingFailed']>(),
  durableFulfillmentPending:
    vi.fn<RelayerLog['durableFulfillmentPending']>(),
  durableFulfillmentUnavailable:
    vi.fn<RelayerLog['durableFulfillmentUnavailable']>(),
  durableAnchorChanged:
    vi.fn<RelayerLog['durableAnchorChanged']>(),
  durableAnchorUnavailable:
    vi.fn<RelayerLog['durableAnchorUnavailable']>(),
} satisfies RelayerLog;

function scanned(
  checkpoint: Extract<
    DurableRequestResult,
    { status: 'scanned' }
  >['checkpoint'] = {
    status: 'verified',
    nextBlock: 850n,
  },
): Extract<DurableRequestResult, { status: 'scanned' }> {
  return {
    status: 'scanned',
    fromBlock: 800n,
    toBlock: 899n,
    anchor: {
      blockNumber: 900n,
      blockHash: HASH_A,
    },
    imports: [
      {
        status: 'completed',
        round: ROUND,
        firstRequestBlock: 850n,
        result: IMPORTED.result,
      },
    ],
    fulfillment: [
      {
        round: ROUND,
        firstRequestBlock: 850n,
        fulfillment: { status: 'not-stored' },
      },
    ],
    checkpoint,
  };
}

function caughtUp(
  consumer: Address,
): RunDaemonIterationResult {
  return {
    status: 'caught-up',
    consumer,
    latestBlock: 1_000n,
    durableBlock: 900n,
    durableNextBlock: 901n,
    durableHeadRegressed: false,
    softCursor: { nextBlock: 1_001n },
    durableScan: undefined,
    softScan: undefined,
  };
}

function processed(
  reconciliation: Extract<
    DurableRequestResult,
    { status: 'scanned' }
  >,
): RunDaemonIterationResult {
  let nextBlock = reconciliation.fromBlock;

  if (reconciliation.checkpoint.status === 'verified') {
    nextBlock = reconciliation.checkpoint.nextBlock;
  }

  return {
    ...caughtUp(CONSUMER_A),
    status: 'processed',
    durableNextBlock: nextBlock,
    durableScan: {
      fromBlock: reconciliation.fromBlock,
      toBlock: reconciliation.toBlock,
      nextBlock,
      processing: { rounds: [IMPORTED] },
      reconciliation,
    },
    softScan: {
      fromBlock: 901n,
      toBlock: 1_000n,
      nextBlock: 1_001n,
      processing: { rounds: [ALREADY_STORED] },
    },
  };
}

let submitter: BeaconSubmitter;

function cycle(
  softCursors = new Map<Address, SoftScanCursor>(),
) {
  return runDaemonCycle({
    publicClient: PUBLIC_CLIENT,
    walletClient: WALLET_CLIENT,
    account: ACCOUNT,
    submitter,
    deployment: DEPLOYMENT,
    checkpointStore: CHECKPOINT_STORE,
    consumers: CONSUMERS,
    startBlock: 800n,
    maxBlockRange: 100n,
    finality: { type: 'safe' },
    softCursors,
  });
}

function logCycle(
  result: Awaited<ReturnType<typeof cycle>>,
): void {
  createDaemonLogger({
    logger: loggerMocks,
    now: () => 0,
  }).onCycle(result);
}

describe('daemon cycle diagnostic reporting', () => {
  beforeEach(() => {
    vi.mocked(runDaemonIteration)
      .mockReset()
      .mockImplementation(async ({ consumer }) => {
        return caughtUp(consumer);
      });

    submitter = {
      recover: vi.fn<BeaconSubmitter['recover']>(),
      submit: vi.fn<BeaconSubmitter['submit']>(),
    };

    for (const mock of Object.values(loggerMocks)) {
      mock.mockReset();
    }
  });

  it('reports successful completions and reconciliation exactly once', async () => {
    const reconciliation = scanned();
    const iteration = processed(reconciliation);

    vi.mocked(runDaemonIteration).mockImplementationOnce(
      async ({ onCompleted, onReconciliation }) => {
        onCompleted?.('durable', IMPORTED);
        onReconciliation?.(reconciliation);
        onCompleted?.('soft', ALREADY_STORED);

        return iteration;
      },
    );

    const result = await cycle();
    const first = result.consumers[0];

    if (first?.status !== 'success') {
      throw new Error('Expected successful consumer.');
    }

    expect(first.reconciliation).toBe(reconciliation);
    expect(first.iteration).toBe(iteration);

    // Successful reporting comes from scans, not a second completion list.
    expect(first).not.toHaveProperty('completed');

    logCycle(result);

    expect(loggerMocks.roundImported)
      .toHaveBeenCalledExactlyOnceWith({
        consumer: CONSUMER_A,
        scanType: 'durable',
        round: ROUND,
        transactionHash: HASH_B,
        submission: 'witness',
        fallbackReason: undefined,
      });

    expect(loggerMocks.roundAlreadyStored)
      .toHaveBeenCalledExactlyOnceWith({
        consumer: CONSUMER_A,
        scanType: 'soft',
        round: ROUND + 1n,
      });

    // Reconciliation also appears inside durableScan, but is logged once.
    expect(loggerMocks.durableFulfillmentPending)
      .toHaveBeenCalledExactlyOnceWith({
        consumer: CONSUMER_A,
        round: ROUND,
        durableBlock: 900n,
      });

    // Only the persisted prefix is reported as advanced.
    expect(loggerMocks.checkpointAdvanced)
      .toHaveBeenCalledExactlyOnceWith({
        consumer: CONSUMER_A,
        fromBlock: 800n,
        toBlock: 849n,
        nextBlock: 850n,
      });

    expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
    expect(loggerMocks.loggingFailed).not.toHaveBeenCalled();
  });

  it('retains completions and context after failure without leaking them to the next consumer', async () => {
    const error = new Error('Later soft import failed.');
    const reconciliation = scanned({
      status: 'verified',
      nextBlock: 800n,
    });

    const previousCursor = { nextBlock: 950n };
    const softCursors = new Map<Address, SoftScanCursor>([
      [CONSUMER_A, previousCursor],
    ]);

    vi.mocked(runDaemonIteration).mockImplementationOnce(
      async ({ onCompleted, onReconciliation, onOperation }) => {
        onCompleted?.('durable', IMPORTED);
        onReconciliation?.(reconciliation);
        onCompleted?.('soft', ALREADY_STORED);
        onOperation?.(OPERATION);

        throw error;
      },
    );

    const result = await cycle(softCursors);
    const first = result.consumers[0];
    const second = result.consumers[1];

    if (first?.status !== 'failed') {
      throw new Error('Expected failed first consumer.');
    }

    expect(first.error).toBe(error);
    expect(first.operation).toBe(OPERATION);
    expect(first.reconciliation).toBe(reconciliation);
    expect(first.completed).toEqual([
      { scanType: 'durable', result: IMPORTED },
      { scanType: 'soft', result: ALREADY_STORED },
    ]);

    expect(second?.status).toBe('success');
    expect(second).not.toHaveProperty('completed');
    expect(second).not.toHaveProperty('reconciliation');
    expect(second).not.toHaveProperty('operation');

    expect(softCursors.get(CONSUMER_A)).toBe(previousCursor);
    expect(softCursors.get(CONSUMER_B)).toEqual({
      nextBlock: 1_001n,
    });

    logCycle(result);

    expect(loggerMocks.roundImported).toHaveBeenCalledOnce();
    expect(loggerMocks.roundAlreadyStored).toHaveBeenCalledOnce();
    expect(loggerMocks.durableFulfillmentPending)
      .toHaveBeenCalledOnce();

    expect(loggerMocks.consumerFailed)
      .toHaveBeenCalledExactlyOnceWith({
        consumer: CONSUMER_A,
        error,
        operation: OPERATION,
      });

    expect(
      loggerMocks.roundImported.mock.invocationCallOrder[0],
    ).toBeLessThan(
      loggerMocks.consumerFailed.mock.invocationCallOrder[0]!,
    );

    expect(
      loggerMocks.roundAlreadyStored.mock.invocationCallOrder[0],
    ).toBeLessThan(
      loggerMocks.consumerFailed.mock.invocationCallOrder[0]!,
    );

    expect(loggerMocks.checkpointAdvanced).not.toHaveBeenCalled();
    expect(loggerMocks.loggingFailed).not.toHaveBeenCalled();
  });

  it('preserves deferred as a successful cycle result and reports the unavailable anchor', async () => {
    const error = new Error('Anchor unavailable.');

    const reconciliation: DurableRequestResult = {
      status: 'anchor-unavailable',
      durableBlock: 900n,
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'anchor-unavailable',
        error,
      },
    };

    const iteration: RunDaemonIterationResult = {
      ...caughtUp(CONSUMER_A),
      status: 'deferred',
      durableNextBlock: 800n,
    };

    vi.mocked(runDaemonIteration).mockImplementationOnce(
      async ({ onReconciliation }) => {
        onReconciliation?.(reconciliation);
        return iteration;
      },
    );

    const softCursors = new Map<Address, SoftScanCursor>();
    const result = await cycle(softCursors);

    expect(result.consumers[0]).toEqual({
      status: 'success',
      consumer: CONSUMERS[0],
      iteration,
      reconciliation,
    });

    expect(softCursors.get(CONSUMER_A)).toBe(iteration.softCursor);

    let now = 0;

    const logger = createDaemonLogger({
      logger: loggerMocks,
      heartbeatIntervalMs: 1_000,
      now: () => now,
    });

    now = 1_000;
    logger.onCycle(result);

    expect(loggerMocks.durableAnchorUnavailable)
      .toHaveBeenCalledExactlyOnceWith({
        consumer: CONSUMER_A,
        durableBlock: 900n,
        error,
      });

    expect(
      loggerMocks.durableAnchorUnavailable.mock.calls[0]?.[0].error,
    ).toBe(error);

    expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
    expect(loggerMocks.checkpointAdvanced).not.toHaveBeenCalled();

    expect(loggerMocks.heartbeat).toHaveBeenCalledOnce();
    expect(
      loggerMocks.heartbeat.mock.calls[0]?.[0].consumers,
    ).toEqual([
      {
        consumer: CONSUMER_A,
        status: 'healthy',
        latestBlock: 1_000n,
        durableBlock: 900n,
        durableNextBlock: 800n,
        softNextBlock: 1_001n,
      },
      {
        consumer: CONSUMER_B,
        status: 'healthy',
        latestBlock: 1_000n,
        durableBlock: 900n,
        durableNextBlock: 901n,
        softNextBlock: 1_001n,
      },
    ]);
  });

  it.each(['success', 'failed'] as const)(
    'reports an anchor change once on a %s cycle outcome',
    async (outcome) => {
      const reconciliation = scanned({
        status: 'anchor-changed',
        observedAnchor: {
          blockNumber: 900n,
          blockHash: HASH_B,
        },
      });

      const error = new Error('Later processing failed.');

      vi.mocked(runDaemonIteration).mockImplementationOnce(
        async ({ onCompleted, onReconciliation }) => {
          onCompleted?.('durable', IMPORTED);
          onReconciliation?.(reconciliation);

          if (outcome === 'failed') {
            throw error;
          }

          return {
            ...processed(reconciliation),
            softScan: undefined,
          };
        },
      );

      logCycle(await cycle());

      expect(loggerMocks.durableAnchorChanged)
        .toHaveBeenCalledExactlyOnceWith({
          consumer: CONSUMER_A,
          durableBlock: 900n,
          expectedHash: HASH_A,
          observedHash: HASH_B,
        });

      expect(loggerMocks.roundImported).toHaveBeenCalledOnce();
      expect(loggerMocks.checkpointAdvanced).not.toHaveBeenCalled();

      // Fulfillment observations belong to an invalidated anchor.
      expect(loggerMocks.durableFulfillmentPending)
        .not.toHaveBeenCalled();
      expect(loggerMocks.durableFulfillmentUnavailable)
        .not.toHaveBeenCalled();

      if (outcome === 'failed') {
        expect(loggerMocks.consumerFailed).toHaveBeenCalledOnce();
        expect(
          loggerMocks.consumerFailed.mock.calls[0]?.[0].error,
        ).toBe(error);
      } else {
        expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
      }

      expect(loggerMocks.loggingFailed).not.toHaveBeenCalled();
    },
  );

  it('reports an unavailable final anchor without reporting fulfillment against it', async () => {
    const error = new Error('Final anchor unavailable.');

    const reconciliation = scanned({
      status: 'anchor-unavailable',
      error,
    });

    vi.mocked(runDaemonIteration).mockImplementationOnce(
      async ({ onCompleted, onReconciliation }) => {
        onCompleted?.('durable', IMPORTED);
        onReconciliation?.(reconciliation);

        return {
          ...processed(reconciliation),
          softScan: undefined,
        };
      },
    );

    logCycle(await cycle());

    expect(loggerMocks.durableAnchorUnavailable)
      .toHaveBeenCalledExactlyOnceWith({
        consumer: CONSUMER_A,
        durableBlock: 900n,
        error,
      });

    expect(loggerMocks.roundImported).toHaveBeenCalledOnce();
    expect(loggerMocks.durableFulfillmentPending)
      .not.toHaveBeenCalled();
    expect(loggerMocks.durableFulfillmentUnavailable)
      .not.toHaveBeenCalled();
    expect(loggerMocks.checkpointAdvanced).not.toHaveBeenCalled();
    expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
  });

  it.each(['success', 'failed'] as const)(
    'distinguishes pending and unavailable fulfillment on a %s cycle outcome',
    async (outcome) => {
      const readError = new Error('Historical read unavailable.');
      const importError = new Error('A later import failed.');

      const reconciliation: DurableRequestResult = {
        ...scanned({
          status: 'verified',
          nextBlock: 800n,
        }),
        imports: [],
        fulfillment: [
          {
            round: ROUND,
            firstRequestBlock: 800n,
            fulfillment: { status: 'stored' },
          },
          {
            round: ROUND + 1n,
            firstRequestBlock: 800n,
            fulfillment: { status: 'not-stored' },
          },
          {
            round: ROUND + 2n,
            firstRequestBlock: 820n,
            fulfillment: {
              status: 'unavailable',
              error: readError,
            },
          },
        ],
      };

      vi.mocked(runDaemonIteration).mockImplementationOnce(
        async ({ onReconciliation }) => {
          onReconciliation?.(reconciliation);

          if (outcome === 'failed') {
            throw importError;
          }

          return {
            ...caughtUp(CONSUMER_A),
            status: 'processed',
            durableNextBlock: 800n,
            durableScan: {
              fromBlock: 800n,
              toBlock: 899n,
              nextBlock: 800n,
              processing: { rounds: [] },
              reconciliation,
            },
          };
        },
      );

      logCycle(await cycle());

      expect(loggerMocks.durableFulfillmentPending)
        .toHaveBeenCalledExactlyOnceWith({
          consumer: CONSUMER_A,
          round: ROUND + 1n,
          durableBlock: 900n,
        });

      expect(loggerMocks.durableFulfillmentUnavailable)
        .toHaveBeenCalledExactlyOnceWith({
          consumer: CONSUMER_A,
          round: ROUND + 2n,
          durableBlock: 900n,
          error: readError,
        });

      expect(
        loggerMocks.durableFulfillmentUnavailable
          .mock.calls[0]?.[0].error,
      ).toBe(readError);

      expect(loggerMocks.durableAnchorChanged).not.toHaveBeenCalled();
      expect(loggerMocks.durableAnchorUnavailable)
        .not.toHaveBeenCalled();
      expect(loggerMocks.checkpointAdvanced).not.toHaveBeenCalled();

      if (outcome === 'failed') {
        expect(loggerMocks.consumerFailed).toHaveBeenCalledOnce();
        expect(
          loggerMocks.consumerFailed.mock.calls[0]?.[0].error,
        ).toBe(importError);
      } else {
        expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
      }
    },
  );

  it('does not emit reconciliation events for a caught-up result', async () => {
    const reconciliation: DurableRequestResult = {
      status: 'caught-up',
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'verified',
        nextBlock: 901n,
      },
    };

    vi.mocked(runDaemonIteration).mockImplementationOnce(
      async ({ onReconciliation }) => {
        onReconciliation?.(reconciliation);
        return caughtUp(CONSUMER_A);
      },
    );

    logCycle(await cycle());

    expect(loggerMocks.durableFulfillmentPending)
      .not.toHaveBeenCalled();
    expect(loggerMocks.durableFulfillmentUnavailable)
      .not.toHaveBeenCalled();
    expect(loggerMocks.durableAnchorChanged).not.toHaveBeenCalled();
    expect(loggerMocks.durableAnchorUnavailable)
      .not.toHaveBeenCalled();
    expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
  });

  it('contains a failure from a new reconciliation logger method', async () => {
    const reconciliation = scanned();
    const loggingError = new Error('Logger failed.');

    vi.mocked(runDaemonIteration).mockImplementationOnce(
      async ({ onReconciliation }) => {
        onReconciliation?.(reconciliation);
        return processed(reconciliation);
      },
    );

    loggerMocks.durableFulfillmentPending.mockImplementationOnce(() => {
      throw loggingError;
    });

    const result = await cycle();

    expect(() => logCycle(result)).not.toThrow();

    expect(loggerMocks.loggingFailed)
      .toHaveBeenCalledExactlyOnceWith({
        error: loggingError,
      });
  });
});