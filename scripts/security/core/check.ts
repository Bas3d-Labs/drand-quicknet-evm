export type CheckStatus =
  | 'MATCH'
  | 'DRIFT'
  | 'ERROR'
  | 'SKIPPED';

export type AggregateStatus =
  | 'MATCH'
  | 'DRIFT'
  | 'ERROR';

export type MatchCheckResult<
  TExpected,
  TObserved = TExpected,
> = {
  status: 'MATCH';
  expected: TExpected;
  observed: TObserved;
}

export type DriftCheckResult<
  TExpected,
  TObserved = TExpected,
> = {
  status: 'DRIFT';
  expected: TExpected;
  observed: TObserved;
  reason: string;
};

export type ErrorCheckResult<TExpected> = {
  status: 'ERROR';
  expected: TExpected;
  error: string;
}

export type SkippedCheckResult<TExpected> = {
  status: 'SKIPPED';
  expected: TExpected;
  reason: string;
}

export type CheckResult<
  TExpected,
  TObserved = TExpected
> =
  | MatchCheckResult<TExpected, TObserved>
  | DriftCheckResult<TExpected, TObserved>
  | ErrorCheckResult<TExpected>
  | SkippedCheckResult<TExpected>

export function aggregateCheckStatuses(
  statuses: readonly CheckStatus[],
): AggregateStatus {
  if (statuses.length === 0) {
    return 'ERROR';
  }
  
  if (statuses.includes('ERROR')) {
    return 'ERROR';
  }

  if (statuses.includes('DRIFT')) {
    return 'DRIFT';
  }

  if (statuses.includes('SKIPPED')) {
    return 'ERROR';
  }

  return 'MATCH';
}