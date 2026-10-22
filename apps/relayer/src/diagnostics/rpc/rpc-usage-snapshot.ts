import {
  isNonNegativeSafeInteger,
} from '../../shared/integer.js';

import {
  isUuidV4,
} from '../../shared/uuid.js';

import {
  RPC_METHOD_LABELS,
  type RpcClientRole,
} from './rpc-metrics.js';

import type {
  RpcMetricsSnapshot,
} from './rpc-metrics.js';

import type {
  RpcHttpUsageRow,
  RpcLogicalUsageRow,
} from './rpc-usage-report.js';

export type RpcLogicalUsageSnapshotRow = Omit<
  RpcLogicalUsageRow,
  'averageDurationMs'
>;

export type RpcHttpUsageSnapshotRow = Omit<
  RpcHttpUsageRow,
  'averageDurationMs'
>;

const INVALID = 'Invalid RPC usage snapshot.';

function readObject(
  input: unknown,
): Record<string, unknown> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new TypeError(INVALID);
  }

  return input as Record<string, unknown>;
}

function readCount(
  input: unknown,
): number {
  if (!isNonNegativeSafeInteger(input)) {
    throw new TypeError(INVALID);
  }

  return input;
}

function readDuration(
  input: unknown,
): number {
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    input < 0
  ) {
    throw new TypeError(INVALID);
  }

  return input;
}

function readTimestamp(
  input: unknown,
): string {
  if (typeof input !== 'string') {
    throw new TypeError(INVALID);
  }

  const milliseconds = Date.parse(input);

  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== input
  ) {
    throw new TypeError(INVALID);
  }

  return input;
}

function readClient(
  input: unknown,
): RpcClientRole {
  if (input === 'public' || input === 'wallet') {
    return input;
  }

  throw new TypeError(INVALID);
}

function readMethod(
  input: unknown,
): RpcLogicalUsageSnapshotRow['method'] {
  for (const method of RPC_METHOD_LABELS) {
    if (input === method) {
      return method;
    }
  }

  throw new TypeError(INVALID);
}

function readLogicalRow(
  input: unknown,
): RpcLogicalUsageSnapshotRow {
  const row = readObject(input);

  const client = readClient(row.client);
  const method = readMethod(row.method);
  const started = readCount(row.started);
  const completed = readCount(row.completed);
  const failed = readCount(row.failed);
  const inFlight = readCount(row.inFlight);
  const durationMs = readDuration(row.durationMs);

  if (
    completed > started ||
    failed > completed ||
    inFlight !== started - completed ||
    (completed === 0 && durationMs !== 0)
  ) {
    throw new TypeError(INVALID);
  }

  return Object.freeze({
    client,
    method,
    started,
    completed,
    failed,
    inFlight,
    durationMs,
  });
}

function readHttpRow(
  input: unknown,
): RpcHttpUsageSnapshotRow {
  const row = readObject(input);
  const rawStatuses = readObject(row.statuses);

  const client = readClient(row.client);
  const started = readCount(row.started);
  const responses = readCount(row.responses);
  const transportFailures = readCount(row.transportFailures);
  const inFlight = readCount(row.inFlight);
  const durationMs = readDuration(row.durationMs);

  const statuses = Object.freeze({
    '2xx': readCount(rawStatuses['2xx']),
    '3xx': readCount(rawStatuses['3xx']),
    '4xx': readCount(rawStatuses['4xx']),
    '5xx': readCount(rawStatuses['5xx']),
  });

  if (
    responses > started ||
    transportFailures > started - responses
  ) {
    throw new TypeError(INVALID);
  }

  const completed = responses + transportFailures;

  if (
    inFlight !== started - completed ||
    (completed === 0 && durationMs !== 0)
  ) {
    throw new TypeError(INVALID);
  }

  let unclassifiedResponses = responses;

  for (const count of Object.values(statuses)) {
    if (count > unclassifiedResponses) {
      throw new TypeError(INVALID);
    }

    unclassifiedResponses -= count;
  }

  return Object.freeze({
    client,
    started,
    responses,
    transportFailures,
    inFlight,
    statuses,
    durationMs,
  });
}

function compareLabels(
  left: string,
  right: string,
): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

/**
 * Projects collector measurements into validated persisted cumulative usage.
 */
export function createRpcUsageSnapshot(
  snapshot: RpcMetricsSnapshot,
  observedAt: string,
): RpcUsageSnapshot {
  return readRpcUsageSnapshot({
    collectorId: snapshot.collectorId,
    startedAt: snapshot.startedAt,
    observedAt,
    logical: snapshot.logical.map((row) => ({
      client: row.client,
      method: row.method,
      started: row.started,
      completed: row.succeeded + row.failed,
      failed: row.failed,
      inFlight: row.inFlight,
      durationMs: row.durationMs,
    })),
    http: snapshot.http.map((row) => ({
      client: row.client,
      started: row.started,
      responses: row.succeeded,
      transportFailures: row.failed,
      inFlight: row.inFlight,
      statuses: {
        '2xx': row.statuses['2xx'],
        '3xx': row.statuses['3xx'],
        '4xx': row.statuses['4xx'],
        '5xx': row.statuses['5xx'],
      },
      durationMs: row.durationMs,
    })),
  });
}

/**
 * Validates and projects persisted cumulative RPC usage.
 */
export function readRpcUsageSnapshot(
  input: unknown,
): RpcUsageSnapshot {
  const root = readObject(input);

  if (!isUuidV4(root.collectorId)) {
    throw new TypeError(INVALID);
  }

  const collectorId = root.collectorId;
  const startedAt = readTimestamp(root.startedAt);
  const observedAt = readTimestamp(root.observedAt);

  if (
    !Array.isArray(root.logical) ||
    root.logical.length > RPC_METHOD_LABELS.length * 2 ||
    !Array.isArray(root.http) ||
    root.http.length > 2
  ) {
    throw new TypeError(INVALID);
  }

  const logicalKeys = new Set<string>();
  const logical = root.logical.map((inputRow) => {
    const row = readLogicalRow(inputRow);
    const key = row.client + ':' + row.method;

    if (logicalKeys.has(key)) {
      throw new TypeError(INVALID);
    }

    logicalKeys.add(key);
    return row;
  });

  const httpClients = new Set<RpcClientRole>();
  const http = root.http.map((inputRow) => {
    const row = readHttpRow(inputRow);

    if (httpClients.has(row.client)) {
      throw new TypeError(INVALID);
    }

    httpClients.add(row.client);
    return row;
  });

  logical.sort((left, right) => {
    const clientOrder = compareLabels(left.client, right.client);

    if (clientOrder !== 0) {
      return clientOrder;
    }

    return compareLabels(left.method, right.method);
  });

  http.sort((left, right) => {
    return compareLabels(left.client, right.client);
  });

  return Object.freeze({
    collectorId,
    startedAt,
    observedAt,
    logical: Object.freeze(logical),
    http: Object.freeze(http),
  });
}

/**
 * Persisted cumulative RPC usage.
 */
export interface RpcUsageSnapshot {
  readonly collectorId: string;
  readonly startedAt: string;

  /** Wall-clock measurement time, captured with the collector snapshot. */
  readonly observedAt: string;

  readonly logical: readonly RpcLogicalUsageSnapshotRow[];
  readonly http: readonly RpcHttpUsageSnapshotRow[];
}