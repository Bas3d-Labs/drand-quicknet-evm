import { writeSync } from 'node:fs';

import { performance } from 'node:perf_hooks';

import pino, { type Logger } from 'pino';

import {
  type Address,
  type Hash,
} from 'viem';

import { summarizeError } from './error-summary.js';

import { isFixedHex } from '../shared/hex.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
type ScanType = 'durable' | 'soft';

export type ConsumerHealth =
  | { 
      consumer: Address;
      status: 'failed';
    }
  | {
      consumer: Address;
      status: 'healthy';
      latestBlock: bigint;
      durableBlock: bigint;
      durableNextBlock: bigint;
      softNextBlock: bigint;
    };

interface Values {
  address: Address;
  hash: Hash;
  uint: bigint;
  scanType: ScanType;
  error: unknown;
  consumers: readonly ConsumerHealth[];
  submission: 'witness' | 'compressed';
  fallbackReason:
    | 'witness-rejected'
    | 'witness-decode-failed'
    | undefined;
}

type Kind = keyof Values;
type Schema = Readonly<Record<string, Kind>>;
type Definition = readonly [Level, string, string, Schema];

const EVENTS = {
  consumerFailed: [
    'error',
    'consumer_failed',
    'Consumer processing failed',
    {
      consumer: 'address',
      error: 'error',
    },
  ],
  durableHeadRegressed: [
    'warn',
    'durable_head_regressed',
    'Durable head is behind persisted checkpoint',
    {
      consumer: 'address',
      durableBlock: 'uint',
      durableNextBlock: 'uint',
    },
  ],
  checkpointAdvanced: [
    'debug',
    'checkpoint_advanced',
    'Durable checkpoint advanced',
    {
      consumer: 'address',
      fromBlock: 'uint',
      toBlock: 'uint',
      nextBlock: 'uint',
    },
  ],
  roundImported: [
    'info',
    'round_imported',
    'Quicknet round imported',
    {
      consumer: 'address',
      scanType: 'scanType',
      round: 'uint',
      transactionHash: 'hash',
      submission: 'submission',
      fallbackReason: 'fallbackReason',
    },
  ],
  roundAlreadyStored: [
    'debug',
    'round_already_stored',
    'Quicknet round already stored',
    {
      consumer: 'address',
      scanType: 'scanType',
      round: 'uint',
    },
  ],
  heartbeat: [
    'info',
    'heartbeat',
    'Relayer daemon heartbeat',
    {
      consumers: 'consumers',
    },
  ],
  loggingFailed: [
    'error',
    'logging_failed',
    'Daemon logging failed',
    {
      error: 'error',
    },
  ],
} as const satisfies Record<string, Definition>;

type EventDefinition = (typeof EVENTS)[keyof typeof EVENTS];
type EventName = EventDefinition[1] | 'invalid_log_level';

type Context<S extends Schema> = {
  [K in keyof S]: Values[S[K]];
};

export type RelayerLog = {
  readonly [K in keyof typeof EVENTS]:
    (context: Context<(typeof EVENTS)[K][3]>) => void;
};

export interface LogDestination {
  write(line: string): void;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface CreateRelayerLogOptions {
  chainId: number;
  level?: string;
  destination?: LogDestination;
}

type FallbackCode =
  | 'LOG_RECORD_REJECTED'
  | 'LOG_OUTPUT_FAILED';

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_HEARTBEAT_CONSUMERS = 25;

const MAX_RECORD_BYTES = 16_384 - 1_024;
const FALLBACK_INTERVAL_MS = 5 * 60_000;

const LEVELS = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
]);

