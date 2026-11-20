import {
  isDeepStrictEqual,
} from 'node:util';

import {
  isFixedHex,
} from '../../shared/hex.js';

import {
  isUuidV4,
} from '../../shared/uuid.js';

import {
  readDaemonStatusSnapshot,
} from '../../state/daemon-status-snapshot.js';

import type {
  JournalIdentity,
} from '../../state/transaction-journal.js';

import {
  RPC_METHOD_LABELS,
  type RpcTraceEvent,
} from '../rpc/rpc-metrics.js';

const INVALID = 'Invalid diagnostic trace event.';

/** Copy bounded plain data without invoking getters or toJSON. */
export function copyTraceData(
  input: unknown,
): unknown {
  let remaining = 16_384;

  let characters = 0;

  function copy(
    value: unknown,
    depth: number,
  ): unknown {
    remaining -= 1;

    if (remaining < 0 || depth > 20) {
      throw new TypeError(INVALID);
    }

    if (value === null || typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      characters += value.length;

      if (characters > 131_072) {
        throw new TypeError(INVALID);
      }

      return value;
    }

    if (typeof value !== 'object' || value === null) {
      throw new TypeError(INVALID);
    }

    if (Array.isArray(value)) {
      if (value.length > 4096) {
        throw new TypeError(INVALID);
      }

      const result: unknown[] = [];

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );

        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(INVALID);
        }

        result.push(copy(descriptor.value, depth + 1));
      }

      return result;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(INVALID);
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 128) {
      throw new TypeError(INVALID);
    }

    const result: Record<string, unknown> = {};

    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'toJSON') {
        throw new TypeError(INVALID);
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;

      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new TypeError(INVALID);
      }
      result[key] = copy(descriptor.value, depth + 1);
    }

    return result;
  }

  return copy(input, 0);
}

export function projectRpcTrace(
  input: RpcTraceEvent,
): RpcTraceEvent {
  const value = copyTraceData(input) as RpcTraceEvent;

  if (
    !isUuidV4(value.collectorId) ||
    !['logical', 'http'].includes(value.layer) ||
    !['start', 'end'].includes(value.phase) ||
    !['public', 'wallet'].includes(value.client) ||
    !Number.isSafeInteger(value.callId) ||
    value.callId <= 0 ||
    (value.parentLogicalId !== null &&
      (!Number.isSafeInteger(value.parentLogicalId) ||
        value.parentLogicalId <= 0)) ||
    !Number.isFinite(value.atMs) ||
    value.atMs < 0 ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !['pending', 'success', 'failure'].includes(value.outcome) ||
    (value.status !== null &&
      !['2xx', '3xx', '4xx', '5xx'].includes(value.status))
  ) {
    throw new TypeError(INVALID);
  }

  if (
    (value.layer === 'http' && value.method !== null) ||
    (value.layer === 'logical' &&
      !RPC_METHOD_LABELS.some((method) => method === value.method)) ||
    (value.phase === 'start' &&
      (value.outcome !== 'pending' ||
        value.durationMs !== 0 ||
        value.status !== null)) ||
    (value.phase === 'end' && value.outcome === 'pending') ||
    (value.layer === 'logical' && value.status !== null) ||
    (value.outcome === 'failure' && value.status !== null)
  ) {
    throw new TypeError(INVALID);
  }

  return {
    collectorId: value.collectorId,
    layer: value.layer,
    phase: value.phase,
    callId: value.callId,
    parentLogicalId: value.parentLogicalId,
    client: value.client,
    method: value.method,
    atMs: value.atMs,
    durationMs: value.durationMs,
    outcome: value.outcome,
    status: value.status,
  };
}

/** No arbitrary adapter work IDs enter an otherwise unchanged public snapshot. */
export function projectTraceStatus(input: unknown, identity: JournalIdentity) {
  const copy = copyTraceData(input);

  const projected = readDaemonStatusSnapshot(copy, identity);

  if (!isDeepStrictEqual(copy, projected)) {
    throw new TypeError(INVALID);
  }

  for (const attempt of projected.attempts) {
    const parts = attempt.workId.split(':');

    if (
      parts.length !== 5 ||
      parts[0] !== 'quicknet-round' ||
      parts[1] !== 'v1' ||
      parts[2] !== String(identity.chainId) ||
      !isFixedHex(parts[3], 20)
    ) {
      throw new TypeError(INVALID);
    }

    const round = parts[4]!;

    if (round.length === 0 || round.length > 20) {
      throw new TypeError(INVALID);
    }

    const number = BigInt(round);

    if (number <= 0n || number >= 1n << 64n || String(number) !== round) {
      throw new TypeError(INVALID);
    }
  }

  return projected;
}
