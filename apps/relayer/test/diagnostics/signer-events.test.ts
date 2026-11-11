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

describe('acknowledged lower-bound replacement diagnostic', () => {
  beforeEach(() => vi.mocked(writeSync).mockReset());

  const hash = `0x${'aa'.repeat(32)}` as const;
  const observed = `0x${'bb'.repeat(32)}` as const;
  const base = {
    signer: SIGNER as typeof SIGNER,
    attemptId: '11111111-1111-4111-8111-111111111111',
    nonce: 4n,
    oldLowerBlock: 100n,
    oldLowerBlockHash: hash,
    oldLowerNonce: 4n,
    observedLowerBlock: 100n,
    observedLowerBlockHash: observed,
    replacementBlock: 99n,
    replacementBlockHash: hash,
    replacementNonce: 3n,
    durableBlock: 125n,
    durableBlockHash: hash,
    durableNonce: 6n,
    probeCount: 2n,
    invalidatedFact: null,
  };

  it.each([false, true])('projects only declared evidence, with invalidated fact: %s', (withFact) => {
    const { log, lines } = capture();
    let invalidatedFact = null;
    if (withFact) {
      invalidatedFact = {
        expectedBlock: 120n,
        expectedBlockHash: hash,
        observedBlock: 120n,
        observedBlockHash: observed,
        ...{ signedTransaction: SECRET },
      };
    }
    log.withContext({ cycle: 18 }).searchLowerBoundReplaced({
      ...base,
      invalidatedFact,
      ...{ signedTransaction: SECRET },
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      event: 'signer_search_lower_bound_replaced',
      level: 40,
      cycle: 18,
      nonce: '4',
      oldLowerBlock: '100',
      oldLowerBlockHash: hash,
      oldLowerNonce: '4',
      observedLowerBlock: '100',
      observedLowerBlockHash: observed,
      replacementBlock: '99',
      replacementBlockHash: hash,
      replacementNonce: '3',
      durableBlock: '125',
      durableBlockHash: hash,
      durableNonce: '6',
      probeCount: '2',
    });
    if (withFact) {
      expect(record.invalidatedFact).toEqual({
        expectedBlock: '120',
        expectedBlockHash: hash,
        observedBlock: '120',
        observedBlockHash: observed,
      });
    } else {
      expect(record.invalidatedFact).toBeNull();
    }
    expect(record).not.toHaveProperty('signedTransaction');
    expect(lines.join('')).not.toContain(SECRET);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'negative nonce', patch: { replacementNonce: -1n } },
    { name: 'numeric count', patch: { probeCount: 2 } },
    { name: 'malformed hash', patch: { oldLowerBlockHash: '0xaa' } },
    { name: 'missing fact fields', patch: { invalidatedFact: {} } },
    { name: 'malformed fact anchor', patch: { invalidatedFact: {
      expectedBlock: 120n,
      expectedBlockHash: hash,
      observedBlock: 120n,
      observedBlockHash: '0xbb',
    } } },
  ])('rejects $name without exposing the payload', ({ patch }) => {
    const { log, lines } = capture();
    log.searchLowerBoundReplaced({ ...base, ...patch } as never);
    expect(lines).toEqual([]);
    expect(writeSync).toHaveBeenCalledOnce();
  });

  it('rejects an accessor in invalidation evidence without invoking it', () => {
    const { log, lines } = capture();
    const getter = vi.fn(() => 120n);
    const invalidatedFact = {
      expectedBlockHash: hash,
      observedBlock: 120n,
      observedBlockHash: observed,
    };
    Object.defineProperty(invalidatedFact, 'expectedBlock', { get: getter });
    log.searchLowerBoundReplaced({ ...base, invalidatedFact } as never);
    expect(getter).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
    expect(writeSync).toHaveBeenCalledOnce();
  });
});
