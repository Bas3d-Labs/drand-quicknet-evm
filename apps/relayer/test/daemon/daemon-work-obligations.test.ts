import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  DaemonWorkObligations,
} from '../../src/daemon/daemon-work-obligations.js';

// Explicit future policy for the existing isolated bookkeeping fixtures.
// No production caller selects this policy in delivery 1.
const DEFERRED_CADENCE = {
  idleIntervalMs: 90_000,
  retainedIntervalMs: 30_000,
};

const EMPTY = {
  retainedCount: 0,
  releasedBehindRecoveryClearableBlockers: false,
};

describe('daemon work obligations', () => {
  it('delays captured work without delaying a later release', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const idle = owner.observe('idle', 'inspection', 0);

    const release = owner.observe('round', 'release', 5_000);

    owner.fail(owner.capture('full', 0), 100, EMPTY);
    owner.observe('idle', 'inspection', 0);

    expect(owner.get(idle)?.eligibleAt).toBe(90_100);
    expect(owner.get(release)?.eligibleAt).toBe(0);
    expect(owner.nextDeadline('full')).toBe(5_000);
    expect(owner.capture('full', 4_999).obligations).toHaveLength(0);
    expect(owner.capture('full', 5_000).obligations).toHaveLength(1);
  });

  it('preserves ineligible work on another failure and permits completion', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const a = owner.observe('a', 'release', 0);

    owner.fail(owner.capture('full', 0), 0, EMPTY);
    owner.observe('b', 'release', 5_000);
    owner.fail(owner.capture('full', 5_000), 6_000, EMPTY);

    expect(owner.get(a)?.eligibleAt).toBe(90_000);
    expect(owner.complete(a)).toBe(true);
    expect(owner.get(a)).toBeUndefined();
  });

  it('ignores stale captures after replacement', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const old = owner.observe('a', 'release', 0);

    const capture = owner.capture('full', 0);

    owner.complete(old);

    const next = owner.observe('a', 'release', 1);

    owner.fail(capture, 2, EMPTY);

    expect(owner.get(next)?.eligibleAt).toBe(0);
    expect(owner.complete(old)).toBe(false);
  });

  it.each([
    [0, false, 90_000],
    [1, false, 30_000],
    [0, true, 15_000],
    [1, true, 15_000],
  ] as const)('maps retained=%s, recoverable=%s to %s', (count, blocked, delay) => {
    const owner = new DaemonWorkObligations(5_000, DEFERRED_CADENCE);

    const item = owner.observe('a', 'release', 0);

    owner.fail(owner.capture('full', 0), 100, {
      retainedCount: count,
      releasedBehindRecoveryClearableBlockers: blocked,
    });

    expect(owner.get(item)?.eligibleAt).toBe(100 + delay);
  });

  it.each([5_000, 15_000, 120_000])('bounds waiting at poll=%s', (poll) => {
    const owner = new DaemonWorkObligations(poll, DEFERRED_CADENCE);

    const waiting = owner.observe('waiting', 'release', 0);

    const remainder = owner.observe('remainder', 'release', 0);

    owner.waiting(waiting, 100);

    expect(owner.get(waiting)?.eligibleAt).toBe(100 + Math.min(poll, 15_000));
    expect(owner.get(remainder)?.eligibleAt).toBe(0);
  });
});

const INSPECTION = {
  completedAt: 1_000,
  retainedCount: 1,
  recoveryComplete: true,
  inclusionChecksComplete: true,
  persistenceIdle: true,
};

