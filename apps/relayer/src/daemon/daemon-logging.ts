import type {
  Address
} from 'viem';

import type {
  RunDaemonCycleResult,
} from './daemon-cycle.js';

import type {
  ProcessedDaemonScan,
} from './daemon-iteration.js';

import type {
  ConsumerHealth,
  RelayerLog,
} from '../diagnostics/relayer-log.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

type DaemonScanType =
  | 'durable'
  | 'soft';

export interface CreateDaemonLoggerOptions {
  logger: RelayerLog;
  heartbeatIntervalMs?: number;
  now?: () => number;
}

export interface DaemonLogger {
  onCycle(result: RunDaemonCycleResult): void;
}

export function createDaemonLogger(
  options: CreateDaemonLoggerOptions,
): DaemonLogger {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new Error('heartbeatIntervalMs must be a positive safe integer.');
  }

  const now = options.now ?? Date.now;
  let lastHeartbeatAt = now();

  return {
    onCycle(result: RunDaemonCycleResult): void {
      try {
        logCycle(options.logger, result);

        const currentTime = now();
        if (currentTime - lastHeartbeatAt >= heartbeatIntervalMs) {
          logHeartbeat(options.logger, result);
          lastHeartbeatAt = currentTime;
        }
      } catch (error) {
        logLoggingFailure(options.logger, error);
      }
    },
  };
}

function logCycle(
  logger: RelayerLog,
  result: RunDaemonCycleResult,
): void {
  for (const consumer of result.consumers) {
    if (consumer.status === 'failed') {
      logger.consumerFailed({
        consumer: consumer.consumer.address,
        error: consumer.error,
      });
      
      continue;
    }

    const iteration = consumer.iteration;
    if (iteration.durableHeadRegressed) {
      logger.durableHeadRegressed({
        consumer: consumer.consumer.address,
        durableBlock: iteration.durableBlock,
        durableNextBlock: iteration.durableNextBlock,
      });
    }

    if (iteration.durableScan !== undefined) {
      logScanRounds(
        logger,
        consumer.consumer.address,
        'durable',
        iteration.durableScan,
      );

      logger.checkpointAdvanced({
        consumer: consumer.consumer.address,
        fromBlock: iteration.durableScan.fromBlock,
        toBlock: iteration.durableScan.toBlock,
        nextBlock: iteration.durableScan.nextBlock,
      });
    }

    if (iteration.softScan !== undefined) {
      logScanRounds(
        logger,
        consumer.consumer.address,
        'soft',
        iteration.softScan,
      );
    }
  }
}

function logScanRounds(
  logger: RelayerLog,
  consumer: Address,
  scanType: DaemonScanType,
  scan: ProcessedDaemonScan,
): void {
  for (const processedRound of scan.processing.rounds) {
    const result = processedRound.result;
    if (result.status === 'imported') {
      logger.roundImported({
        consumer,
        scanType,
        round: processedRound.round,
        transactionHash: result.transactionHash,
      });

      continue;
    }

    logger.roundAlreadyStored({
      consumer,
      scanType,
      round: processedRound.round,
    });
  }
}

function logHeartbeat(
  logger: RelayerLog,
  result: RunDaemonCycleResult,
): void {
  const consumers = result.consumers.map((consumer): ConsumerHealth => {
    if (consumer.status === 'failed') {
      return {
        consumer: consumer.consumer.address,
        status: 'failed',
      };
    }

    return {
      consumer: consumer.consumer.address,
      status: 'healthy',
      latestBlock: consumer.iteration.latestBlock,
      durableBlock: consumer.iteration.durableBlock,
      durableNextBlock: consumer.iteration.durableNextBlock,
      softNextBlock: consumer.iteration.softCursor.nextBlock,
    };
  });

  logger.heartbeat({
    consumers,
  });
}

function logLoggingFailure(
  logger: RelayerLog,
  error: unknown,
): void {
  try {
    logger.loggingFailed({
      error,
    });
  } catch {
    // logging must never stop the daemon.
  }
}