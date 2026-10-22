import type {
  RpcMetricsSnapshot,
} from './rpc-metrics.js';

type LogicalSnapshotRow = RpcMetricsSnapshot['logical'][number];
type HttpSnapshotRow = RpcMetricsSnapshot['http'][number];

export interface RpcMetricsObservation {
  readonly snapshot: RpcMetricsSnapshot;
  readonly observedAtMs: number;
}

interface RpcUsageCounters {
  readonly started: number;
  readonly inFlight: number;
  readonly durationMs: number;
  readonly averageDurationMs: number | null;
}

export interface RpcLogicalUsageRow extends RpcUsageCounters {
  readonly client: LogicalSnapshotRow['client'];
  readonly method: LogicalSnapshotRow['method'];
  readonly completed: number;
  readonly failed: number;
}

export interface RpcHttpUsageRow extends RpcUsageCounters {
  readonly client: HttpSnapshotRow['client'];
  readonly responses: number;
  readonly transportFailures: number;
  readonly statuses: HttpSnapshotRow['statuses'];
}

export interface RpcUsageView {
  readonly logical: readonly RpcLogicalUsageRow[];
  readonly http: readonly RpcHttpUsageRow[];
}

export type RpcUsageInterval =
  | {
      readonly available: true;
      readonly elapsedMs: number;
      readonly logical: readonly RpcLogicalUsageRow[];
      readonly http: readonly RpcHttpUsageRow[];
    }
  | {
      readonly available: false;
      readonly reason:
        | 'no-baseline'
        | 'collector-changed'
        | 'invalid-elapsed-time'
        | 'counters-regressed';
    };

export interface RpcUsageReport {
  readonly collectorId: string;
  readonly startedAt: string;
  readonly cumulative: RpcUsageView;
  readonly interval: RpcUsageInterval;
}

function averageDuration(
  durationMs: number,
  completed: number,
): number | null {
  if (completed === 0) {
    return null;
  }

  return durationMs / completed;
}

function logicalUsageRow(
  row: LogicalSnapshotRow,
): RpcLogicalUsageRow {
  const completed = row.succeeded + row.failed;

  return Object.freeze({
    client: row.client,
    method: row.method,
    started: row.started,
    completed,
    failed: row.failed,
    inFlight: row.inFlight,
    durationMs: row.durationMs,
    averageDurationMs: averageDuration(
      row.durationMs,
      completed,
    ),
  });
}

function httpUsageRow(
  row: HttpSnapshotRow,
): RpcHttpUsageRow {
  const completed = row.succeeded + row.failed;

  return Object.freeze({
    client: row.client,
    started: row.started,
    responses: row.succeeded,
    transportFailures: row.failed,
    inFlight: row.inFlight,
    statuses: Object.freeze({
      '2xx': row.statuses['2xx'],
      '3xx': row.statuses['3xx'],
      '4xx': row.statuses['4xx'],
      '5xx': row.statuses['5xx'],
    }),
    durationMs: row.durationMs,
    averageDurationMs: averageDuration(
      row.durationMs,
      completed,
    ),
  });
}

function compareLabels(
  left: string,
  right: string
): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function cumulativeUsage(
  snapshot: RpcMetricsSnapshot,
): RpcUsageView {
  const logical = snapshot.logical.map(logicalUsageRow);
  const http = snapshot.http.map(httpUsageRow);

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
    logical: Object.freeze(logical),
    http: Object.freeze(http),
  });
}

function logicalRowKey(row: LogicalSnapshotRow): string {
  return row.client + ':' + row.method;
}

function countersRegressed(
  current: LogicalSnapshotRow | HttpSnapshotRow,
  previous: LogicalSnapshotRow | HttpSnapshotRow,
): boolean {
  return current.started < previous.started
    || current.succeeded < previous.succeeded
    || current.failed < previous.failed
    || current.durationMs < previous.durationMs;
}

