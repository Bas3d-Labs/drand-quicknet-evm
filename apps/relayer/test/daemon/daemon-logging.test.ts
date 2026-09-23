import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Address,
  Hex,
} from 'viem';

import type {
  ValidatedQuicknetConsumer,
} from '../../src/consumers/consumer.js';

import type {
  RunDaemonCycleResult,
} from '../../src/daemon/daemon-cycle.js';

import {
  createDaemonLogger,
} from '../../src/daemon/daemon-logging.js';

import type {
  ProcessedDaemonScan,
  RunDaemonIterationResult,
} from '../../src/daemon/daemon-iteration.js';

import type {
  RelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import type {
  ProcessedQuicknetRound,
} from '../../src/consumers/request-processor.js';

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const REGISTRY_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const TRANSACTION_HASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const RANDOMNESS: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ROUND = 31_250_000n;

const VALIDATED_CONSUMER_A: ValidatedQuicknetConsumer = {
  address: CONSUMER_A,
  registry: REGISTRY_ADDRESS,
};

const VALIDATED_CONSUMER_B: ValidatedQuicknetConsumer = {
  address: CONSUMER_B,
  registry: REGISTRY_ADDRESS,
};

const loggerMocks = {
  consumerFailed: vi.fn<RelayerLog['consumerFailed']>(),
  durableHeadRegressed: vi.fn<RelayerLog['durableHeadRegressed']>(),
  checkpointAdvanced: vi.fn<RelayerLog['checkpointAdvanced']>(),
  roundImported: vi.fn<RelayerLog['roundImported']>(),
  roundAlreadyStored: vi.fn<RelayerLog['roundAlreadyStored']>(),
  heartbeat: vi.fn<RelayerLog['heartbeat']>(),
  loggingFailed: vi.fn<RelayerLog['loggingFailed']>(),
} satisfies RelayerLog;

const LOGGER: RelayerLog = loggerMocks;

function createIteration(
  overrides: Partial<RunDaemonIterationResult> = {},
): RunDaemonIterationResult {
  const iteration: RunDaemonIterationResult = {
    status: 'caught-up',
    consumer: CONSUMER_A,
    latestBlock: 1_000n,
    durableBlock: 900n,
    durableNextBlock: 901n,
    durableHeadRegressed: false,
    softCursor: {
      nextBlock: 1_001n,
    },
    durableScan: undefined,
    softScan: undefined,
    ...overrides,
  };

  if (
    iteration.durableScan !== undefined ||
    iteration.softScan !== undefined
  ) {
    iteration.status = 'processed';
  }

  return iteration;
}

function createScan(
  rounds: readonly ProcessedQuicknetRound[] = [],
  overrides: Partial<
    Pick<
      ProcessedDaemonScan,
      | 'fromBlock'
      | 'toBlock'
      | 'nextBlock'
    >
  > = {},
): ProcessedDaemonScan {
  return {
    fromBlock: 800n,
    toBlock: 899n,
    nextBlock: 900n,
    processing: {
      rounds,
    },
    ...overrides,
  };
}

function createImportedRound(
  round = ROUND,
): ProcessedQuicknetRound {
  return {
    round,
    result: {
      status: 'imported',
      round,
      randomness: RANDOMNESS,
      transactionHash: TRANSACTION_HASH,
    },
  };
}

function createAlreadyStoredRound(
  round = ROUND,
): ProcessedQuicknetRound {
  return {
    round,
    result: {
      status: 'already-stored',
      round,
      randomness: RANDOMNESS,
    },
  };
}

function createSuccessfulCycle(
  iteration = createIteration(),
  consumer = VALIDATED_CONSUMER_A,
): RunDaemonCycleResult {
  return {
    consumers: [
      {
        status: 'success',
        consumer,
        iteration,
      },
    ],
  };
}

function createFailedCycle(
  error: unknown,
  consumer = VALIDATED_CONSUMER_A,
): RunDaemonCycleResult {
  return {
    consumers: [
      {
        status: 'failed',
        consumer,
        error,
      },
    ],
  };
}

describe('createDaemonLogger', () => {
  beforeEach(() => {
    for (const mock of Object.values(loggerMocks)) {
      mock.mockReset();
    }
  });

  it('rejects a zero heartbeat interval', () => {
    expect(() => {
      createDaemonLogger({
        logger: LOGGER,
        heartbeatIntervalMs: 0,
      });
    }).toThrow(
      'heartbeatIntervalMs must be a positive safe integer.',
    );
  });

  it('rejects a non-integer heartbeat interval', () => {
    expect(() => {
      createDaemonLogger({
        logger: LOGGER,
        heartbeatIntervalMs: 1.5,
      });
    }).toThrow(
      'heartbeatIntervalMs must be a positive safe integer.',
    );
  });

  it('reports an imported durable round', () => {
    const iteration = createIteration({
      durableScan: createScan([
        createImportedRound(),
      ]),
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.roundImported).toHaveBeenCalledOnce();

    expect(loggerMocks.roundImported).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      scanType: 'durable',
      round: ROUND,
      transactionHash: TRANSACTION_HASH,
    });

    expect(loggerMocks.roundAlreadyStored).not.toHaveBeenCalled();
  });

  it('reports an imported soft round', () => {
    const iteration = createIteration({
      softScan: createScan([
        createImportedRound(),
      ]),
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.roundImported).toHaveBeenCalledOnce();

    expect(loggerMocks.roundImported).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      scanType: 'soft',
      round: ROUND,
      transactionHash: TRANSACTION_HASH,
    });

    expect(loggerMocks.roundAlreadyStored).not.toHaveBeenCalled();
  });

  it('reports an already-stored durable round', () => {
    const iteration = createIteration({
      durableScan: createScan([
        createAlreadyStoredRound(),
      ]),
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.roundAlreadyStored).toHaveBeenCalledOnce();

    expect(loggerMocks.roundAlreadyStored).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      scanType: 'durable',
      round: ROUND,
    });

    expect(loggerMocks.roundImported).not.toHaveBeenCalled();
    expect(loggerMocks.checkpointAdvanced).toHaveBeenCalledOnce();
  });

  it('reports an already-stored soft round', () => {
    const iteration = createIteration({
      softScan: createScan([
        createAlreadyStoredRound(),
      ]),
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.roundAlreadyStored).toHaveBeenCalledOnce();

    expect(loggerMocks.roundAlreadyStored).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      scanType: 'soft',
      round: ROUND,
    });

    expect(loggerMocks.roundImported).not.toHaveBeenCalled();
  });

  it('reports durable checkpoint advancement', () => {
    const iteration = createIteration({
      durableScan: createScan([], {
        fromBlock: 800n,
        toBlock: 899n,
        nextBlock: 900n,
      }),
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.checkpointAdvanced).toHaveBeenCalledOnce();

    expect(loggerMocks.checkpointAdvanced).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      fromBlock: 800n,
      toBlock: 899n,
      nextBlock: 900n,
    });
  });

  it('does not report checkpoint advancement for a soft scan', () => {
    const iteration = createIteration({
      softScan: createScan([
        createImportedRound(),
      ]),
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.roundImported).toHaveBeenCalledOnce();
    expect(loggerMocks.checkpointAdvanced).not.toHaveBeenCalled();
  });

  it('forwards the original consumer error', () => {
    const error = new Error('RPC request failed.');

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createFailedCycle(error));

    expect(loggerMocks.consumerFailed).toHaveBeenCalledOnce();

    expect(loggerMocks.consumerFailed).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      error,
    });

    const context = loggerMocks.consumerFailed.mock.calls[0]?.[0];

    expect(context?.error).toBe(error);
    expect(loggerMocks.loggingFailed).not.toHaveBeenCalled();
  });

  it('forwards a non-Error consumer failure unchanged', () => {
    const failure = 'RPC request failed';

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createFailedCycle(failure));

    expect(loggerMocks.consumerFailed).toHaveBeenCalledOnce();

    expect(loggerMocks.consumerFailed).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      error: failure,
    });

    expect(loggerMocks.loggingFailed).not.toHaveBeenCalled();
  });

  it('does not emit a heartbeat before the default interval', () => {
    let currentTime = 0;

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => currentTime,
    });

    currentTime = 59_999;

    daemonLogger.onCycle(createSuccessfulCycle());

    expect(loggerMocks.heartbeat).not.toHaveBeenCalled();
  });

  it('emits a heartbeat at the default interval', () => {
    let currentTime = 0;

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => currentTime,
    });

    currentTime = 60_000;

    daemonLogger.onCycle(createSuccessfulCycle());

    expect(loggerMocks.heartbeat).toHaveBeenCalledOnce();

    expect(loggerMocks.heartbeat).toHaveBeenCalledWith({
      consumers: [
        {
          consumer: CONSUMER_A,
          status: 'healthy',
          latestBlock: 1_000n,
          durableBlock: 900n,
          durableNextBlock: 901n,
          softNextBlock: 1_001n,
        },
      ],
    });
  });

  it('waits another heartbeat interval before emitting again', () => {
    let currentTime = 0;

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      heartbeatIntervalMs: 1_000,
      now: () => currentTime,
    });

    currentTime = 1_000;

    daemonLogger.onCycle(createSuccessfulCycle());

    expect(loggerMocks.heartbeat).toHaveBeenCalledTimes(1);

    currentTime = 1_999;

    daemonLogger.onCycle(createSuccessfulCycle());

    expect(loggerMocks.heartbeat).toHaveBeenCalledTimes(1);

    currentTime = 2_000;

    daemonLogger.onCycle(createSuccessfulCycle());

    expect(loggerMocks.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('includes healthy and failed consumers in the heartbeat', () => {
    let currentTime = 0;

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      heartbeatIntervalMs: 1_000,
      now: () => currentTime,
    });

    const failure = new Error('RPC unavailable.');

    const result: RunDaemonCycleResult = {
      consumers: [
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_A,
          iteration: createIteration({
            latestBlock: 2_000n,
            durableBlock: 1_900n,
            durableNextBlock: 1_901n,
            softCursor: {
              nextBlock: 2_001n,
            },
          }),
        },
        {
          status: 'failed',
          consumer: VALIDATED_CONSUMER_B,
          error: failure,
        },
      ],
    };

    currentTime = 1_000;

    daemonLogger.onCycle(result);

    expect(loggerMocks.consumerFailed).toHaveBeenCalledWith({
      consumer: CONSUMER_B,
      error: failure,
    });

    expect(loggerMocks.heartbeat).toHaveBeenCalledOnce();

    expect(loggerMocks.heartbeat).toHaveBeenCalledWith({
      consumers: [
        {
          consumer: CONSUMER_A,
          status: 'healthy',
          latestBlock: 2_000n,
          durableBlock: 1_900n,
          durableNextBlock: 1_901n,
          softNextBlock: 2_001n,
        },
        {
          consumer: CONSUMER_B,
          status: 'failed',
        },
      ],
    });
  });

  it('preserves bigint fields without precision loss', () => {
    const round = 9_007_199_254_740_993n;

    const iteration = createIteration({
      durableScan: createScan(
        [
          createImportedRound(round),
        ],
        {
          fromBlock: 9_007_199_254_740_994n,
          toBlock: 9_007_199_254_740_995n,
          nextBlock: 9_007_199_254_740_996n,
        },
      ),
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.roundImported).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      scanType: 'durable',
      round: 9_007_199_254_740_993n,
      transactionHash: TRANSACTION_HASH,
    });

    expect(loggerMocks.checkpointAdvanced).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      fromBlock: 9_007_199_254_740_994n,
      toBlock: 9_007_199_254_740_995n,
      nextBlock: 9_007_199_254_740_996n,
    });
  });

  it('reports an injected logger failure without throwing', () => {
    const loggingFailure = new Error('Injected logger failure.');

    loggerMocks.heartbeat.mockImplementationOnce(() => {
      throw loggingFailure;
    });

    let currentTime = 0;

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      heartbeatIntervalMs: 1_000,
      now: () => currentTime,
    });

    currentTime = 1_000;

    expect(() => {
      daemonLogger.onCycle(createSuccessfulCycle());
    }).not.toThrow();

    expect(loggerMocks.heartbeat).toHaveBeenCalledOnce();
    expect(loggerMocks.loggingFailed).toHaveBeenCalledOnce();

    expect(loggerMocks.loggingFailed).toHaveBeenCalledWith({
      error: loggingFailure,
    });

    const context = loggerMocks.loggingFailed.mock.calls[0]?.[0];

    expect(context?.error).toBe(loggingFailure);
  });

  it('contains failure of both an injected logger and its fallback', () => {
    const loggingFailure = new Error('Injected logger failure.');

    loggerMocks.consumerFailed.mockImplementationOnce(() => {
      throw loggingFailure;
    });

    loggerMocks.loggingFailed.mockImplementationOnce(() => {
      throw new Error('Injected fallback failure.');
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    expect(() => {
      daemonLogger.onCycle(
        createFailedCycle(new Error('Consumer failed.')),
      );
    }).not.toThrow();

    expect(loggerMocks.consumerFailed).toHaveBeenCalledOnce();
    expect(loggerMocks.loggingFailed).toHaveBeenCalledOnce();

    expect(loggerMocks.loggingFailed).toHaveBeenCalledWith({
      error: loggingFailure,
    });
  });

  it('reports when the durable head regresses behind the checkpoint', () => {
    const iteration = createIteration({
      durableHeadRegressed: true,
      durableBlock: 1_250n,
      durableNextBlock: 1_301n,
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.durableHeadRegressed).toHaveBeenCalledOnce();

    expect(loggerMocks.durableHeadRegressed).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      durableBlock: 1_250n,
      durableNextBlock: 1_301n,
    });

    expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
    expect(loggerMocks.loggingFailed).not.toHaveBeenCalled();
  });

  it('does not report a regression when the durable head has not regressed', () => {
    const iteration = createIteration({
      durableHeadRegressed: false,
    });

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      now: () => 0,
    });

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.durableHeadRegressed).not.toHaveBeenCalled();
  });

  it('reports a consumer as healthy during a durable head regression', () => {
    let currentTime = 0;

    const daemonLogger = createDaemonLogger({
      logger: LOGGER,
      heartbeatIntervalMs: 1_000,
      now: () => currentTime,
    });

    const iteration = createIteration({
      latestBlock: 1_500n,
      durableBlock: 1_250n,
      durableNextBlock: 1_301n,
      durableHeadRegressed: true,
      softCursor: {
        nextBlock: 1_501n,
      },
    });

    currentTime = 1_000;

    daemonLogger.onCycle(createSuccessfulCycle(iteration));

    expect(loggerMocks.durableHeadRegressed).toHaveBeenCalledWith({
      consumer: CONSUMER_A,
      durableBlock: 1_250n,
      durableNextBlock: 1_301n,
    });

    expect(loggerMocks.heartbeat).toHaveBeenCalledWith({
      consumers: [
        {
          consumer: CONSUMER_A,
          status: 'healthy',
          latestBlock: 1_500n,
          durableBlock: 1_250n,
          durableNextBlock: 1_301n,
          softNextBlock: 1_501n,
        },
      ],
    });

    expect(loggerMocks.consumerFailed).not.toHaveBeenCalled();
  });
});