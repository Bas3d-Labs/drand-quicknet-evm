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

type RpcMethod = typeof METHODS[number] | 'other';

type StatusClass =
  | '2xx'
  | '3xx'
  | '4xx'
  | '5xx';

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
  logical: LogicalCounters[];
  http: HttpCounters[];
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

// Unexpected statuses remain unclassified. Masurement must not reject them.
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

export function createRpcMetrics(): RpcMetrics {
  const collectorId = randomUUID();
  const startedAt = new Date().toISOString();
  const logical = new Map<string, LogicalCounters>();
  const http = new Map<RpcClientRole, HttpCounters>();

  async function measure<T>(
    row: Counters,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();

    row.started += 1;
    row.inFlight += 1;

    try {
      const result = await action();

      row.succeeded += 1;

      return result;
    } catch (error) {
      row.failed += 1;
      throw error;
    } finally {
      row.inFlight -= 1;
      row.durationMs += Math.max(0, performance.now() - startedAt);
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

      return measure(row, action);
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

      return measure(current, async () => {
        const response = await action();
        const category = statusClass(response.status);

        if (category !== undefined) {
          row.statuses[category] += 1;
        }

        return response;
      });
    },
  });
}