function snapshotCountersRegressed(
  current: RpcMetricsSnapshot,
  previous: RpcMetricsSnapshot,
): boolean {
  const currentLogical = new Map(
    current.logical.map((row) => [logicalRowKey(row), row]),
  );

  for (const earlier of previous.logical) {
    const row = currentLogical.get(logicalRowKey(earlier));

    if (row === undefined || countersRegressed(row, earlier)) {
      return true;
    }
  }

  const currentHttp = new Map(
    current.http.map((row) => [row.client, row]),
  );

  for (const earlier of previous.http) {
    const row = currentHttp.get(earlier.client);

    if (row === undefined || countersRegressed(row, earlier)) {
      return true;
    }

    if (
      row.statuses['2xx'] < earlier.statuses['2xx']
      || row.statuses['3xx'] < earlier.statuses['3xx']
      || row.statuses['4xx'] < earlier.statuses['4xx']
      || row.statuses['5xx'] < earlier.statuses['5xx']
    ) {
      return true;
    }
  }

  return false;
}



function intervalUsage(
  current: RpcMetricsSnapshot,
  previous: RpcMetricsSnapshot,
): RpcUsageView {
  const previousLogical = new Map(
    previous.logical.map((row) => [logicalRowKey(row), row]),
  );

  const previousHttp = new Map(
    previous.http.map((row) => [row.client, row]),
  );

  const logical = current.logical.map((row): LogicalSnapshotRow => {
    const earlier = previousLogical.get(logicalRowKey(row));

    return {
      client: row.client,
      method: row.method,
      started: row.started - (earlier?.started ?? 0),
      succeeded: row.succeeded - (earlier?.succeeded ?? 0),
      failed: row.failed - (earlier?.failed ?? 0),
      inFlight: row.inFlight,
      durationMs: row.durationMs - (earlier?.durationMs ?? 0),
    };
  });

  const http = current.http.map((row): HttpSnapshotRow => {
    const earlier = previousHttp.get(row.client);

    return {
      client: row.client,
      started: row.started - (earlier?.started ?? 0),
      succeeded: row.succeeded - (earlier?.succeeded ?? 0),
      failed: row.failed - (earlier?.failed ?? 0),
      inFlight: row.inFlight,
      durationMs: row.durationMs - (earlier?.durationMs ?? 0),
      statuses: {
        '2xx': row.statuses['2xx'] - (earlier?.statuses['2xx'] ?? 0),
        '3xx': row.statuses['3xx'] - (earlier?.statuses['3xx'] ?? 0),
        '4xx': row.statuses['4xx'] - (earlier?.statuses['4xx'] ?? 0),
        '5xx': row.statuses['5xx'] - (earlier?.statuses['5xx'] ?? 0),
      },
    };
  });

  return cumulativeUsage({
    collectorId: current.collectorId,
    startedAt: current.startedAt,
    logical,
    http,
  });
}

function usageInterval(
  current: RpcMetricsObservation,
  previous?: RpcMetricsObservation,
): RpcUsageInterval {
  if (previous === undefined) {
    return Object.freeze({
      available: false,
      reason: 'no-baseline',
    });
  }

  if (current.snapshot.collectorId !== previous.snapshot.collectorId) {
    return Object.freeze({
      available: false,
      reason: 'collector-changed',
    });
  }

  const elapsedMs = current.observedAtMs - previous.observedAtMs;

  if (
    !Number.isFinite(current.observedAtMs) ||
    !Number.isFinite(previous.observedAtMs) ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) {
    return Object.freeze({
      available: false,
      reason: 'invalid-elapsed-time',
    });
  }

  if (snapshotCountersRegressed(current.snapshot, previous.snapshot)) {
    return Object.freeze({
      available: false,
      reason: 'counters-regressed',
    });
  }

  const usage = intervalUsage(current.snapshot, previous.snapshot);

  return Object.freeze({
    available: true,
    elapsedMs,
    logical: usage.logical,
    http: usage.http,
  });
}

export function createRpcUsageReport(
  current: RpcMetricsObservation,
  previous?: RpcMetricsObservation,
): RpcUsageReport {
  return Object.freeze({
    collectorId: current.snapshot.collectorId,
    startedAt: current.snapshot.startedAt,
    cumulative: cumulativeUsage(current.snapshot),
    interval: usageInterval(current, previous),
  });
}