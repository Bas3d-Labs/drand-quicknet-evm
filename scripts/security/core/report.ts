import {
  aggregateCheckStatuses,
  type AggregateStatus,
  type CheckResult,
} from './check.js';

export type ReportValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | readonly ReportValue[]
  | {
      readonly [key: string]: ReportValue;
    };

export interface VerificationObservation {
  id: string;
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

export type VerificationCheck =
  CheckResult<
    ReportValue,
    ReportValue
  > & {
    id: string;
    observationIds: readonly string[];
    details?: ReportValue;
};

export interface VerificationReport {
  reportVersion: 1;
  network: string;
  chainId: number;
  verificationTimestamp: string;
  repositoryRevision: string;
  repositoryDirty: boolean;
  observations: readonly VerificationObservation[];
  checks: readonly VerificationCheck[];
  aggregateStatus: AggregateStatus;
}

export interface CreateVerificationReportInput {
  network: string;
  chainId: number;
  verificationTime: Date;
  repositoryRevision: string;
  repositoryDirty: boolean;
  observations: readonly VerificationObservation[];
  checks: readonly VerificationCheck[];
}

function requireNonEmptyString(
  value: string,
  path: string,
): void {
  if (value.trim().length === 0) {
    throw new Error(`${path} must not be empty.`);
  }
}

function requireChainId(
  value: number,
  path: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive safe integer.`);
  }
}

function requireNonNegativeBigInt(
  value: bigint,
  path: string,
): void {
  if (value < 0n) {
    throw new Error(`${path} must be non-negative.`);
  }
}

function validateReportValue(
  value: ReportValue,
  path: string,
): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must contain only finite numbers.`);
    }

    if (
      Number.isInteger(value) &&
      !Number.isSafeInteger(value)
    ) {
      throw new Error(`${path} must contain only safe integer numbers.`);
    }

    return;
  }

  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  ) {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      if (item === undefined) {
        throw new Error(`${path}[${i}] is missing.`);
      }

      validateReportValue(item, `${path}[${i}]`);
    }

    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    validateReportValue(nestedValue, `${path}.${key}`);
  }
}

function validateObservations(
  observations: readonly VerificationObservation[],
): void {
  const ids = new Set<string>();

  for (let i = 0; i < observations.length; i += 1) {
    const observation = observations[i];
    if (observation === undefined) {
      throw new Error(`observations[${i}] is missing.`);
    }

    const path = `observations[${i}]`;

    requireNonEmptyString(observation.id, `${path}.id`);

    if (ids.has(observation.id)) {
      throw new Error(`duplicate observation ID: ${observation.id}.`);
    }

    ids.add(observation.id);

    requireChainId(observation.chainId, `${path}.chainId`);
    requireNonNegativeBigInt(observation.blockNumber, `${path}.blockNumber`);
    requireNonNegativeBigInt(
      observation.blockTimestamp,
      `${path}.blockTimestamp`,
    );
  }
}

function validateChecks(
  checks: readonly VerificationCheck[],
  observationIds: ReadonlySet<string>,
): void {
  const ids = new Set<string>();

  for (let i = 0; i < checks.length; i += 1) {
    const check = checks[i];
    if (check === undefined) {
      throw new Error(`checks[${i}] is missing.`);
    }

    const path = `checks[${i}]`;

    requireNonEmptyString(check.id, `${path}.id`);

    if (ids.has(check.id)) {
      throw new Error(`duplicate check ID: ${check.id}.`);
    }

    ids.add(check.id);

    const referencedObservationIds = new Set<string>();
    for (let j = 0; j < check.observationIds.length; j += 1) {
      const observationId = check.observationIds[j];
      if (observationId === undefined) {
        throw new Error(`${path}.observationIds[${j}] is missing.`);
      }

      requireNonEmptyString(
        observationId,
        `${path}.observationIds[${j}]`,
      );

      if (referencedObservationIds.has(observationId)) {
        throw new Error(
          `${path} contains duplicate observation ID: ${observationId}.`,
        );
      }

      if (!observationIds.has(observationId)) {
        throw new Error(
          `${path} references unknown observation ID: ${observationId}.`,
        );
      }

      referencedObservationIds.add(observationId);
    }

    validateReportValue(check.expected, `${path}.expected`);

    if (
      check.status === 'MATCH' ||
      check.status === 'DRIFT'
    ) {
      validateReportValue(check.observed, `${path}.observed`);
    }

    if (
      check.status === 'DRIFT' ||
      check.status === 'SKIPPED'
    ) {
      requireNonEmptyString(check.reason, `${path}.reason`);
    }

    if (check.status === 'ERROR') {
      requireNonEmptyString(check.error, `${path}.error`);
    }

    if (check.details !== undefined) {
      validateReportValue(check.details, `${path}.details`);
    }
  }
}

