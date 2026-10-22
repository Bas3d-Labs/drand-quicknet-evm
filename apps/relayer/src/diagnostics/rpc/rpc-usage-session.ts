import {
  performance,
} from 'node:perf_hooks';

import type {
  RpcMetricsSnapshot,
} from './rpc-metrics.js';

import type {
  RpcUsageLogContext,
} from './rpc-usage-log.js';

import {
  createRpcUsageReport,
  type RpcMetricsObservation,
} from './rpc-usage-report.js';

export const RPC_USAGE_INTERVAL_MS = 60_000;

export interface RpcUsageSessionOptions {
  readonly readSnapshot: () => RpcMetricsSnapshot;
  readonly emit: (context: RpcUsageLogContext) => void;
  readonly onFailure: (error: unknown) => void;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
}

export interface RpcUsageSession {
  /** Reports when the interval threshold is reached at a cycle boundary. */
  onCycle(): void;

  /** Attempts one final report, regardless of the interval threshold. */
  finish(): void;
}

export function createRpcUsageSession(
  options: RpcUsageSessionOptions,
): RpcUsageSession {
  const readSnapshot = options.readSnapshot;
  const emit = options.emit;
  const onFailure = options.onFailure;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;

  let previous: RpcMetricsObservation | undefined;
  let lastAttemptAtMs: number | undefined;
  let finished = false;

  function reportFailure(
    error: unknown,
  ): void {
    try {
      onFailure(error);
    } catch {
      // Diagnostic delivery must not replace daemon or shutdown outcomes.
    }
  }

  function monotonicTime(): number {
    const value = monotonicNow();

    if (!Number.isFinite(value)) {
      throw new TypeError('Invalid RPC usage monotonic observation time.');
    }

    return value;
  }

  function wallTimestamp(
    milliseconds: number,
  ): string {
    if (
      !Number.isSafeInteger(milliseconds) ||
      !Number.isFinite(new Date(milliseconds).getTime())
    ) {
      throw new TypeError('Invalid RPC usage wall-clock observation time.');
    }

    return new Date(milliseconds).toISOString();
  }

  function report(
    observedAtMs: number,
  ): void {
    const snapshot = readSnapshot();
    const observedAt = wallTimestamp(wallNow());

    const current: RpcMetricsObservation = {
      snapshot,
      observedAtMs,
    };

    const context: RpcUsageLogContext = Object.freeze({
      observedAt,
      report: createRpcUsageReport(current, previous),
    });

    previous = current;
    emit(context);
  }

  function onCycle(): void {
    if (finished) {
      return;
    }

    try {
      const now = monotonicTime();

      if (lastAttemptAtMs === undefined) {
        lastAttemptAtMs = now;
        return;
      }

      const elapsedMs = now - lastAttemptAtMs;

      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        // Reestablish scheduling after an invalid clock observation.
        lastAttemptAtMs = now;
        throw new TypeError('Invalid RPC usage scheduling elapsed time.');
      }

      if (elapsedMs < RPC_USAGE_INTERVAL_MS) {
        return;
      }

      // A failed capture is retried at the next reporting interval.
      lastAttemptAtMs = now;
      report(now);
    } catch (error) {
      reportFailure(error);
    }
  }

  function finish(): void {
    if (finished) {
      return;
    }

    finished = true;

    try {
      report(monotonicTime());
    } catch (error) {
      reportFailure(error);
    }
  }

  try {
    lastAttemptAtMs = monotonicTime();
  } catch (error) {
    reportFailure(error);
  }

  return Object.freeze({
    onCycle,
    finish,
  });
}