describe('obligation completion evidence', () => {
  it.each([0, 1])('uses the completed inspection population %s', (retainedCount) => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const item = owner.observe('inspection', 'inspection', 0);

    owner.fail(owner.capture('full', 0), 0, EMPTY);

    const next = owner.inspection(item, { ...INSPECTION, retainedCount });

    expect(next?.dueAt).toBe(retainedCount === 0 ? 91_000 : 31_000);
    expect(next?.eligibleAt).toBe(0);
    expect(owner.get(item)).toBeUndefined();
  });

  it.each(['recoveryComplete', 'inclusionChecksComplete', 'persistenceIdle'] as const)(
    'requires inspection fact %s',
    (field) => {
      const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

      const item = owner.observe('inspection', 'inspection', 0);

      expect(owner.inspection(item, {
        ...INSPECTION,
        [field]: false,
      })).toBeUndefined();
      expect(owner.get(item)).toEqual(item);
    },
  );

  it('does not let a later failed scan undo a completed inspection', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const item = owner.observe('inspection', 'inspection', 0);

    const scan = owner.observeScan('scan', 'durable-continuation', 0n, 20n, 0);

    const captured = owner.capture('full', 0);

    const next = owner.inspection(item, INSPECTION);

    owner.fail(captured, 2_000, EMPTY);

    expect(next?.dueAt).toBe(31_000);
    expect(owner.get(next!)?.eligibleAt).toBe(0);
    expect(owner.get(scan)?.eligibleAt).toBe(92_000);
  });

  it('requires follow-up coverage by an inspection starting after acknowledgement', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const item = owner.followUp('attempt-a', 500);

    expect(owner.settleFollowUp(item, {
      attemptPresent: true,
      inspection: { ...INSPECTION, startedAt: 499, covered: true },
    })).toBe(false);
    expect(owner.settleFollowUp(item, {
      attemptPresent: true,
      inspection: { ...INSPECTION, startedAt: 500, covered: false },
    })).toBe(false);
    expect(owner.settleFollowUp(item, {
      attemptPresent: true,
      inspection: { ...INSPECTION, startedAt: 500, covered: true },
    })).toBe(true);
  });

  it('clears a follow-up when its attempt no longer exists', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const item = owner.followUp('attempt-a', 500);

    expect(owner.settleFollowUp(item, { attemptPresent: true })).toBe(false);
    expect(owner.settleFollowUp(item, { attemptPresent: false })).toBe(true);
    expect(owner.nextDeadline('full')).toBeNull();
  });

  it('keeps follow-up identity and backoff stable across rebroadcasts', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const item = owner.followUp('attempt-a', 500);

    owner.fail(owner.capture('full', 500), 600, EMPTY);

    expect(owner.followUp('attempt-a', 500).generation).toBe(item.generation);
    expect(owner.get(item)?.eligibleAt).toBe(90_600);
    const rebroadcast = owner.followUp('attempt-a', 700);

    expect(rebroadcast.generation).toBe(item.generation);
    expect(rebroadcast.eligibleAt).toBe(90_600);

    // A delayed re-observation of the first send cannot weaken coverage.
    owner.followUp('attempt-a', 500);

    expect(owner.settleFollowUp(item, {
      attemptPresent: true,
      inspection: { ...INSPECTION, startedAt: 600, covered: true },
    })).toBe(false);
    expect(owner.settleFollowUp(rebroadcast, {
      attemptPresent: true,
      inspection: { ...INSPECTION, startedAt: 700, covered: true },
    })).toBe(true);
  });

  it.each(['durable-continuation', 'soft-continuation'] as const)(
    'holds a fixed %s target and promotes the remembered target after progress',
    (reason) => {
      const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

      const item = owner.observeScan('scan', reason, 0n, 9n, 0);

      owner.fail(owner.capture(item.kind, 0), 10, EMPTY);

      const observed = owner.observeScan('scan', reason, 0n, 19n, 0);

      expect(observed.generation).toBe(item.generation);
      expect(observed.eligibleAt).toBeGreaterThan(10);
      expect(owner.scanTarget(item)).toBe(9n);

      const partial = owner.scanProgress(item, 5n, 100)!;

      expect(owner.scanTarget(partial)).toBe(9n);
      expect(partial.eligibleAt).toBe(0);
      expect(owner.scanProgress(item, 6n, 101)).toBeUndefined();

      const next = owner.scanProgress(partial, 10n, 200)!;

      expect(owner.scanTarget(next)).toBe(19n);
      expect(owner.scanProgress(next, 20n, 300)).toBeUndefined();
      expect(owner.nextDeadline(item.kind)).toBeNull();
    },
  );

  it('does not manufacture a scan continuation without progress', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const item = owner.observeScan('scan', 'durable-continuation', 5n, 9n, 0);

    owner.fail(owner.capture('full', 0), 10, EMPTY);

    expect(() => owner.scanProgress(item, 5n, 20)).toThrow();
    expect(() => owner.scanProgress(item, 11n, 20)).toThrow();
    expect(owner.get(item)?.eligibleAt).toBe(90_010);
  });

  it('separates immediate dispatch remainder from waiting even after a handoff', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const waiting = owner.observe('waiting', 'release', 0);

    const remainder = owner.observe('remainder', 'release', 0);

    const done = owner.observe('done', 'release', 0);

    owner.dispatchOutcome(waiting, 'waiting', 1, 100);
    owner.dispatchOutcome(remainder, 'remainder', 1, 100);
    owner.dispatchOutcome(done, 'completed', 1, 100);

    expect(owner.capture('full', 100).obligations).toEqual([
      { identity: remainder.identity, generation: remainder.generation },
    ]);
    expect(owner.get(waiting)?.eligibleAt).toBe(15_100);
    expect(owner.get(done)).toBeUndefined();
    expect(() => owner.dispatchOutcome(remainder, 'remainder', 0, 101)).toThrow();
  });

  it('a dispatch remainder does not erase an existing failure delay', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const item = owner.observe('release', 'release', 0);

    owner.fail(owner.capture('full', 0), 10, EMPTY);
    owner.dispatchOutcome(item, 'remainder', 1, 100);

    expect(owner.get(item)?.eligibleAt).toBe(90_010);
  });

  it('resets only a completed discovery obligation', () => {
    const owner = new DaemonWorkObligations(5_000, DEFERRED_CADENCE);

    const item = owner.observe('discovery', 'discovery', 0);

    owner.fail(owner.capture('discovery', 0), 100, EMPTY);

    expect(owner.get(item)?.eligibleAt).toBe(5_100);
    expect(owner.discoveryCompleted(item, 200)?.dueAt).toBe(5_200);
    expect(owner.discoveryCompleted(item, 300)).toBeUndefined();
  });
});

