import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  aggregateCheckStatuses,
} from './check.js';

describe('aggregateCheckStatuses', () => {
  it('returns MATCH when every check matches', () => {
    expect(
      aggregateCheckStatuses([
        'MATCH',
        'MATCH',
        'MATCH',
      ]),
    ).toBe(
      'MATCH',
    );
  });

  it('returns DRIFT when a check drifts', () => {
    expect(
      aggregateCheckStatuses([
        'MATCH',
        'DRIFT',
        'MATCH',
      ]),
    ).toBe(
      'DRIFT',
    );
  });

  it('returns DRIFT when a skipped check is explained by drift', () => {
    expect(
      aggregateCheckStatuses([
        'DRIFT',
        'SKIPPED',
        'MATCH',
      ]),
    ).toBe(
      'DRIFT',
    );
  });

  it('returns ERROR when a check errors', () => {
    expect(
      aggregateCheckStatuses([
        'MATCH',
        'ERROR',
        'MATCH',
      ]),
    ).toBe(
      'ERROR',
    );
  });

  it('lets ERROR dominate DRIFT', () => {
    expect(
      aggregateCheckStatuses([
        'DRIFT',
        'ERROR',
        'SKIPPED',
      ]),
    ).toBe(
      'ERROR',
    );
  });

  it('returns ERROR for an unexplained skipped check', () => {
    expect(
      aggregateCheckStatuses([
        'MATCH',
        'SKIPPED',
        'MATCH',
      ]),
    ).toBe(
      'ERROR',
    );
  });

  it('returns ERROR when no checks were performed', () => {
    expect(
      aggregateCheckStatuses([]),
    ).toBe(
      'ERROR',
    );
  });
});