function verificationTimestamp(
  time: Date,
): string {
  if (Number.isNaN(time.getTime())) {
    throw new Error('verificationTime must be a valid date.');
  }

  return time.toISOString();
}

function cloneVerificationCheck(
  check: VerificationCheck,
): VerificationCheck {
  if (check.status === 'MATCH') {
    const cloned: VerificationCheck = {
      id: check.id,
      observationIds: [
        ...check.observationIds,
      ],
      status: 'MATCH',
      expected: cloneReportValue(check.expected),
      observed: cloneReportValue(check.observed),
    };

    if (check.details !== undefined) {
      cloned.details = cloneReportValue(check.details);
    }

    return cloned;
  }

  if (check.status === 'DRIFT') {
    const cloned: VerificationCheck = {
      id: check.id,
      observationIds: [
        ...check.observationIds,
      ],
      status: 'DRIFT',
      expected: cloneReportValue(check.expected),
      observed: cloneReportValue(check.observed),
      reason: check.reason,
    };

    if (check.details !== undefined) {
      cloned.details = cloneReportValue(check.details);
    }

    return cloned;
  }

  if (check.status === 'ERROR') {
    const cloned: VerificationCheck = {
      id: check.id,
      observationIds: [
        ...check.observationIds,
      ],
      status: 'ERROR',
      expected: cloneReportValue(check.expected),
      error: check.error,
    };

    if (check.details !== undefined) {
      cloned.details = cloneReportValue(check.details);
    }

    return cloned;
  }

  const cloned: VerificationCheck = {
    id: check.id,
    observationIds: [
      ...check.observationIds,
    ],
    status: 'SKIPPED',
    expected: cloneReportValue(check.expected),
    reason: check.reason,
  };

  if (check.details !== undefined) {
    cloned.details = cloneReportValue(check.details);
  }

  return cloned;
}

function cloneReportValue(
  value: ReportValue,
): ReportValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(
      item => cloneReportValue(item),
    );
  }

  const cloned: {
    [key: string]: ReportValue;
  } = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    cloned[key] = cloneReportValue(
      nestedValue,
    );
  }

  return cloned;
}

export function createVerificationReport(
  input: CreateVerificationReportInput,
): VerificationReport {
  requireNonEmptyString(input.network, 'network');

  requireChainId(input.chainId, 'chainId');

  requireNonEmptyString(
    input.repositoryRevision,
    'repositoryRevision',
  );

  validateObservations(input.observations);

  const observationIds = new Set(
    input.observations.map(
      observation => observation.id,
    ),
  );

  validateChecks(input.checks, observationIds);

  const observations = input.observations.map(
    observation => ({ ...observation }),
  );

  const checks = input.checks.map(
    check => cloneVerificationCheck(check),
  );

  const aggregateStatus = aggregateCheckStatuses(
    checks.map(check => check.status),
  );

  return {
    reportVersion: 1,
    network: input.network,
    chainId: input.chainId,
    verificationTimestamp: verificationTimestamp(input.verificationTime),
    repositoryRevision: input.repositoryRevision,
    repositoryDirty: input.repositoryDirty,
    observations,
    checks,
    aggregateStatus,
  };
}

function serializeValue(
  _key: string,
  value: unknown,
): unknown {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  return value;
}

export function serializeVerificationReport(
  report: VerificationReport,
): string {
  return JSON.stringify(
    report,
    serializeValue,
    2,
  ) + '\n';
}