describe('partial settlement', () => {
  it('keeps dispatch outcomes separate from a failed durable scan', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);

    const waiting = owner.observe('waiting', 'release', 0);

    const remainder = owner.observe('remainder', 'release', 0);

    const scan = owner.observeScan('scan', 'durable-continuation', 0n, 9n, 0);

    owner.settle(owner.capture('full', 0), 100, EMPTY, [
      { reference: waiting, outcome: 'waiting', handedOff: 1 },
      { reference: remainder, outcome: 'remainder', handedOff: 1 },
    ]);

    expect(owner.get(waiting)?.eligibleAt).toBe(15_100);
    expect(owner.get(remainder)?.eligibleAt).toBe(0);
    expect(owner.get(scan)?.eligibleAt).toBe(90_100);
  });
});

describe('authoritative cursor replacement', () => {
  it('replaces a normalized soft range without erasing backoff or its fixed target', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);
    const old = owner.observeScan('soft', 'soft-continuation', 10n, 20n, 0);
    const captured = owner.capture('discovery', 0);

    owner.fail(captured, 100, EMPTY);
    owner.observeScan('soft', 'soft-continuation', 10n, 40n, 0);

    const next = owner.replaceScan(old, 'soft-normalization', 15n, 200)!;

    expect(owner.get(old)).toBeUndefined();
    expect(next.generation).not.toBe(old.generation);
    expect(next.eligibleAt).toBe(15_100);
    expect(owner.scanTarget(next)).toBe(20n);

    owner.fail(captured, 1_000, EMPTY);

    expect(owner.get(next)?.eligibleAt).toBe(15_100);
    expect(owner.replaceScan(old, 'soft-normalization', 18n, 300)).toBeUndefined();

    const promoted = owner.scanProgress(next, 21n, 16_000)!;

    expect(owner.scanTarget(promoted)).toBe(40n);
  });

  it('promotes a remembered target when normalization covers the active range', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);
    const old = owner.observeScan('soft', 'soft-continuation', 10n, 20n, 0);

    owner.observeScan('soft', 'soft-continuation', 10n, 40n, 0);
    owner.fail(owner.capture('discovery', 0), 100, EMPTY);

    const next = owner.replaceScan(old, 'soft-normalization', 25n, 200)!;

    expect(owner.scanTarget(next)).toBe(40n);
    expect(next.eligibleAt).toBe(15_100);
    expect(owner.replaceScan(next, 'soft-normalization', 41n, 300)).toBeUndefined();
    expect(owner.nextDeadline('discovery')).toBeNull();
  });

  it('allows an authoritative checkpoint reload to move backward with inherited eligibility', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);
    const old = owner.observeScan('durable', 'durable-continuation', 10n, 20n, 0);

    owner.fail(owner.capture('full', 0), 100, EMPTY);

    const next = owner.replaceScan(old, 'checkpoint-reload', 5n, 200)!;

    expect(next.eligibleAt).toBe(90_100);
    expect(owner.scanTarget(next)).toBe(20n);
    expect(owner.capture('full', 90_099).obligations).toEqual([]);
    expect(owner.capture('full', 90_100).obligations).toHaveLength(1);
  });

  it('rejects refreshes and mismatched reasons without changing the obligation', () => {
    const owner = new DaemonWorkObligations(15_000, DEFERRED_CADENCE);
    const old = owner.observeScan('soft', 'soft-continuation', 10n, 20n, 0);

    owner.fail(owner.capture('discovery', 0), 100, EMPTY);

    for (const nextBlock of [10n, 9n, -1n]) {
      expect(() => owner.replaceScan(old, 'soft-normalization', nextBlock, 200))
        .toThrow('Invalid scan cursor replacement');
    }

    expect(() => owner.replaceScan(old, 'checkpoint-reload', 15n, 200))
      .toThrow('Invalid scan cursor replacement');

    owner.observeScan('soft', 'soft-continuation', 10n, 15n, 200);

    expect(owner.get(old)?.eligibleAt).toBe(15_100);
    expect(owner.scanTarget(old)).toBe(20n);
  });
});

