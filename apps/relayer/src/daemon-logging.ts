import type {
  Logger,
} from 'pino';

import type {
  RunDaemonCycleResult,
} from './daemon-cycle.js';

import type {
  ProcessedDaemonScan,
} from './daemon-iteration.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

type DaemonScanType =
  | 'durable'
  | 'soft';

export interface CreateDaemonLoggerOptions {
  logger: Logger;
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
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <=0) {
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
    }
  };
}

function logCycle(
  logger: Logger,
  result: RunDaemonCycleResult,
): void {
  for (const consumer of result.consumers) {
    if (consumer.status === 'failed') {
      logger.error({
       event: 'consumer_failed',
       consumer: consumer.consumer.address,
       err: normalizeError(consumer.error), 
      }, 'Consumer processing failed');
      
      continue;
    }

    const iteration = consumer.iteration;
    if (iteration.durableScan !== undefined) {
      logScanRounds(
        logger,
        consumer.consumer.address,
        'durable',
        iteration.durableScan,
      );

      logger.info({
        event: 'checkpoint_advanced',
        consumer: consumer.consumer.address,
        fromBlock: iteration.durableScan.fromBlock.toString(),
        toBlock: iteration.durableScan.toBlock.toString(),
        nextBlock: iteration.durableScan.nextBlock.toString(),
      }, 'Durable checkpoint advanced');
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
  logger: Logger,
  consumer: string,
  scanType: DaemonScanType,
  scan: ProcessedDaemonScan,
): void {
  for (const processedRound of scan.processing.rounds) {
    const result = processedRound.result;
    if (result.status === 'imported') {
      logger.info({
        event: 'round_imported',
        consumer,
        scanType,
        round: processedRound.round.toString(),
        transactionHash: result.transactionHash,
      }, 'Quicknet round imported');

      continue;
    }

    logger.debug({
      event: 'round_already_stored',
      consumer,
      scanType,
      round: processedRound.round.toString(),
    }, 'Quicknet round already stored');
  }
}

function logHeartbeat(
  logger: Logger,
  result: RunDaemonCycleResult,
): void {
  const consumers = result.consumers.map((consumer) => {
    if (consumer.status === 'failed') {
      return {
        consumer: consumer.consumer.address,
        status: 'failed',
      };
    }

    return {
      consumer: consumer.consumer.address,
      status: 'healthy',
      latestBlock: consumer.iteration.latestBlock.toString(),
      durableBlock: consumer.iteration.durableBlock.toString(),
      durableNextBlock: consumer.iteration.durableNextBlock.toString(),
      softNextBlock: consumer.iteration.softCursor.nextBlock.toString(),
    };
  });

  logger.info({
    event: 'heartbeat',
    consumers,
  }, 'Relayer daemon healthy');
}

function normalizeError(
  error: unknown,
): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(`Non-Error value thrown: ${String(error)}`);
}

function logLoggingFailure(
  logger: Logger,
  error: unknown,
): void {
  try {
    logger.error({
      event: 'logging_failed',
      err: normalizeError(error),
    }, 'Daemon logging failed');
  } catch {
    // logging must never stop the daemon.
  }
}