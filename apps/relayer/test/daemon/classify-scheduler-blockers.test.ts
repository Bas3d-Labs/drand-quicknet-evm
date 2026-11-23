import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  classifySchedulerBlockers,
  SCHEDULER_BLOCKER_CLASSES,
} from '../../src/daemon/classify-scheduler-blockers.js';

import {
  BLOCKER_PRECEDENCE,
} from '../../src/state/signer-gate.js';

describe('scheduler blocker classification', () => {
  it('covers exactly the six production blockers', () => {
    expect(Object.keys(SCHEDULER_BLOCKER_CLASSES).sort())
      .toEqual([...BLOCKER_PRECEDENCE].sort());
  });

  it.each([
    ['recovery-incomplete', 'recovery-clearable'],
    ['unresolved-attempt', 'recovery-clearable'],
    ['unattributed-signer-activity', 'operator-only'],
    ['persistence-failure', 'recovery-clearable'],
    ['conflict-search-exhausted', 'unknown'],
    ['retention-capacity-reached', 'recovery-clearable'],
    ['future-blocker', 'unknown'],
    ['toString', 'unknown'],
  ])('classifies %s as %s', (blocker, classification) => {
    expect(classifySchedulerBlockers([blocker])).toEqual({
      classifications: [{ blocker, classification }],
      recoveryClearableOnly: classification === 'recovery-clearable',
    });
  });

  it('requires a nonempty set with every blocker recovery-clearable', () => {
    expect(classifySchedulerBlockers([]).recoveryClearableOnly).toBe(false);
    expect(classifySchedulerBlockers([
      'recovery-incomplete',
      'persistence-failure',
    ]).recoveryClearableOnly).toBe(true);

    for (const blocker of [
      'unattributed-signer-activity',
      'conflict-search-exhausted',
      'future-blocker',
    ]) {
      expect(classifySchedulerBlockers([
        'persistence-failure',
        blocker,
      ]).recoveryClearableOnly).toBe(false);
    }
  });
});