export function createRelayerLog(
  options: CreateRelayerLogOptions,
): RelayerLog {
  const chainId = own(options, 'chainId');

  if (
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    throw new TypeError('Invalid logging chain ID.');
  }

  const requested = own(options, 'level') ?? 'info';
  const validLevel =
    typeof requested === 'string' &&
    LEVELS.has(requested);

  let level = 'info';
  if (validLevel) {
    level = requested;
  }

  let destination = own(options, 'destination') as LogDestination | undefined;

  // Tests that capture output supply a destination explicitly.
  if (
    process.env.NODE_ENV === 'test' &&
    destination === undefined
  ) {
    level = 'silent';
  }

  const lastFallback = new Map<string, number>();

  function fallback(
    code: FallbackCode,
    rejected?: EventName,
  ): void {
    try {
      // Both key components come from fixed internal declarations.
      const key = code + ':' + (rejected ?? 'destination');
      const now = performance.now();
      const previous = lastFallback.get(key);

      if (
        previous !== undefined &&
        now - previous < FALLBACK_INTERVAL_MS
      ) {
        return;
      }

      lastFallback.set(key, now);

      writeSync(2, JSON.stringify({
        level: 50,
        time: Date.now(),
        component: 'daemon',
        chainId,
        event: 'logging_failed',
        code,
        rejected,
        msg: 'Relayer logging failed',
      }) + '\n');
    } catch {
      // Best effort if stderr is also unavailable. Never print the raw failure.
    }
  }

  // Initialization errors propagate: do not return a logger that does nothing.
  if (destination === undefined) {
    destination = pino.destination({
      dest: 1,
      sync: true,
    });
  }

  if (
    destination === null ||
    typeof destination.write !== 'function'
  ) {
    throw new TypeError('Invalid logging destination.');
  }

  destination.on?.('error', () => {
    fallback('LOG_OUTPUT_FAILED');
  });

  const logger: Logger = pino({
    level,
    base: {
      component: 'daemon',
      chainId,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Projection already produced fresh summaries, preserve their structure.
    serializers: {
      err: (summary: unknown) => summary,
    },
  }, destination);

  function emit(
    severity: Level,
    record: Record<string, unknown>,
    message: string,
    event: EventName,
  ): void {
    try {
      // The only Pino emission point. All callers use fixed definitions.
      logger[severity](record, message);
    } catch {
      fallback('LOG_OUTPUT_FAILED', event);
    }
  }

  function dispatch(
    definition: EventDefinition,
    context: unknown,
  ): void {
    const [severity, event, message, schema] = definition;
    let record: Record<string, unknown>;

    try {
      record = project(schema, context);
      record.event = event;
      fitRecord(record);
    } catch {
      fallback('LOG_RECORD_REJECTED', event);
      return;
    }

    emit(severity, record, message, event);
  }

  if (!validLevel) {
    emit(
      'warn',
      {
        event: 'invalid_log_level',
        code: 'INVALID_LOG_LEVEL',
      },
      'Invalid log level; using info.',
      'invalid_log_level',
    );
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(EVENTS).map(([method, definition]) => [
      method,
      (context: unknown) => dispatch(definition, context),
    ]),
  )) as RelayerLog;
}

// Read declared own data fields only. Do not copy extras or accessors.
function own(
  input: unknown,
  key: string,
): unknown {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Invalid logging context.');
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) {
    return undefined;
  }

  if (!Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('Accessor in logging context.');
  }

  return descriptor.value;
}

function scalar(
  kind: Exclude<Kind, 'consumers'>,
  value: unknown,
): unknown {
  if (kind === 'error') {
    return summarizeError(value);
  }

  if (kind === 'address' && isFixedHex(value, 20)) {
    return value;
  }

  if (kind === 'hash' && isFixedHex(value, 32)) {
    return value;
  }

  if (
    kind === 'uint' &&
    typeof value === 'bigint' &&
    value >= 0n &&
    value <= MAX_UINT256
  ) {
    return value.toString();
  }

  if (
    kind === 'scanType' &&
    (value === 'durable' || value === 'soft')
  ) {
    return value;
  }

  if (
    kind === 'submission' &&
    (value === 'witness' || value === 'compressed')
  ) {
    return value;
  }

  if (
    kind === 'fallbackReason' &&
    (
      value === undefined ||
      value === 'witness-rejected' ||
      value === 'witness-decode-failed'
    )
  ) {
    return value;
  }

  throw new TypeError('Invalid logging field.');
}

function project(
  schema: Schema,
  input: unknown,
): Record<string, unknown> {
  const record: Record<string, unknown> = Object.create(null);

  for (const [key, kind] of Object.entries(schema)) {
    const value = own(input, key);

    if (kind === 'consumers') {
      if (!Array.isArray(value)) {
        throw new TypeError('Invalid heartbeat.');
      }

      const length = own(value, 'length');
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        throw new TypeError('Invalid heartbeat.');
      }

      const count = Math.min(length, MAX_HEARTBEAT_CONSUMERS);
      const consumers: Record<string, unknown>[] = [];

      for (let index = 0; index < count; index += 1) {
        const consumer = own(value, String(index));
        const status = own(consumer, 'status');
        const health = project({ consumer: 'address' }, consumer);

        if (status === 'healthy') {
          for (const field of [
            'latestBlock',
            'durableBlock',
            'durableNextBlock',
            'softNextBlock',
          ]) {
            health[field] = scalar('uint', own(consumer, field));
          }
        } else if (status !== 'failed') {
          throw new TypeError('Invalid consumer health.');
        }

        health.status = status;
        consumers.push(health);
      }

      record.consumers = consumers;

      if (length > count) {
        record.consumersOmitted = length - count;
      }
    } else {
      let outputKey = key;

      if (kind === 'error') {
        outputKey = 'err';
      }

      record[outputKey] = scalar(kind, value);
    }
  }

  return record;
}

function fitRecord(
  record: Record<string, unknown>,
): void {
  while (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) {
    // Only a bounded, freshly projected heartbeat array may be trimmed.
    if (
      !Array.isArray(record.consumers) ||
      record.consumers.length === 0
    ) {
      throw new RangeError('Log record too large.');
    }

    record.consumers.pop();

    const omitted = record.consumersOmitted;
    let omittedCount = 1;

    if (typeof omitted === 'number') {
      omittedCount += omitted;
    }

    record.consumersOmitted = omittedCount;
  }
}