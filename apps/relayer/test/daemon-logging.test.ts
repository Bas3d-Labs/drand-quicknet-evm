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
  Logger,
} from 'pino';

import type {
  ValidatedQuicknetConsumer,
} from '../src/consumer.js';

import type {
  RunDaemonCycleResult,
} from '../src/daemon-cycle.js';

import {
  createDaemonLogger,
} from '../src/daemon-logging.js';

import type {
  ProcessedDaemonScan,
  RunDaemonIterationResult,
} from '../src/daemon-iteration.js';

import type {
  ProcessedQuicknetRound,
} from '../src/request-processor.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';

const REGISTRY_ADDRESS: Address = '0x3333333333333333333333333333333333333333';

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
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const LOGGER = loggerMocks as unknown as Logger;

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
    loggerMocks.debug.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
    loggerMocks.error.mockReset();
  });

  it('rejects a zero heartbeat interval', () => {
    expect(
      () =>
        createDaemonLogger({
          logger: LOGGER,
          heartbeatIntervalMs: 0,
        }),
    ).toThrow(
      'heartbeatIntervalMs must be a positive safe integer.'
    );
  });

  it('rejects a non-integer heartbeat interval', () => {
    expect(
      () =>
        createDaemonLogger({
          logger: LOGGER,
          heartbeatIntervalMs: 1.5,
        }),
    ).toThrow(
      'heartbeatIntervalMs must be a positive safe integer.'
    );
  });

  it('logs an imported durable round', () => {
    const iteration =
      createIteration({
        durableScan:
          createScan([
            createImportedRound(),
          ]),
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenNthCalledWith(
      1,
      {
        event: 'round_imported',
        consumer: CONSUMER_A,
        scanType: 'durable',
        round: ROUND.toString(),
        transactionHash:
          TRANSACTION_HASH,
      },
      'Quicknet round imported',
    );
  });

  it('logs an imported soft round', () => {
    const iteration =
      createIteration({
        softScan:
          createScan([
            createImportedRound(),
          ]),
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledWith(
      {
        event: 'round_imported',
        consumer: CONSUMER_A,
        scanType: 'soft',
        round: ROUND.toString(),
        transactionHash: TRANSACTION_HASH,
      },
      'Quicknet round imported',
    );
  });

  it('logs an already-stored durable round at debug level', () => {
    const iteration =
      createIteration({
        durableScan:
          createScan([
            createAlreadyStoredRound(),
          ]),
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.debug,
    ).toHaveBeenNthCalledWith(
      1,
      {
        event: 'round_already_stored',
        consumer: CONSUMER_A,
        scanType: 'durable',
        round: ROUND.toString(),
      },
      'Quicknet round already stored',
    );

    expect(
      loggerMocks.debug,
    ).toHaveBeenCalledTimes(
      2
    );
  });

  it('logs an already-stored soft round at debug level', () => {
    const iteration =
      createIteration({
        softScan:
          createScan([
            createAlreadyStoredRound(),
          ]),
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.debug,
    ).toHaveBeenCalledWith(
      {
        event: 'round_already_stored',
        consumer: CONSUMER_A,
        scanType: 'soft',
        round: ROUND.toString(),
      },
      'Quicknet round already stored',
    );
  });

  it('logs durable checkpoint advancement', () => {
    const durableScan =
      createScan(
        [],
        {
          fromBlock: 800n,
          toBlock: 899n,
          nextBlock: 900n,
        },
      );

    const iteration =
      createIteration({
        durableScan,
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.debug,
    ).toHaveBeenCalledWith(
      {
        event: 'checkpoint_advanced',
        consumer: CONSUMER_A,
        fromBlock: '800',
        toBlock: '899',
        nextBlock: '900',
      },
      'Durable checkpoint advanced',
    );
  });

  it('does not log checkpoint advancement for a soft scan', () => {
    const iteration =
      createIteration({
        softScan:
          createScan([
            createImportedRound(),
          ]),
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.debug,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'checkpoint_advanced',
      }),
      expect.anything(),
    );
  });

  it('logs consumer failures with the original Error', () => {
    const error =
      new Error(
        'RPC request failed.',
      );

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createFailedCycle(
        error,
      ),
    );

    expect(
      loggerMocks.error,
    ).toHaveBeenCalledOnce();

    expect(
      loggerMocks.error,
    ).toHaveBeenCalledWith(
      {
        event: 'consumer_failed',
        consumer: CONSUMER_A,
        err: error,
      },
      'Consumer processing failed',
    );
  });

  it('normalizes a non-Error consumer failure', () => {
    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createFailedCycle(
        'RPC request failed',
      ),
    );

    expect(
      loggerMocks.error,
    ).toHaveBeenCalledOnce();

    const call =
      loggerMocks.error.mock.calls[0];

    if (call === undefined) {
      throw new Error(
        'Expected logger.error to have been called.'
      );
    }

    const context =
      call[0] as {
        event: string;
        consumer: Address;
        err: Error;
      };

    expect(
      context.event,
    ).toBe(
      'consumer_failed',
    );

    expect(
      context.consumer,
    ).toBe(
      CONSUMER_A,
    );

    expect(
      context.err,
    ).toBeInstanceOf(
      Error,
    );

    expect(
      context.err.message,
    ).toBe(
      'Non-Error value thrown: RPC request failed',
    );

    expect(
      call[1],
    ).toBe(
      'Consumer processing failed',
    );
  });

  it('does not emit a heartbeat before the default interval', () => {
    let currentTime = 0;

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () =>
          currentTime,
      });

    currentTime = 59_999;

    daemonLogger.onCycle(
      createSuccessfulCycle(),
    );

    expect(
      loggerMocks.info,
    ).not.toHaveBeenCalled();
  });

  it('emits a heartbeat after the default interval', () => {
    let currentTime = 0;

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () =>
          currentTime,
      });

    currentTime = 60_000;

    daemonLogger.onCycle(
      createSuccessfulCycle(),
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledOnce();

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledWith(
      {
        event: 'heartbeat',
        consumers: [
          {
            consumer: CONSUMER_A,
            status: 'healthy',
            latestBlock: '1000',
            durableBlock: '900',
            durableNextBlock: '901',
            softNextBlock: '1001',
          },
        ],
      },
      'Relayer daemon heartbeat',
    );
  });

  it('waits another heartbeat interval before emitting again', () => {
    let currentTime = 0;

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        heartbeatIntervalMs:
          1_000,
        now: () =>
          currentTime,
      });

    currentTime = 1_000;

    daemonLogger.onCycle(
      createSuccessfulCycle(),
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledTimes(1);

    currentTime = 1_999;

    daemonLogger.onCycle(
      createSuccessfulCycle(),
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledTimes(1);

    currentTime = 2_000;

    daemonLogger.onCycle(
      createSuccessfulCycle(),
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledTimes(2);
  });

  it('includes healthy and failed consumers in the heartbeat', () => {
    let currentTime = 0;

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        heartbeatIntervalMs: 1_000,
        now: () => currentTime,
      });

    currentTime = 1_000;

    const result: RunDaemonCycleResult = {
      consumers: [
        {
          status: 'success',
          consumer:
            VALIDATED_CONSUMER_A,
          iteration:
            createIteration({
              latestBlock: 2_000n,
              durableBlock: 1_900n,
              durableNextBlock: 1_901n,
              durableHeadRegressed: false,
              softCursor: {
                nextBlock: 2_001n,
              },
            }),
        },
        {
          status: 'failed',
          consumer: VALIDATED_CONSUMER_B,
          error: new Error('RPC unavailable.'),
        },
      ],
    };

    daemonLogger.onCycle(
      result,
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledWith(
      {
        event: 'heartbeat',
        consumers: [
          {
            consumer: CONSUMER_A,
            status: 'healthy',
            latestBlock: '2000',
            durableBlock: '1900',
            durableNextBlock: '1901',
            softNextBlock: '2001',
          },
          {
            consumer: CONSUMER_B,
            status: 'failed',
          },
        ],
      },
      'Relayer daemon heartbeat',
    );
  });

  it('serializes bigint log fields as decimal strings', () => {
    const round = 9_007_199_254_740_993n;

    const iteration =
      createIteration({
        durableScan:
          createScan(
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

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        round: '9007199254740993',
      }),
      'Quicknet round imported',
    );

    expect(
      loggerMocks.debug,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBlock: '9007199254740994',
        toBlock: '9007199254740995',
        nextBlock: '9007199254740996',
      }),
      'Durable checkpoint advanced',
    );
  });

  it('logs an internal logging failure without throwing', () => {
    const loggingFailure =
      new Error('Logger write failed.');

    loggerMocks.info.mockImplementationOnce(
      () => {
        throw loggingFailure;
      },
    );

    let currentTime = 0;

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        heartbeatIntervalMs: 1_000,
        now: () => currentTime,
      });

    currentTime = 1_000;

    expect(
      () =>
        daemonLogger.onCycle(
          createSuccessfulCycle(),
        ),
    ).not.toThrow();

    expect(
      loggerMocks.error,
    ).toHaveBeenCalledWith(
      {
        event: 'logging_failed',
        err: loggingFailure,
      },
      'Daemon logging failed',
    );
  });

  it('does not throw when fallback logging also fails', () => {
    loggerMocks.error.mockImplementation(
      () => {
        throw new Error(
          'Logger is unavailable.',
        );
      },
    );

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    expect(
      () =>
        daemonLogger.onCycle(
          createFailedCycle(
            new Error('Consumer failed.'),
          ),
        ),
    ).not.toThrow();
  });

  it('warns when the durable head regresses behind the checkpoint', () => {
    const iteration =
      createIteration({
        durableHeadRegressed: true,
        durableBlock: 1_250n,
        durableNextBlock: 1_301n,
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.warn,
    ).toHaveBeenCalledOnce();

    expect(
      loggerMocks.warn,
    ).toHaveBeenCalledWith(
      {
        event: 'durable_head_regressed',
        consumer: CONSUMER_A,
        durableBlock: '1250',
        durableNextBlock: '1301',
      },
      'Durable head is behind persisted checkpoint',
    );

    expect(
      loggerMocks.error,
    ).not.toHaveBeenCalled();
  });

  it('does not warn when the durable head has not regressed', () => {
    const iteration =
      createIteration({
        durableHeadRegressed: false,
      });

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        now: () => 0,
      });

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.warn,
    ).not.toHaveBeenCalled();
  });

  it('reports a consumer as healthy during a durable head regression', () => {
    let currentTime = 0;

    const daemonLogger =
      createDaemonLogger({
        logger: LOGGER,
        heartbeatIntervalMs: 1_000,
        now: () => currentTime,
      });

    const iteration =
      createIteration({
        latestBlock: 1_500n,
        durableBlock: 1_250n,
        durableNextBlock: 1_301n,
        durableHeadRegressed: true,
        softCursor: {
          nextBlock: 1_501n,
        },
      });

    currentTime = 1_000;

    daemonLogger.onCycle(
      createSuccessfulCycle(
        iteration,
      ),
    );

    expect(
      loggerMocks.warn,
    ).toHaveBeenCalledWith(
      {
        event: 'durable_head_regressed',
        consumer: CONSUMER_A,
        durableBlock: '1250',
        durableNextBlock: '1301',
      },
      'Durable head is behind persisted checkpoint',
    );

    expect(
      loggerMocks.info,
    ).toHaveBeenCalledWith(
      {
        event: 'heartbeat',
        consumers: [
          {
            consumer: CONSUMER_A,
            status: 'healthy',
            latestBlock: '1500',
            durableBlock: '1250',
            durableNextBlock: '1301',
            softNextBlock: '1501',
          },
        ],
      },
      'Relayer daemon heartbeat',
    );
  });
});