import { randomUUID } from 'node:crypto';

import { writeSync } from 'node:fs';

import { performance } from 'node:perf_hooks';

import pino, { type Logger } from 'pino';

import {
  type Address,
  type Hash,
} from 'viem';

import {
  type SummarizeErrorOptions,
} from './error-summary.js';

import {
  isFixedHex
} from '../shared/hex.js';

import {
  summarizeErrorForOutput,
} from './error-output.js';

import {
  projectRoundImportProgress,
  type OperationContext,
} from './operation-context.js';

import type {
  AttemptResolutionEvidence,
} from './transaction-evidence.js';

import { isUuidV4 } from '../shared/uuid.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
type ScanType = 'durable' | 'soft';

export interface RelayerLogContext {
  readonly cycle?: number;
  readonly signer?: Address;
  readonly attemptId?: string;
  readonly operation?: OperationContext;
}

export type ScopedRelayerLog = RelayerLog & TransactionLog & {
  readonly withContext: (
    context: RelayerLogContext,
  ) => ScopedRelayerLog;

  readonly withErrorSummary: (
    policy: SummarizeErrorOptions,
  ) => ScopedRelayerLog;
};

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
  id: string;
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
  operation: OperationContext | undefined;
  resolution: AttemptResolutionEvidence;
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
      operation: 'operation',
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
  durableFulfillmentPending: [
    'debug',
    'durable_fulfillment_pending',
    'Beacon is not stored at the selected durable block',
    {
      consumer: 'address',
      round: 'uint',
      durableBlock: 'uint',
    },
  ],
  durableFulfillmentUnavailable: [
    'warn',
    'durable_fulfillment_unavailable',
    'Durable fulfillment unavailable. Checkpoint advancement deferred',
    {
      consumer: 'address',
      round: 'uint',
      durableBlock: 'uint',
      error: 'error',
    },
  ],
  durableAnchorChanged: [
    'warn',
    'durable_anchor_changed',
    'Durable anchor changed. Checkpoint advancement deferred',
    {
      consumer: 'address',
      durableBlock: 'uint',
      expectedHash: 'hash',
      observedHash: 'hash',
    },
  ],
  durableAnchorUnavailable: [
    'warn',
    'durable_anchor_unavailable',
    'Durable anchor unavailable. Checkpoint advancement deferred',
    {
      consumer: 'address',
      durableBlock: 'uint',
      error: 'error',
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

const TRANSACTION_EVENTS = {
  attemptResolved: [
    'info',
    'attempt_resolved',
    'Transaction attempt resolved and journal clear persisted',
    {
      signer: 'address',
      attemptId: 'id',
      transactionHash: 'hash',
      nonce: 'uint',
      resolution: 'resolution',
    },
  ],
} as const satisfies Record<string, Definition>;

type EventDefinition =
  | (typeof EVENTS)[keyof typeof EVENTS]
  | (typeof TRANSACTION_EVENTS)[keyof typeof TRANSACTION_EVENTS];

type EventName = EventDefinition[1] | 'invalid_log_level';

type OptionalKind = 'operation';

type Context<S extends Schema> = {
  [K in keyof S as S[K] extends OptionalKind ? never : K]: Values[S[K]];
} & {
  [K in keyof S as S[K] extends OptionalKind ? K : never]?: Values[S[K]];
};

export type RelayerLog = {
  readonly [K in keyof typeof EVENTS]:
    (context: Context<(typeof EVENTS)[K][3]>) => void;
};

type TransactionLog = {
  readonly [K in keyof typeof TRANSACTION_EVENTS]:
    (context: Context<(typeof TRANSACTION_EVENTS)[K][3]>) => void;
};

export interface LogDestination {
  write(line: string): void;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface CreateRelayerLogOptions {
  chainId: number;
  level?: string;
  destination?: LogDestination;
  errorSummary?: SummarizeErrorOptions | undefined;
}

type FallbackCode =
  | 'LOG_RECORD_REJECTED'
  | 'LOG_OUTPUT_FAILED';

const RUN_ID = randomUUID();
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
): ScopedRelayerLog {
  const chainId = own(options, 'chainId');

  if (
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    throw new TypeError('Invalid logging chain ID.');
  }

  const requested = own(options, 'level') ?? 'info';

  const errorSummary = snapshotErrorSummaryOptions(
    own(options, 'errorSummary'),
  );

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
        runId: RUN_ID,
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
      runId: RUN_ID,
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
    policy: SummarizeErrorOptions | undefined,
    bindings: Readonly<Record<string, unknown>>,
  ): void {
    const [severity, event, message, schema] = definition;
    let record: Record<string, unknown>;

    try {
      const projected = project(schema, context, policy);

      for (const key of ['signer', 'attemptId']) {
        const bound = bindings[key];
        const supplied = projected[key];

        if (
          typeof bound === 'string' &&
          typeof supplied === 'string' &&
          bound.toLowerCase() !== supplied.toLowerCase()
        ) {
          throw new TypeError('Conflicting logging identity.');
        }
      }

      record = {
        ...bindings,
        ...projected,
        event,
      };

      if (record.operationOmitted === true) {
        delete record.operation;
      }

      if (event === 'attempt_resolved') {
        validateResolutionRecord(record);
      }

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

  function bind(
    policy: SummarizeErrorOptions | undefined,
    bindings: Readonly<Record<string, unknown>>,
  ): ScopedRelayerLog {
    const definitions = {
      ...EVENTS,
      ...TRANSACTION_EVENTS,
    };

    const methods = Object.fromEntries(
      Object.entries(definitions).map(([method, definition]) => [
        method,
        (context: unknown) => dispatch(
          definition,
          context,
          policy,
          bindings,
        ),
      ]),
    ) as RelayerLog & TransactionLog;

    return Object.freeze({
      ...methods,

      withContext(context: RelayerLogContext): ScopedRelayerLog {
        return bind(policy, Object.freeze({
          ...bindings,
          ...projectBindings(context, policy),
        }));
      },

      withErrorSummary(
        nextPolicy: SummarizeErrorOptions,
      ): ScopedRelayerLog {
        const snapshot = snapshotErrorSummaryOptions(nextPolicy);
        if (snapshot === undefined) {
          throw new TypeError('Invalid error summary policy.');
        }

        return bind(snapshot, bindings);
      },
    });
  }

  return bind(errorSummary, Object.freeze({}));
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

function snapshotErrorSummaryOptions(
  input: unknown,
): SummarizeErrorOptions | undefined {
  if (input === undefined) {
    return undefined;
  }

  const scrubText = own(input, 'scrubText');
  if (typeof scrubText !== 'function') {
    throw new TypeError('Invalid error summary policy.');
  }

  return Object.freeze({
    scrubText: scrubText as SummarizeErrorOptions['scrubText'],
  });
}

function scalar(
  kind: Exclude<Kind, 'consumers'>,
  value: unknown,
  errorSummary: SummarizeErrorOptions | undefined,
): unknown {
  if (kind === 'operation') {
    if (value === undefined) {
      return undefined;
    }

    const name = own(value, 'name');
    let schema: Schema;

    switch(name) {
      case 'load-checkpoint':
      case 'read-chain-heads':
      case 'prepare-attempt':
      case 'broadcast-attempt':
      case 'reconcile-attempt':
      case 'search-replacement':
      case 'persist-journal':
        schema = {};
        break;

      case 'import-round': {
        const context = project({
          scanType: 'scanType',
          fromBlock: 'uint',
          toBlock: 'uint',
        }, value, errorSummary);

        Object.assign(context, projectRoundImportProgress(value));
        context.name = name;

        return context;
      }

      case 'scan-requests':
        schema = {
          scanType: 'scanType',
          fromBlock: 'uint',
          throughBlock: 'uint',
          maxBlockRange: 'uint',
        };
        break;

      case 'process-requests':
        schema = {
          scanType: 'scanType',
          fromBlock: 'uint',
          toBlock: 'uint',
        };
        break;

      case 'save-checkpoint':
        schema = {
          nextBlock: 'uint',
        };
        break;

      default:
        throw new TypeError('Invalid operation context.');
    }

    const context = project(schema, value, errorSummary);
    context.name = name;

    return context;
  }

  if (kind === 'resolution') {
    return projectResolution(value, errorSummary);
  }

  if (kind === 'id' && isUuidV4(value)) {
    return value;
  }

  if (kind === 'error') {
    return summarizeErrorForOutput(value, errorSummary);
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
  errorSummary: SummarizeErrorOptions | undefined,
): Record<string, unknown> {
  const record: Record<string, unknown> = Object.create(null);

  for (const [key, kind] of Object.entries(schema)) {
    if (kind === 'operation') {
      try {
        const operation = scalar(
          kind,
          own(input, key),
          errorSummary,
        );

        if (operation !== undefined) {
          record[key] = operation;
        }
      } catch {
        // Optional context must not suppress the original error diagnostic.
        record.operationOmitted = true;
      }

      continue;
    }

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
        const health = project(
          { consumer: 'address' },
          consumer,
          errorSummary,
        );

        if (status === 'healthy') {
          for (const field of [
            'latestBlock',
            'durableBlock',
            'durableNextBlock',
            'softNextBlock',
          ]) {
            health[field] = scalar(
              'uint',
              own(consumer, field),
              errorSummary,
            );
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

      record[outputKey] = scalar(
        kind,
        value,
        errorSummary,
      );
    }
  }

  return record;
}

function projectBindings(
  input: unknown,
  policy: SummarizeErrorOptions | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  const cycle = own(input, 'cycle');

  if (cycle !== undefined) {
    if (
      typeof cycle != 'number' ||
      !Number.isSafeInteger(cycle) ||
      cycle < 1
    ) {
      throw new TypeError('Invalid logging cycle.');
    }

    result.cycle = cycle;
  }

  for (const [key, kind] of [
    ['signer', 'address'],
    ['attemptId', 'id'],
    ['operation', 'operation'],
  ] as const) {
    const value = own(input, key);
    if (value !== undefined) {
      result[key] = scalar(kind, value, policy);
    }
  }

  return result;
}

function projectResolution(
  input: unknown,
  policy: SummarizeErrorOptions | undefined,
): Record<string, unknown> {
  const schema = {
    blockNumber: 'uint',
    blockHash: 'hash',
  } as const;

  const anchor = project(schema, own(input, 'anchor'), policy);
  const inclusion = project(schema, own(input, 'inclusion'), policy);

  const anchorNumber = BigInt(anchor.blockNumber as string);
  const inclusionNumber = BigInt(inclusion.blockNumber as string);

  if (
    inclusionNumber > anchorNumber ||
    (
      inclusionNumber === anchorNumber &&
      (inclusion.blockHash as string).toLowerCase() !==
        (anchor.blockHash as string).toLowerCase()
    )
  ) {
    throw new TypeError('Invalid resolution inclusion.');
  }

  const outcome = own(input, 'outcome');
  let details: Record<string, unknown>;

  switch (outcome) {
    case 'success':
    case 'reverted':
      details = project({
        transactionHash: 'hash',
      }, input, policy);
      break;

    case 'replaced':
      details = project({
        replacementTransactionHash: 'hash',
        nonceAtAnchor: 'uint',
      }, input, policy);
      break;

    default:
      throw new TypeError('Invalid resolution outcome.');
  }

  return {
    outcome,
    anchor,
    inclusion,
    ...details,
  };
}

function validateResolutionRecord(
  record: Record<string, unknown>,
): void {
  const evidence = record.resolution as Record<string, unknown>;
  const hash = (record.transactionHash as string).toLowerCase();

  if (evidence.outcome === 'replaced') {
    if (
      (evidence.replacementTransactionHash as string).toLowerCase() === hash ||
      BigInt(evidence.nonceAtAnchor as string) <= BigInt(record.nonce as string)
    ) {
      throw new TypeError('Invalid replacement evidence.');
    }
  } else if (
    (evidence.transactionHash as string).toLowerCase() !== hash
  ) {
    throw new TypeError('Mismatched receipt transaction hash.');
  }
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