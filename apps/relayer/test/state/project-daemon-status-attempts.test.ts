import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  DaemonStatusAttempt,
} from '../../src/state/daemon-status-snapshot.js';

import {
  MAX_DAEMON_STATUS_ATTEMPT_DETAILS,
  projectDaemonStatusAttempts,
} from '../../src/state/project-daemon-status-attempts.js';

const HASH = `0x${'aa'.repeat(32)}` as const;

function attempt(
  nonce: number,
  phase: DaemonStatusAttempt['phase'],
): DaemonStatusAttempt {
  return {
    attemptId:
      '00000000-0000-4000-8000-'
      + nonce.toString(16).padStart(12, '0'),
    workId: `test-work:${nonce}`,
    nonce: nonce.toString(),
    phase,
    transactionHashes: [HASH],
  };
}

describe('daemon status attempt projection', () => {
  it('reports an empty retained population', () => {
    expect(projectDaemonStatusAttempts([])).toEqual({
      summary: {
        retainedCount: 0,
        includedCount: 0,
        unresolvedCount: 0,
        lowestNonce: null,
        highestNonce: null,
        detailedCount: 0,
        omittedCount: 0,
      },
      details: [],
    });
  });

  it('shows the oldest included attempt when none are unresolved', () => {
    const attempts = [
      attempt(4, 'included'),
      attempt(5, 'included'),
      attempt(6, 'included'),
    ];

    const result = projectDaemonStatusAttempts(attempts);

    expect(result.summary).toEqual({
      retainedCount: 3,
      includedCount: 3,
      unresolvedCount: 0,
      lowestNonce: '4',
      highestNonce: '6',
      detailedCount: 1,
      omittedCount: 2,
    });

    expect(result.details).toEqual([attempts[0]]);
  });

  it('prioritizes an unresolved attempt over an earlier included attempt', () => {
    const attempts = [
      attempt(4, 'included'),
      attempt(5, 'broadcast-may-have-occurred'),
      attempt(6, 'signed'),
    ];

    const result = projectDaemonStatusAttempts(attempts);

    expect(result.summary).toEqual({
      retainedCount: 3,
      includedCount: 1,
      unresolvedCount: 2,
      lowestNonce: '4',
      highestNonce: '6',
      detailedCount: 1,
      omittedCount: 2,
    });

    expect(result.details).toEqual([attempts[1]]);
  });

  it('counts every unresolved attempt after a population-wide reorg', () => {
    const attempts = Array.from(
      { length: 20 },
      (_, index) => attempt(
        index + 4,
        'broadcast-may-have-occurred',
      ),
    );

    const result = projectDaemonStatusAttempts(attempts);

    expect(result.summary).toEqual({
      retainedCount: 20,
      includedCount: 0,
      unresolvedCount: 20,
      lowestNonce: '4',
      highestNonce: '23',
      detailedCount: 1,
      omittedCount: 19,
    });

    expect(result.details).toHaveLength(
      MAX_DAEMON_STATUS_ATTEMPT_DETAILS,
    );

    expect(result.details[0]).toEqual(attempts[0]);

    expect(
      result.summary.detailedCount + result.summary.omittedCount,
    ).toBe(result.summary.retainedCount);
  });

  it('returns detached frozen details without freezing or changing its input', () => {
    const first = attempt(4, 'included');

    // Update the fixture and copy assertions whenever the type gains
    // another object-valued field.
    type ObjectField = {
      [K in keyof DaemonStatusAttempt]-?:
        Extract<
          NonNullable<DaemonStatusAttempt[K]>,
          object
        > extends never ? never : K;
    }[keyof DaemonStatusAttempt];

    const objectFields: Record<ObjectField, true> = {
      transactionHashes: true,
    };

    expect(Object.keys(first).filter((key) => {
      const value = first[key as keyof DaemonStatusAttempt];

      return value !== null && typeof value === 'object';
    }).sort()).toEqual(Object.keys(objectFields).sort());

    const attempts = [first];
    const before = structuredClone(attempts);

    const result = projectDaemonStatusAttempts(attempts);

    expect(attempts).toEqual(before);

    expect(result.details[0]).not.toBe(first);
    expect(result.details[0]!.transactionHashes)
      .not.toBe(first.transactionHashes);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(Object.isFrozen(result.details)).toBe(true);
    expect(Object.isFrozen(result.details[0])).toBe(true);
    expect(Object.isFrozen(result.details[0]!.transactionHashes))
      .toBe(true);

    expect(Object.isFrozen(attempts)).toBe(false);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(first.transactionHashes)).toBe(false);
  });
});