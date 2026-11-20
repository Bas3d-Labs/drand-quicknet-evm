import {
  AsyncLocalStorage,
} from 'node:async_hooks';

import { performance } from 'node:perf_hooks';

import {
  randomUUID,
} from 'node:crypto';

export type RpcClientRole = 'public' | 'wallet';

// Unknown methods share one bucket. Arbitrary strings never become labels.
const METHODS = [
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_sendRawTransaction',
] as const;

export const RPC_METHOD_LABELS = Object.freeze([
  ...METHODS,
  'other',
] as const);

export type RpcMethod = typeof RPC_METHOD_LABELS[number];

export type StatusClass =
  | '2xx'
  | '3xx'
  | '4xx'
  | '5xx';

/** Values only: no request arguments, responses or exceptions cross this boundary. */
export interface RpcTraceEvent {
  readonly collectorId: string;
  readonly layer: 'logical' | 'http';
  readonly phase: 'start' | 'end';
  readonly callId: number;
  readonly parentLogicalId: number | null;
  readonly client: RpcClientRole;
  readonly method: RpcMethod | null;
  readonly atMs: number;
  readonly durationMs: number;
  readonly outcome: 'pending' | 'success' | 'failure';
  readonly status: StatusClass | null;
}

export interface RpcMetricsOptions {
  readonly onTrace?: ((event: RpcTraceEvent) => void) | undefined;
}

interface Counters {
  started: number;
  succeeded: number;
  failed: number;
  inFlight: number;
  durationMs: number;
}

interface LogicalCounters extends Counters {
  client: RpcClientRole;
  method: RpcMethod;
}

interface HttpCounters extends Counters {
  client: RpcClientRole;

  /**
   * Counts classified responses only.
   * Bucket totals may be lower than succeeded.
   */
  statuses: Record<StatusClass, number>;
}

/**
 * Cumulative measurements since this collector was created.
 * Compare counter deltas only between snapshots with the same collectorId.
 * startedAt is the collector's creation time, not the snapshot time.
 * 
 * HTTP succeeded means a response was returned, including 4xx/5xx responses.
 * HTTP duration ends at response headers or fetch rejection, not 
 * body completion.
 */
export interface RpcMetricsSnapshot {
  readonly collectorId: string;
  readonly startedAt: string;
  readonly logical: readonly Readonly<LogicalCounters>[];
  readonly http: readonly (
    Readonly<Omit<HttpCounters, 'statuses'>> & {
      readonly statuses: Readonly<HttpCounters['statuses']>;
    }
  )[];
}

export interface RpcMetrics {
  snapshot(): RpcMetricsSnapshot;

  logical<T>(
    client: RpcClientRole,
    method: string,
    action: () => Promise<T>,
  ): Promise<T>;

  http(
    client: RpcClientRole,
    action: () => Promise<Response>,
  ): Promise<Response>;
}

function counters(): Counters {
  return {
    started: 0,
    succeeded: 0,
    failed: 0,
    inFlight: 0,
    durationMs: 0,
  };
}

function methodLabel(method: string): RpcMethod {
  for (const known of METHODS) {
    if (method === known) {
      return known;
    }
  }

  return 'other';
}

// Unexpected statuses remain unclassified. Measurement must not reject them.
function statusClass(status: number): StatusClass | undefined {
  if (!Number.isInteger(status)) {
    return undefined;
  }

  if (status >= 200 && status < 300) {
    return '2xx';
  }

  if (status >= 300 && status < 400) {
    return '3xx';
  }

  if (status >= 400 && status < 500) {
    return '4xx';
  }

  if (status >= 500 && status < 600) {
    return '5xx';
  }

  return undefined;
}

export function createRpcMetrics(
  options: RpcMetricsOptions = {},
): RpcMetrics {
  const collectorId = randomUUID();
  const startedAt = new Date().toISOString();

  const logical = new Map<string, LogicalCounters>();

  const http = new Map<RpcClientRole, HttpCounters>();

  const onTrace = options.onTrace;

  const context = new AsyncLocalStorage<number>();

  let nextCallId = 0;

  function notify(event: RpcTraceEvent): void {
    try {
      onTrace?.(Object.freeze(event));
    } catch {
      // Optional diagnostics cannot replace the RPC result or rejection.
    }
  }

  async function measure<T>(
    row: Counters,
    action: () => Promise<T>,
    onSuccess?: (result: T) => StatusClass | undefined,
    trace?: Omit<
      RpcTraceEvent,
      'phase' | 'atMs' | 'durationMs' | 'outcome' | 'status'
    >,
  ): Promise<T> {
    const startedAt = performance.now();

    row.started += 1;

    row.inFlight += 1;

    let outcome: RpcTraceEvent['outcome'] = 'failure';

    let status: StatusClass | null = null;

    if (trace !== undefined) {
      notify({
        ...trace,
        phase: 'start',
        atMs: startedAt,
        durationMs: 0,
        outcome: 'pending',
        status: null,
      });
    }

    try {
      const result = await action();

      row.succeeded += 1;

      outcome = 'success';

      if (onSuccess !== undefined) {
        try {
          status = onSuccess(result) ?? null;
        } catch {
          // Status inspection must not alter the request outcome.
        }
      }

      return result;
    } catch (error) {
      row.failed += 1;

      throw error;
    } finally {
      row.inFlight -= 1;

      const endedAt = performance.now();

      const durationMs = Math.max(0, endedAt - startedAt);

      row.durationMs += durationMs;

      if (trace !== undefined) {
        notify({
          ...trace,
          phase: 'end',
          atMs: endedAt,
          durationMs,
          outcome,
          status,
        });
      }
    }
  }

  return Object.freeze({
    snapshot(): RpcMetricsSnapshot {
      return {
        collectorId,
        startedAt,
        logical: [...logical.values()].map((row) => ({
          ...row,
        })),
        http: [...http.values()].map((row) => ({
          ...row,
          statuses: {
            ...row.statuses,
          },
        })),
      };
    },

    logical<T>(
      client: RpcClientRole,
      method: string,
      action: () => Promise<T>,
    ): Promise<T> {
      const label = methodLabel(method);
      const key = client + ':' + label;

      let row = logical.get(key);

      if (row === undefined) {
        row = {
          ...counters(),
          client,
          method: label,
        };

        logical.set(key, row);
      }

      if (onTrace === undefined) {
        return measure(row, action);
      }

      const callId = ++nextCallId;

      const trace = {
        collectorId,
        layer: 'logical' as const,
        callId,
        parentLogicalId: context.getStore() ?? null,
        client,
        method: label,
      };

      const current = row;

      return context.run(callId, () => measure(current, action, undefined, trace));
    },

    http(
      client: RpcClientRole,
      action: () => Promise<Response>,
    ): Promise<Response> {
      let row = http.get(client);

      if (row === undefined) {
        row = {
          ...counters(),
          client,
          statuses: {
            '2xx': 0,
            '3xx': 0,
            '4xx': 0,
            '5xx': 0,
          },
        };

        http.set(client, row);
      }

      const current = row;

      let trace: Omit<
        RpcTraceEvent,
        'phase' | 'atMs' | 'durationMs' | 'outcome' | 'status'
      > | undefined;

      if (onTrace !== undefined) {
        trace = {
          collectorId,
          layer: 'http',
          callId: ++nextCallId,
          // Async ancestry is not proof of membership in a transport batch.
          parentLogicalId: null,
          client,
          method: null,
        };
      }

      return measure(current, action, (response) => {
        const category = statusClass(response.status);

        if (category !== undefined) {
          current.statuses[category] += 1;
        }

        return category;
      }, trace);
    },
  });
}
