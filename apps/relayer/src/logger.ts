import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

import {
  summarizeError,
} from './error-summary.js';

export interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

const LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

export function createLogger(
  options: CreateLoggerOptions = {},
): Logger {
  let level =
    options.level ??
    process.env.QUICKNET_LOG_LEVEL ??
    'info';

  if (process.env.NODE_ENV === 'test' && options.level === undefined) {
    level = 'silent';
  }

  const invalidLevel = !LOG_LEVELS.has(level);
  if (invalidLevel) {
    level = 'info';
  }

  const pinoOptions: LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: summarizeError,
      error: summarizeError,
    },
    hooks: {
      logMethod(args, method) {
        const value = args[0];

        // Pino derives msg from the raw error before running serializers.
        // Project first so omitted messages cannot bypass redaction.
        if (value instanceof Error) {
          args[0] = { err: summarizeError(value) };
        } else if (typeof value === 'object' && value !== null) {
          if ('err' in value) {
            args[0] = { ...value, err: summarizeError(value.err) };
          }
        }

        method.apply(this, args);
      },
    },
  };
  
  let logger: Logger;

  if (options.destination !== undefined) {
    logger = pino(pinoOptions, options.destination);
  } else {
    logger = pino(pinoOptions);
  }

  if (invalidLevel) {
    logger.warn({
      event: 'invalid_log_level',
      code: 'INVALID_LOG_LEVEL',
    }, 'Invalid log level; using info.');
  }

  return logger;
}

export const logger = createLogger();