import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createRpcUsageReport,
  type RpcMetricsObservation,
} from '../../../src/diagnostics/rpc/rpc-usage-report.js';

function cumulativeObservation(): RpcMetricsObservation {
  const counters = {
    started: 2,
    succeeded: 1,
    failed: 0,
    inFlight: 1,
    durationMs: 1.25,
  };

  return {
    observedAtMs: 100,
    snapshot: {
      collectorId: 'collector-a',
      startedAt: '2026-10-21T00:00:00.000Z',
      logical: [
        {
          ...counters,
          client: 'wallet',
          method: 'eth_call',
        },
        {
          ...counters,
          client: 'public',
          method: 'other',
        },
        {
          ...counters,
          client: 'public',
          method: 'eth_call',
        },
      ],
      http: [
        {
          ...counters,
          client: 'wallet',
          statuses: {
            '5xx': 0,
            '4xx': 0,
            '3xx': 0,
            '2xx': 1,
          },
        },
        {
          ...counters,
          client: 'public',
          statuses: {
            '5xx': 0,
            '4xx': 0,
            '3xx': 0,
            '2xx': 1,
          },
        },
      ],
    },
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  expect(Object.isFrozen(value)).toBe(true);

  for (const child of Object.values(value)) {
    expectDeeplyFrozen(child);
  }
}

function emptyObservation(
  observedAtMs: number,
): RpcMetricsObservation {
  return {
    observedAtMs,
    snapshot: {
      collectorId: 'collector-a',
      startedAt: '2026-10-21T00:00:00.000Z',
      logical: [],
      http: [],
    },
  };
}

function availableInterval(
  current: RpcMetricsObservation,
  previous: RpcMetricsObservation,
) {
  const interval = createRpcUsageReport(current, previous).interval;

  expect(interval.available).toBe(true);

  if (!interval.available) {
    throw new Error('Expected an available RPC usage interval.');
  }

  return interval;
}

function expectUnavailableInterval(
  current: RpcMetricsObservation,
  previous: RpcMetricsObservation | undefined,
  reason:
    | 'no-baseline'
    | 'collector-changed'
    | 'invalid-elapsed-time'
    | 'counters-regressed',
): void {
  const before = structuredClone({ current, previous });
  const report = createRpcUsageReport(current, previous);

  expect(report.interval).toEqual({
    available: false,
    reason,
  });

  expect(report.cumulative).toEqual(
    createRpcUsageReport(current).cumulative,
  );

  expect(report.collectorId).toBe(current.snapshot.collectorId);
  expect(report.startedAt).toBe(current.snapshot.startedAt);
  expect({ current, previous }).toEqual(before);
  expectDeeplyFrozen(report);
}

describe('RPC usage report', () => {
  it('reports cumulative usage without a baseline', () => {
    const current: RpcMetricsObservation = {
      observedAtMs: 123.5,
      snapshot: {
        collectorId: 'collector-a',
        startedAt: '2026-10-21T00:00:00.000Z',
        logical: [
          {
            client: 'public',
            method: 'eth_call',
            started: 4,
            succeeded: 2,
            failed: 1,
            inFlight: 1,
            durationMs: 12.75,
          },
        ],
        http: [
          {
            client: 'public',
            started: 5,
            succeeded: 3,
            failed: 1,
            inFlight: 1,
            durationMs: 10.5,
            statuses: {
              '2xx': 1,
              '3xx': 0,
              '4xx': 0,
              '5xx': 1,
            },
          },
        ],
      },
    };

    expect(createRpcUsageReport(current)).toEqual({
      collectorId: 'collector-a',
      startedAt: '2026-10-21T00:00:00.000Z',
      cumulative: {
        logical: [
          {
            client: 'public',
            method: 'eth_call',
            started: 4,
            completed: 3,
            failed: 1,
            inFlight: 1,
            durationMs: 12.75,
            averageDurationMs: 4.25,
          },
        ],
        http: [
          {
            client: 'public',
            started: 5,
            responses: 3,
            transportFailures: 1,
            inFlight: 1,
            durationMs: 10.5,
            averageDurationMs: 2.625,
            statuses: {
              '2xx': 1,
              '3xx': 0,
              '4xx': 0,
              '5xx': 1,
            },
          },
        ],
      },
      interval: {
        available: false,
        reason: 'no-baseline',
      },
    });
  });

  it('reports null averages when no work has completed', () => {
    const current: RpcMetricsObservation = {
      observedAtMs: 200,
      snapshot: {
        collectorId: 'collector-a',
        startedAt: '2026-10-21T00:00:00.000Z',
        logical: [
          {
            client: 'public',
            method: 'eth_call',
            started: 2,
            succeeded: 0,
            failed: 0,
            inFlight: 2,
            durationMs: 0,
          },
        ],
        http: [
          {
            client: 'public',
            started: 1,
            succeeded: 0,
            failed: 0,
            inFlight: 1,
            durationMs: 0,
            statuses: {
              '2xx': 0,
              '3xx': 0,
              '4xx': 0,
              '5xx': 0,
            },
          },
        ],
      },
    };

    const report = createRpcUsageReport(current);

    expect(report.cumulative.logical).toHaveLength(1);
    expect(report.cumulative.logical[0]).toMatchObject({
      started: 2,
      completed: 0,
      inFlight: 2,
      durationMs: 0,
      averageDurationMs: null,
    });

    expect(report.cumulative.http).toHaveLength(1);
    expect(report.cumulative.http[0]).toMatchObject({
      started: 1,
      responses: 0,
      transportFailures: 0,
      inFlight: 1,
      durationMs: 0,
      averageDurationMs: null,
    });
  });

  it('does not fabricate rows for an empty collector', () => {
    const report = createRpcUsageReport({
      observedAtMs: 100,
      snapshot: {
        collectorId: 'collector-a',
        startedAt: '2026-10-21T00:00:00.000Z',
        logical: [],
        http: [],
      },
    });

    expect(report.cumulative).toEqual({
      logical: [],
      http: [],
    });

    expect(report.interval).toEqual({
      available: false,
      reason: 'no-baseline',
    });
  });

  it('serializes equivalent snapshots identically regardless of insertion order', () => {
    const current = cumulativeObservation();

    const reversed: RpcMetricsObservation = {
      observedAtMs: current.observedAtMs,
      snapshot: {
        ...current.snapshot,
        logical: [...current.snapshot.logical].reverse(),
        http: [...current.snapshot.http].reverse().map((row) => ({
          ...row,
          statuses: {
            '2xx': row.statuses['2xx'],
            '3xx': row.statuses['3xx'],
            '4xx': row.statuses['4xx'],
            '5xx': row.statuses['5xx'],
          },
        })),
      },
    };

    const report = createRpcUsageReport(current);

    expect(JSON.stringify(report)).toBe(
      JSON.stringify(createRpcUsageReport(reversed)),
    );

    expect(
      report.cumulative.logical.map((row) => [
        row.client,
        row.method,
      ]),
    ).toEqual([
      ['public', 'eth_call'],
      ['public', 'other'],
      ['wallet', 'eth_call'],
    ]);

    expect(
      report.cumulative.http.map((row) => row.client),
    ).toEqual(['public', 'wallet']);

    for (const row of report.cumulative.http) {
      expect(Object.keys(row.statuses)).toEqual([
        '2xx',
        '3xx',
        '4xx',
        '5xx',
      ]);
    }
  });

  it('preserves input values, array order, and mutability', () => {
    const current = cumulativeObservation();
    const before = structuredClone(current);

    createRpcUsageReport(current);

    expect(current).toEqual(before);

    expect(Object.isFrozen(current.snapshot)).toBe(false);
    expect(Object.isFrozen(current.snapshot.logical)).toBe(false);
    expect(Object.isFrozen(current.snapshot.http)).toBe(false);

    for (const row of current.snapshot.logical) {
      expect(Object.isFrozen(row)).toBe(false);
    }

    for (const row of current.snapshot.http) {
      expect(Object.isFrozen(row)).toBe(false);
      expect(Object.isFrozen(row.statuses)).toBe(false);
    }
  });

  it('deeply freezes the report without sharing input objects', () => {
    const current = cumulativeObservation();
    const report = createRpcUsageReport(current);

    expectDeeplyFrozen(report);

    expect(report.cumulative).not.toBe(current.snapshot);
    expect(report.cumulative.logical).not.toBe(
      current.snapshot.logical,
    );
    expect(report.cumulative.http).not.toBe(
      current.snapshot.http,
    );

    for (const row of report.cumulative.logical) {
      const source = current.snapshot.logical.find((candidate) => {
        return candidate.client === row.client
          && candidate.method === row.method;
      });

      expect(source).toBeDefined();
      expect(row).not.toBe(source);
    }

    for (const row of report.cumulative.http) {
      const source = current.snapshot.http.find((candidate) => {
        return candidate.client === row.client;
      });

      expect(source).toBeDefined();
      expect(row).not.toBe(source);
      expect(row.statuses).not.toBe(source!.statuses);
    }
  });

  it('calculates counter deltas and fractional elapsed time', () => {
    const previous: RpcMetricsObservation = {
      observedAtMs: 100.25,
      snapshot: {
        collectorId: 'collector-a',
        startedAt: '2026-10-21T00:00:00.000Z',
        logical: [
          {
            client: 'public',
            method: 'eth_call',
            started: 4,
            succeeded: 2,
            failed: 1,
            inFlight: 1,
            durationMs: 12.75,
          },
        ],
        http: [
          {
            client: 'public',
            started: 4,
            succeeded: 2,
            failed: 1,
            inFlight: 1,
            durationMs: 6.75,
            statuses: {
              '2xx': 1,
              '3xx': 0,
              '4xx': 0,
              '5xx': 1,
            },
          },
        ],
      },
    };

    const current: RpcMetricsObservation = {
      observedAtMs: 100.5,
      snapshot: {
        ...previous.snapshot,
        logical: [
          {
            client: 'public',
            method: 'eth_call',
            started: 7,
            succeeded: 4,
            failed: 2,
            inFlight: 1,
            durationMs: 23.25,
          },
        ],
        http: [
          {
            client: 'public',
            started: 9,
            succeeded: 6,
            failed: 2,
            inFlight: 1,
            durationMs: 18,
            statuses: {
              '2xx': 2,
              '3xx': 1,
              '4xx': 0,
              '5xx': 2,
            },
          },
        ],
      },
    };

    expect(availableInterval(current, previous)).toEqual({
      available: true,
      elapsedMs: 0.25,
      logical: [
        {
          client: 'public',
          method: 'eth_call',
          started: 3,
          completed: 3,
          failed: 1,
          inFlight: 1,
          durationMs: 10.5,
          averageDurationMs: 3.5,
        },
      ],
      http: [
        {
          client: 'public',
          started: 5,
          responses: 4,
          transportFailures: 1,
          inFlight: 1,
          durationMs: 11.25,
          averageDurationMs: 2.25,
          statuses: {
            '2xx': 1,
            '3xx': 1,
            '4xx': 0,
            '5xx': 1,
          },
        },
      ],
    });
  });

  it('uses zero baselines for new logical and HTTP rows', () => {
    const current = cumulativeObservation();

    const previous: RpcMetricsObservation = {
      observedAtMs: 0,
      snapshot: {
        ...current.snapshot,
        logical: current.snapshot.logical.filter((row) => {
          return row.client === 'wallet';
        }),
        http: current.snapshot.http.filter((row) => {
          return row.client === 'wallet';
        }),
      },
    };

    const interval = availableInterval(current, previous);
    const cumulative = createRpcUsageReport(current).cumulative;

    expect(interval.logical.filter((row) => {
      return row.client === 'public';
    })).toEqual(cumulative.logical.filter((row) => {
      return row.client === 'public';
    }));

    expect(interval.http.filter((row) => {
      return row.client === 'public';
    })).toEqual(cumulative.http.filter((row) => {
      return row.client === 'public';
    }));

    expect(interval.logical).toHaveLength(3);
    expect(interval.http).toHaveLength(2);
  });

  it('retains unchanged rows with zero deltas and null averages', () => {
    const current = cumulativeObservation();
    const previous = {
      ...current,
      observedAtMs: 0,
    };

    const interval = availableInterval(current, previous);

    expect(interval.logical).toHaveLength(3);
    expect(interval.http).toHaveLength(2);

    for (const row of interval.logical) {
      expect(row).toMatchObject({
        started: 0,
        completed: 0,
        failed: 0,
        inFlight: 1,
        durationMs: 0,
        averageDurationMs: null,
      });
    }

    for (const row of interval.http) {
      expect(row).toMatchObject({
        started: 0,
        responses: 0,
        transportFailures: 0,
        inFlight: 1,
        durationMs: 0,
        averageDurationMs: null,
        statuses: {
          '2xx': 0,
          '3xx': 0,
          '4xx': 0,
          '5xx': 0,
        },
      });
    }
  });

  it('attributes spanning work to its completion interval with full duration', () => {
    const pending: RpcMetricsObservation = {
      observedAtMs: 10,
      snapshot: {
        ...emptyObservation(0).snapshot,
        logical: [
          {
            client: 'public',
            method: 'eth_call',
            started: 1,
            succeeded: 0,
            failed: 0,
            inFlight: 1,
            durationMs: 0,
          },
        ],
        http: [
          {
            client: 'public',
            started: 1,
            succeeded: 0,
            failed: 0,
            inFlight: 1,
            durationMs: 0,
            statuses: {
              '2xx': 0,
              '3xx': 0,
              '4xx': 0,
              '5xx': 0,
            },
          },
        ],
      },
    };

    const completed: RpcMetricsObservation = {
      observedAtMs: 20,
      snapshot: {
        ...pending.snapshot,
        logical: [
          {
            ...pending.snapshot.logical[0]!,
            succeeded: 1,
            inFlight: 0,
            durationMs: 17.5,
          },
        ],
        http: [
          {
            ...pending.snapshot.http[0]!,
            succeeded: 1,
            inFlight: 0,
            durationMs: 15.5,
            statuses: {
              '2xx': 1,
              '3xx': 0,
              '4xx': 0,
              '5xx': 0,
            },
          },
        ],
      },
    };

    const startInterval = availableInterval(
      pending,
      emptyObservation(0),
    );

    expect(startInterval.logical[0]).toMatchObject({
      started: 1,
      completed: 0,
      inFlight: 1,
      durationMs: 0,
      averageDurationMs: null,
    });

    expect(startInterval.http[0]).toMatchObject({
      started: 1,
      responses: 0,
      inFlight: 1,
      durationMs: 0,
      averageDurationMs: null,
    });

    const completionInterval = availableInterval(completed, pending);

    expect(completionInterval.logical[0]).toMatchObject({
      started: 0,
      completed: 1,
      failed: 0,
      inFlight: 0,
      durationMs: 17.5,
      averageDurationMs: 17.5,
    });

    expect(completionInterval.http[0]).toMatchObject({
      started: 0,
      responses: 1,
      transportFailures: 0,
      inFlight: 0,
      durationMs: 15.5,
      averageDurationMs: 15.5,
    });
  });

  it('produces canonical frozen intervals while preserving both observations', () => {
    const current = cumulativeObservation();
    const previous: RpcMetricsObservation = {
      observedAtMs: 0,
      snapshot: {
        ...current.snapshot,
        logical: current.snapshot.logical.filter((row) => {
          return row.client === 'wallet';
        }),
        http: current.snapshot.http.filter((row) => {
          return row.client === 'wallet';
        }),
      },
    };

    const before = structuredClone({ current, previous });

    function reversed(
      observation: RpcMetricsObservation,
    ): RpcMetricsObservation {
      return {
        ...observation,
        snapshot: {
          ...observation.snapshot,
          logical: [...observation.snapshot.logical].reverse(),
          http: [...observation.snapshot.http].reverse(),
        },
      };
    }

    const report = createRpcUsageReport(current, previous);

    expect(JSON.stringify(report)).toBe(JSON.stringify(
      createRpcUsageReport(reversed(current), reversed(previous)),
    ));

    expect({ current, previous }).toEqual(before);
    expectDeeplyFrozen(report);

    const interval = availableInterval(current, previous);

    expect(interval.logical.map((row) => [
      row.client,
      row.method,
    ])).toEqual([
      ['public', 'eth_call'],
      ['public', 'other'],
      ['wallet', 'eth_call'],
    ]);

    expect(interval.http.map((row) => row.client)).toEqual([
      'public',
      'wallet',
    ]);

    for (const observation of [current, previous]) {
      expect(interval.logical).not.toBe(observation.snapshot.logical);
      expect(interval.http).not.toBe(observation.snapshot.http);

      for (const row of interval.logical) {
        for (const source of observation.snapshot.logical) {
          expect(row).not.toBe(source);
          expect(Object.isFrozen(source)).toBe(false);
        }
      }

      for (const row of interval.http) {
        expect(Object.keys(row.statuses)).toEqual([
          '2xx',
          '3xx',
          '4xx',
          '5xx',
        ]);

        for (const source of observation.snapshot.http) {
          expect(row).not.toBe(source);
          expect(row.statuses).not.toBe(source.statuses);
          expect(Object.isFrozen(source.statuses)).toBe(false);
        }
      }
    }
  });

  it('rejects cross-collector intervals while retaining current usage', () => {
    const previous = cumulativeObservation();

    const current: RpcMetricsObservation = {
      observedAtMs: 200,
      snapshot: {
        ...previous.snapshot,
        collectorId: 'collector-b',
      },
    };

    expectUnavailableInterval(
      current,
      previous,
      'collector-changed',
    );
  });

  it.each([
    { name: 'equal times', previous: 100, current: 100 },
    { name: 'decreasing times', previous: 100, current: 99 },
    { name: 'previous NaN', previous: NaN, current: 100 },
    { name: 'current NaN', previous: 100, current: NaN },
    {
      name: 'previous positive infinity',
      previous: Infinity,
      current: 100,
    },
    {
      name: 'current positive infinity',
      previous: 100,
      current: Infinity,
    },
    {
      name: 'previous negative infinity',
      previous: -Infinity,
      current: 100,
    },
    {
      name: 'current negative infinity',
      previous: 100,
      current: -Infinity,
    },
    {
      name: 'elapsed time overflow',
      previous: -Number.MAX_VALUE,
      current: Number.MAX_VALUE,
    },
  ])('rejects invalid elapsed time: $name', (times) => {
    const observation = cumulativeObservation();

    expectUnavailableInterval(
      { ...observation, observedAtMs: times.current },
      { ...observation, observedAtMs: times.previous },
      'invalid-elapsed-time',
    );
  });

  it.each([
    'started',
    'succeeded',
    'failed',
    'durationMs',
  ] as const)('rejects logical counter regression: %s', (field) => {
    const fixture = cumulativeObservation();
    const row = {
      ...fixture.snapshot.logical[0]!,
      started: 5,
      succeeded: 2,
      failed: 2,
      inFlight: 1,
      durationMs: 10,
    };

    const previous: RpcMetricsObservation = {
      observedAtMs: 0,
      snapshot: {
        ...fixture.snapshot,
        logical: [row],
      },
    };

    const current: RpcMetricsObservation = {
      observedAtMs: 100,
      snapshot: {
        ...previous.snapshot,
        logical: [
          {
            ...row,
            [field]: row[field] - 1,
          },
        ],
      },
    };

    expectUnavailableInterval(current, previous, 'counters-regressed');
  });

  it.each([
    'started',
    'succeeded',
    'failed',
    'durationMs',
  ] as const)('rejects HTTP counter regression: %s', (field) => {
    const fixture = cumulativeObservation();
    const row = {
      ...fixture.snapshot.http[0]!,
      started: 5,
      succeeded: 2,
      failed: 2,
      inFlight: 1,
      durationMs: 10,
    };

    const previous: RpcMetricsObservation = {
      observedAtMs: 0,
      snapshot: {
        ...fixture.snapshot,
        http: [row],
      },
    };

    const current: RpcMetricsObservation = {
      observedAtMs: 100,
      snapshot: {
        ...previous.snapshot,
        http: [
          {
            ...row,
            [field]: row[field] - 1,
          },
        ],
      },
    };

    expectUnavailableInterval(current, previous, 'counters-regressed');
  });

  it.each([
    '2xx',
    '3xx',
    '4xx',
    '5xx',
  ] as const)('rejects HTTP status regression: %s', (status) => {
    const fixture = cumulativeObservation();
    const row = {
      ...fixture.snapshot.http[0]!,
      started: 5,
      succeeded: 4,
      failed: 0,
      inFlight: 1,
      statuses: {
        '2xx': 1,
        '3xx': 1,
        '4xx': 1,
        '5xx': 1,
      },
    };

    const previous: RpcMetricsObservation = {
      observedAtMs: 0,
      snapshot: {
        ...fixture.snapshot,
        http: [row],
      },
    };

    const current: RpcMetricsObservation = {
      observedAtMs: 100,
      snapshot: {
        ...previous.snapshot,
        http: [
          {
            ...row,
            statuses: {
              ...row.statuses,
              [status]: 0,
            },
          },
        ],
      },
    };

    expectUnavailableInterval(current, previous, 'counters-regressed');
  });

  it.each(['logical', 'http'] as const)(
    'rejects a missing current %s row',
    (kind) => {
      const previous = {
        ...cumulativeObservation(),
        observedAtMs: 0,
      };

      const current: RpcMetricsObservation = {
        observedAtMs: 100,
        snapshot: {
          ...previous.snapshot,
          [kind]: previous.snapshot[kind].slice(1),
        },
      };

      expectUnavailableInterval(
        current,
        previous,
        'counters-regressed',
      );
    },
  );

  it.each(['logical', 'http'] as const)(
    'rejects even a tiny duration regression in %s rows',
    (kind) => {
      const previous = {
        ...cumulativeObservation(),
        observedAtMs: 0,
      };

      const current: RpcMetricsObservation = {
        observedAtMs: 100,
        snapshot: {
          ...previous.snapshot,
          [kind]: previous.snapshot[kind].map((row) => ({
            ...row,

            // The fixture uses 1.25 ms, where subtracting Number.EPSILON
            // produces a distinct, smaller representable value.
            durationMs: row.durationMs - Number.EPSILON,
          })),
        },
      };

      expectUnavailableInterval(
        current,
        previous,
        'counters-regressed',
      );
    },
  );

  it('checks unavailable reasons in the specified order', () => {
    const previous = cumulativeObservation();

    const changedCollector: RpcMetricsObservation = {
      observedAtMs: NaN,
      snapshot: {
        ...previous.snapshot,
        collectorId: 'collector-b',
        logical: [],
        http: [],
      },
    };

    // No baseline takes precedence over an invalid observation time.
    expectUnavailableInterval(
      changedCollector,
      undefined,
      'no-baseline',
    );

    // Changed collector takes precedence over invalid time and missing rows.
    expectUnavailableInterval(
      changedCollector,
      previous,
      'collector-changed',
    );

    const sameCollector: RpcMetricsObservation = {
      ...changedCollector,
      snapshot: {
        ...changedCollector.snapshot,
        collectorId: previous.snapshot.collectorId,
      },
    };

    // Invalid time takes precedence over missing rows.
    expectUnavailableInterval(
      sameCollector,
      previous,
      'invalid-elapsed-time',
    );

    // With valid time, the missing rows cause counter regression.
    expectUnavailableInterval(
      { ...sameCollector, observedAtMs: 200 },
      previous,
      'counters-regressed',
    );
  });
});