describe('injected inspection cadence', () => {
  it.each([
    { idleIntervalMs: 15_000, retainedIntervalMs: 15_000 },
    DEFERRED_CADENCE,
    { idleIntervalMs: 4_000, retainedIntervalMs: 2_000 },
  ])('uses $idleIntervalMs/$retainedIntervalMs for failure and inspection', (cadence) => {
    for (const retainedCount of [0, 1]) {
      const owner = new DaemonWorkObligations(15_000, cadence);

      const item = owner.observe('inspection', 'inspection', 0);

      let delay = cadence.idleIntervalMs;

      if (retainedCount > 0) {
        delay = cadence.retainedIntervalMs;
      }

      owner.fail(owner.capture('full', 0), 100, {
        ...EMPTY,
        retainedCount,
      });

      expect(owner.get(item)?.eligibleAt).toBe(100 + delay);
      expect(owner.inspection(item, {
        ...INSPECTION,
        retainedCount,
      })?.dueAt).toBe(INSPECTION.completedAt + delay);
    }
  });

  it('keeps discovery, released-work retry and waiting independent of inspection cadence', () => {
    const owner = new DaemonWorkObligations(120_000, {
      idleIntervalMs: 4_000,
      retainedIntervalMs: 2_000,
    });

    const discovery = owner.observe('discovery', 'discovery', 0);

    const release = owner.observe('release', 'release', 0);

    owner.fail(owner.capture('discovery', 0), 100, EMPTY);
    owner.fail(owner.capture('full', 0), 100, {
      retainedCount: 1,
      releasedBehindRecoveryClearableBlockers: true,
    });

    const waiting = owner.observe('waiting', 'release', 0);

    owner.waiting(waiting, 100);

    expect(owner.get(discovery)?.eligibleAt).toBe(120_100);
    expect(owner.get(release)?.eligibleAt).toBe(15_100);
    expect(owner.get(waiting)?.eligibleAt).toBe(15_100);
  });

  it('copies the policy so later caller mutation cannot change deadlines', () => {
    const cadence = { idleIntervalMs: 15_000, retainedIntervalMs: 15_000 };

    const owner = new DaemonWorkObligations(15_000, cadence);

    cadence.idleIntervalMs = 90_000;
    cadence.retainedIntervalMs = 30_000;

    const item = owner.observe('inspection', 'inspection', 0);

    owner.fail(owner.capture('full', 0), 100, EMPTY);

    expect(owner.get(item)?.eligibleAt).toBe(15_100);
    expect(owner.inspection(item, INSPECTION)?.dueAt).toBe(16_000);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid policy intervals: %s',
    (interval) => {
      expect(() => new DaemonWorkObligations(15_000, {
        idleIntervalMs: interval,
        retainedIntervalMs: 15_000,
      })).toThrow('Invalid obligation inspection cadence.');
      expect(() => new DaemonWorkObligations(15_000, {
        idleIntervalMs: 15_000,
        retainedIntervalMs: interval,
      })).toThrow('Invalid obligation inspection cadence.');
    },
  );
});
