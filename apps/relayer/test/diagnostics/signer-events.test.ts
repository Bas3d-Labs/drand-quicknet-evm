import { writeSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeSync: vi.fn(),
}));

const SIGNER = '0x1111111111111111111111111111111111111111';
const SINCE = '2026-10-04T00:00:00.000Z';
const SECRET = 'signer-event-canary';

function capture() {
  const lines: string[] = [];

  const log = createRelayerLog({
    chainId: 4663,
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  return { log, lines };
}

describe('signer event projection', () => {
  beforeEach(() => vi.mocked(writeSync).mockReset());

  it('projects fixed events and omits undeclared fields', () => {
    const { log, lines } = capture();

    const event = {
      signer: SIGNER as typeof SIGNER,
      reason: 'unresolved-attempt' as const,
      blockers: ['unresolved-attempt'] as const,
      blockedSince: SINCE,
      signedTransaction: SECRET,
    };

    log.signerBlocked(event);
    log.signerGateReleased({
      ...event,
      cleared: ['unresolved-attempt'],
    });

    const records = lines.map((line) => JSON.parse(line));

    expect(records[0]).toMatchObject({
      event: 'signer_blocked',
      level: 40,
      reason: 'unresolved-attempt',
      blockedSince: SINCE,
    });

    expect(records[1]).toMatchObject({
      event: 'signer_gate_released',
      level: 30,
      cleared: ['unresolved-attempt'],
    });

    expect(records[1]).not.toHaveProperty('blockers');
    expect(lines.join('')).not.toContain(SECRET);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: 'unresolved-attempt',
      blockers: ['persistence-failure', 'unresolved-attempt'],
    },
    {
      reason: 'unresolved-attempt',
      blockers: ['unresolved-attempt', 'unresolved-attempt'],
    },
    {
      reason: 'unresolved-attempt',
      blockers: ['unresolved-attempt', 'persistence-failure'],
    },
    {
      reason: 'unresolved-attempt',
      blockers: [],
    },
    {
      reason: SECRET,
      blockers: [SECRET],
    },
  ])('rejects invalid blockers %#', (input) => {
    const { log, lines } = capture();

    log.signerBlocked({
      signer: SIGNER,
      blockedSince: SINCE,
      ...input,
    } as never);

    expect(lines).toHaveLength(0);
    expect(writeSync).toHaveBeenCalledOnce();

    expect(JSON.stringify(vi.mocked(writeSync).mock.calls))
      .not.toContain(SECRET);
  });

  it('rejects accessors without invoking them', () => {
    const { log, lines } = capture();
    const get = vi.fn(() => SECRET);

    const event = {
      signer: SIGNER as typeof SIGNER,
      reason: 'unresolved-attempt' as const,
      blockers: ['unresolved-attempt'],
      blockedSince: SINCE,
    };

    Object.defineProperty(event.blockers, '0', { get });

    log.signerBlocked(event as never);

    expect(get).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);
    expect(writeSync).toHaveBeenCalledOnce();
  });

  it('rejects a noncanonical timestamp', () => {
    const { log, lines } = capture();

    log.signerGateReleased({
      signer: SIGNER,
      cleared: ['unresolved-attempt'],
      blockedSince: 'yesterday',
    });

    expect(lines).toHaveLength(0);
    expect(writeSync).toHaveBeenCalledOnce();
  });
});

describe('acknowledged search reset diagnostic', () => {
  it('projects boundary evidence and attribution without undeclared secrets', () => {
    const { log, lines } = capture();
    const hash = `0x${'aa'.repeat(32)}` as const;
    const observed = `0x${'bb'.repeat(32)}` as const;
    log.withContext({ cycle: 17 }).searchReset({
      signer: SIGNER,
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      reason: 'exhaustion-anchor-changed',
      expectedBlock: 100n,
      expectedBlockHash: hash,
      observedBlock: 100n,
      observedBlockHash: observed,
      durableBlock: 104n,
      durableBlockHash: hash,
      ...{ signedTransaction: SECRET },
    });

    expect(lines).toHaveLength(1);
    
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'signer_search_reset',
      level: 40,
      cycle: 17,
      reason: 'exhaustion-anchor-changed',
      nonce: '4',
      expectedBlock: '100',
      expectedBlockHash: hash,
      observedBlock: '100',
      observedBlockHash: observed,
      durableBlock: '104',
      durableBlockHash: hash,
    });

    expect(lines.join('')).not.toContain(SECRET);
    expect(JSON.parse(lines[0]!)).not.toHaveProperty('signedTransaction');
  });
});
