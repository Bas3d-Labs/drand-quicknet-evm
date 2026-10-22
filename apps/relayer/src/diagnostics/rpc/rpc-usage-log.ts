import {
  isUuidV4,
} from '../../shared/uuid.js';

import {
  projectRpcUsageLogView,
} from './rpc-usage-log-view.js';

import type {
  RpcUsageInterval,
  RpcUsageReport,
} from './rpc-usage-report.js';

/**
 * Total RPC usage log budget, including the logger envelope.
 */
export const MAX_RPC_USAGE_LOG_BYTES = 24 * 1_024;

/**
 * Reserved for logger metadata, message, and the trailing newline.
 */
export const RPC_USAGE_LOG_ENVELOPE_BYTES = 1_024;

/**
 * Maximum projected event size before the logger adds its envelope.
 */
export const MAX_RPC_USAGE_LOG_RECORD_BYTES =
  MAX_RPC_USAGE_LOG_BYTES - RPC_USAGE_LOG_ENVELOPE_BYTES;

export interface RpcUsageLogContext {
  readonly observedAt: string;
  readonly report: RpcUsageReport;
}

const INVALID = 'Invalid RPC usage log context.';

function own(input: unknown, key: string): unknown {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new TypeError(INVALID);
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);

  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw new TypeError(INVALID);
  }

  return descriptor.value;
}

function timestamp(input: unknown): string {
  if (typeof input !== 'string' || input.length > 27) {
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

function projectInterval(
  input: unknown,
): RpcUsageInterval {
  const available = own(input, 'available');
  if (available === false) {
    const reason = own(input, 'reason');

    switch (reason) {
      case 'no-baseline':
      case 'collector-changed':
      case 'invalid-elapsed-time':
      case 'counters-regressed':
        return Object.freeze({
          available: false,
          reason,
        });

      default:
        throw new TypeError(INVALID);
    }
  }

  if (available !== true) {
    throw new TypeError(INVALID);
  }

  const elapsedMs = own(input, 'elapsedMs');

  if (
    typeof elapsedMs !== 'number' ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) {
    throw new TypeError(INVALID);
  }

  const view = projectRpcUsageLogView(input, 'interval');

  return Object.freeze({
    available: true,
    elapsedMs,
    logical: view.logical,
    http: view.http,
  });
}

/**
 * Projects the declared RPC event fields.
 */
export function projectRpcUsageLogContext(
  input: unknown,
): RpcUsageLogContext {
  const observedAt = timestamp(own(input, 'observedAt'));
  const rawReport = own(input, 'report');
  const collectorId = own(rawReport, 'collectorId');

  if (!isUuidV4(collectorId)) {
    throw new TypeError(INVALID);
  }

  const startedAt = timestamp(own(rawReport, 'startedAt'));
  const cumulative = projectRpcUsageLogView(
    own(rawReport, 'cumulative'),
    'cumulative',
  );
  const interval = projectInterval(own(rawReport, 'interval'));

  if (interval.available) {
    if (
      interval.logical.length !== cumulative.logical.length ||
      interval.http.length !== cumulative.http.length
    ) {
      throw new TypeError(INVALID);
    }

    for (let index = 0; index < cumulative.logical.length; index += 1) {
      const current = cumulative.logical[index]!;
      const delta = interval.logical[index]!;

      if (
        delta.client !== current.client ||
        delta.method !== current.method ||
        delta.inFlight !== current.inFlight
      ) {
        throw new TypeError(INVALID);
      }
    }

    for (let index = 0; index < cumulative.http.length; index += 1) {
      const current = cumulative.http[index]!;
      const delta = interval.http[index]!;

      if (
        delta.client !== current.client ||
        delta.inFlight !== current.inFlight
      ) {
        throw new TypeError(INVALID);
      }
    }
  }

  return Object.freeze({
    observedAt,
    report: Object.freeze({
      collectorId,
      startedAt,
      cumulative,
      interval,
    }),
  });
}