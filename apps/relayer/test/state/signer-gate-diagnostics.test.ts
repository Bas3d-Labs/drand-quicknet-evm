import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  SignerGateDiagnostics,
  type SignerGateDiagnostic,
} from '../../src/state/signer-gate-diagnostics.js';

import type {
  SignerGateDecision,
} from '../../src/state/signer-gate.js';

const START = '2026-11-03T09:00:00.000Z';

const RECOVERY_BLOCKED: SignerGateDecision = {
  open: false,
  primaryReason: 'recovery-incomplete',
  blockers: ['recovery-incomplete'],
};

const OPEN: SignerGateDecision = {
  open: true,
  primaryReason: null,
  blockers: [],
};

describe('signer gate diagnostics', () => {
  it('suppresses unchanged blockers and preserves the episode timestamp', () => {
    const timestamp = vi.fn(() => START);
    const diagnostics = new SignerGateDiagnostics(timestamp);
    const publish = vi.fn();

    diagnostics.observe(RECOVERY_BLOCKED, publish);
    diagnostics.observe(RECOVERY_BLOCKED, publish);

    expect(timestamp).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      kind: 'blocked',
      reason: 'recovery-incomplete',
      blockers: ['recovery-incomplete'],
      blockedSince: START,
    });
    expect(diagnostics.blockedSince).toBe(START);
  });

  it('reports blocker changes and releases all episode reasons in precedence order', () => {
    const diagnostics = new SignerGateDiagnostics(() => START);
    const events: SignerGateDiagnostic[] = [];
    const publish = (event: SignerGateDiagnostic) => {
      events.push(event);
    };

    diagnostics.observe(RECOVERY_BLOCKED, publish);

    diagnostics.observe({
      open: false,
      primaryReason: 'persistence-failure',
      blockers: ['persistence-failure', 'recovery-incomplete'],
    }, publish);

    diagnostics.observe(RECOVERY_BLOCKED, publish);
    diagnostics.observe(OPEN, publish);

    expect(events.map((event) => event.kind)).toEqual([
      'blocked',
      'blocked',
      'blocked',
      'released',
    ]);
    expect(events[3]).toEqual({
      kind: 'released',
      cleared: ['persistence-failure', 'recovery-incomplete'],
      blockedSince: START,
    });
    expect(diagnostics.blockedSince).toBeNull();
  });

  it('waits for an open gate even when no blockers remain', () => {
    const diagnostics = new SignerGateDiagnostics(() => START);
    const publish = vi.fn();

    diagnostics.observe(RECOVERY_BLOCKED, publish);

    diagnostics.observe({
      open: false,
      primaryReason: null,
      blockers: [],
    }, publish);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(diagnostics.blockedSince).toBe(START);

    diagnostics.observe(OPEN, publish);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({
      kind: 'released',
      cleared: ['recovery-incomplete'],
      blockedSince: START,
    });
  });

  it('preserves a seeded timestamp during publication and resets the next episode', () => {
    const timestamp = vi.fn(() => START);
    const diagnostics = new SignerGateDiagnostics(timestamp);
    const seeded = '2026-11-03T08:00:00.000Z';

    diagnostics.blockedSince = seeded;

    diagnostics.observe(RECOVERY_BLOCKED, () => {});
    expect(timestamp).not.toHaveBeenCalled();

    diagnostics.observe(OPEN, (event) => {
      expect(event).toEqual({
        kind: 'released',
        cleared: ['recovery-incomplete'],
        blockedSince: seeded,
      });
      expect(diagnostics.blockedSince).toBe(seeded);
    });

    expect(diagnostics.blockedSince).toBeNull();

    const publish = vi.fn();

    diagnostics.observe({
      open: false,
      primaryReason: 'retention-capacity-reached',
      blockers: ['retention-capacity-reached'],
    }, publish);

    diagnostics.observe(OPEN, publish);

    expect(timestamp).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith({
      kind: 'released',
      cleared: ['retention-capacity-reached'],
      blockedSince: START,
    });
  });
});