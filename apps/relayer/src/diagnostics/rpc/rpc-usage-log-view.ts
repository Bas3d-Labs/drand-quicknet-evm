import {
  isNonNegativeSafeInteger,
} from '../../shared/integer.js';

import {
  RPC_METHOD_LABELS,
  type RpcClientRole,
} from './rpc-metrics.js';

import type {
  RpcHttpUsageRow,
  RpcLogicalUsageRow,
  RpcUsageView,
} from './rpc-usage-report.js';

const INVALID = 'Invalid RPC usage log view.';

type ViewKind = 'cumulative' | 'interval';

function own(
  input: unknown,
  key: string,
): unknown {
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

function rows(
  input: unknown,
  maximum: number,
): unknown[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum
  ) {
    throw new TypeError(INVALID);
  }

  const result: unknown[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      input,
      String(index),
    );

    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(INVALID);
    }

    result.push(descriptor.value);
  }

  return result;
}

function count(input: unknown): number {
  if (!isNonNegativeSafeInteger(input)) {
    throw new TypeError(INVALID);
  }

  return input;
}

function duration(
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

function client(
  input: unknown,
): RpcClientRole {
  if (input === 'public' || input === 'wallet') {
    return input;
  }

  throw new TypeError(INVALID);
}

function method(
  input: unknown,
): RpcLogicalUsageRow['method'] {
  for (const label of RPC_METHOD_LABELS) {
    if (input === label) {
      return label;
    }
  }

  throw new TypeError(INVALID);
}

function average(
  input: unknown,
  durationMs: number,
  completed: number,
): number | null {
  if (completed === 0) {
    if (durationMs !== 0 || input !== null) {
      throw new TypeError(INVALID);
    }

    return null;
  }

  const expected = durationMs / completed;

  if (input !== expected) {
    throw new TypeError(INVALID);
  }

  return expected;
}

function logicalRow(
  input: unknown,
  kind: ViewKind,
): RpcLogicalUsageRow {
  const role = client(own(input, 'client'));
  const label = method(own(input, 'method'));
  const started = count(own(input, 'started'));
  const completed = count(own(input, 'completed'));
  const failed = count(own(input, 'failed'));
  const inFlight = count(own(input, 'inFlight'));
  const durationMs = duration(own(input, 'durationMs'));

  if (failed > completed) {
    throw new TypeError(INVALID);
  }

  if (
    kind === 'cumulative' &&
    (
      completed > started ||
      inFlight !== started - completed
    )
  ) {
    throw new TypeError(INVALID);
  }

  const averageDurationMs = average(
    own(input, 'averageDurationMs'),
    durationMs,
    completed,
  );

  return Object.freeze({
    client: role,
    method: label,
    started,
    completed,
    failed,
    inFlight,
    durationMs,
    averageDurationMs,
  });
}

function httpRow(
  input: unknown,
  kind: ViewKind,
): RpcHttpUsageRow {
  const role = client(own(input, 'client'));
  const started = count(own(input, 'started'));
  const responses = count(own(input, 'responses'));
  const transportFailures = count(own(input, 'transportFailures'));
  const inFlight = count(own(input, 'inFlight'));
  const durationMs = duration(own(input, 'durationMs'));

  if (transportFailures > Number.MAX_SAFE_INTEGER - responses) {
    throw new TypeError(INVALID);
  }

  const completed = responses + transportFailures;

  if (
    kind === 'cumulative' &&
    (
      completed > started ||
      inFlight !== started - completed
    )
  ) {
    throw new TypeError(INVALID);
  }

  const rawStatuses = own(input, 'statuses');
  const statuses = Object.freeze({
    '2xx': count(own(rawStatuses, '2xx')),
    '3xx': count(own(rawStatuses, '3xx')),
    '4xx': count(own(rawStatuses, '4xx')),
    '5xx': count(own(rawStatuses, '5xx')),
  });

  let remaining = responses;

  for (const value of Object.values(statuses)) {
    if (value > remaining) {
      throw new TypeError(INVALID);
    }

    remaining -= value;
  }

  const averageDurationMs = average(
    own(input, 'averageDurationMs'),
    durationMs,
    completed,
  );

  return Object.freeze({
    client: role,
    started,
    responses,
    transportFailures,
    inFlight,
    statuses,
    durationMs,
    averageDurationMs,
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

/**
 * Projects bounded report rows through the logging boundary.
 */
export function projectRpcUsageLogView(
  input: unknown,
  kind: ViewKind,
): RpcUsageView {
  if (kind !== 'cumulative' && kind !== 'interval') {
    throw new TypeError(INVALID);
  }

  const logicalKeys = new Set<string>();
  const logical = rows(
    own(input, 'logical'),
    RPC_METHOD_LABELS.length * 2,
  ).map((inputRow) => {
    const row = logicalRow(inputRow, kind);
    const key = row.client + ':' + row.method;

    if (logicalKeys.has(key)) {
      throw new TypeError(INVALID);
    }

    logicalKeys.add(key);
    return row;
  });

  const httpClients = new Set<RpcClientRole>();
  const http = rows(own(input, 'http'), 2).map((inputRow) => {
    const row = httpRow(inputRow, kind);

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

  http.sort((left, right) => compareLabels(left.client, right.client));

  return Object.freeze({
    logical: Object.freeze(logical),
    http: Object.freeze(http),
  });
}