import pino, {
  type Logger,
  type LoggerOptions,
} from 'pino';

export interface CreateLoggerOptions {
  level?: string;
}

export function createLogger(
  options: CreateLoggerOptions = {},
): Logger {
  let level =
    options.level ??
    process.env.QUICKNET_LOG_LEVEL ??
    'info';

  if (process.env.NODE_ENV === 'test') {
    level = 'silent';
  }

  const pinoOptions: LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return pino(pinoOptions);
}

export const logger = createLogger();