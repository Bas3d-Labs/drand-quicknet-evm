import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  renderJournalStatusOutput,
} from '../../src/cli/journal-status-output.js';

const SIGNER = `0x${'ab'.repeat(20)}`;
const HASH = `0x${'aa'.repeat(32)}`;
const SECOND_HASH = `0x${'bb'.repeat(32)}`;
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const WORK_ID = ' work:e\u0301 ';
const AT = '2026-10-12T12:00:00.000Z';
const SECRET = 'signed-bytes-canary';

function observation(nonce = '8') {
  return {
    anchor: {
      blockNumber: '110',
      blockHash: HASH,
    },
    nonce,
  };
}

function status() {
  return {
    source: 'journal',
    journal: 'present',
    gate: 'unknown',
    identity: {
      chainId: 4663,
      signer: SIGNER,
    },
    baseline: observation('4'),
    lastObservation: observation(),
    nextNonce: '9',
    durableNextNonce: '8',
    attempts: [{
      attemptId: ATTEMPT_ID,
      workId: WORK_ID,
      nonce: '8',
      createdAt: AT,
      phase: 'signed',
      transactionHashes: [HASH, SECOND_HASH],
    }],
    repairs: [{
      kind: 'sync-nonce',
      at: AT,
      previousNextNonce: '4',
      nextNonce: '8',
      observation: observation(),
    }],
  };
}

describe('renderJournalStatusOutput', () => {
  it('reports a missing journal without claiming readiness', () => {
    expect(renderJournalStatusOutput({
      source: 'journal',
      journal: 'missing',
      gate: 'unknown',
    })).toBe([
      'Status source: journal',
      'Current signing authorization: unknown',
      'Journal: missing',
      'A missing journal does not establish signer readiness.',
    ].join('\n'));
  });

  it('renders allocation, observations, all candidate hashes, and repairs', () => {
    const output = renderJournalStatusOutput(status());

    expect(output).toContain('Chain ID: 4663');
    expect(output).toContain('Signer: ' + SIGNER);
    expect(output).toContain('Next nonce: 9');
    expect(output).toContain('Durable next nonce: 8');
    expect(output).toContain('Baseline nonce: 4');
    expect(output).toContain('Last accepted observation nonce: 8');
    expect(output).toContain('Retained attempts: 1');
    expect(output).toContain('Attempt: ' + ATTEMPT_ID);
    expect(output.split('\n')).toContain('    Work identity: ' + WORK_ID);
    expect(output).toContain('Created at: ' + AT);
    expect(output).toContain('Phase: signed');
    expect(output).toContain('      ' + HASH);
    expect(output).toContain('      ' + SECOND_HASH);
    expect(output).toContain('Retained nonce repairs: 1');
    expect(output).toContain('Previous next nonce: 4');
    expect(output).toContain('Accepted observation block: 110');
    expect(output).toContain('Current signing authorization: unknown');
  });

  it('renders an empty journal without inferring an open gate', () => {
    const output = renderJournalStatusOutput({
      ...status(),
      attempts: [],
      repairs: [],
    });

    expect(output).toContain('Retained attempts: 0');
    expect(output).toContain('Retained nonce repairs: 0');
    expect(output).toContain('Current signing authorization: unknown');
  });

  it('ignores signed bytes, undeclared fields, and serialization hooks', () => {
    const input = status();
    const before = structuredClone(input);
    const toJSON = vi.fn(() => SECRET);
    const getter = vi.fn(() => SECRET);

    Object.assign(input, {
      signedTransaction: SECRET,
      toJSON,
    });

    Object.assign(input.attempts[0]!, {
      signedTransaction: SECRET,
      extra: SECRET,
    });

    Object.assign(input.repairs[0]!, {
      extra: SECRET,
    });

    Object.defineProperty(input, 'extra', { get: getter });

    const output = renderJournalStatusOutput(input);

    expect(output).not.toContain(SECRET);
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(input).toMatchObject(before);
  });

  it.each([
    'signed',
    'broadcast-may-have-occurred',
    'included',
  ])('accepts phase %s', (phase) => {
    const input = status();
    input.attempts[0]!.phase = phase;

    expect(renderJournalStatusOutput(input))
      .toContain('Phase: ' + phase);
  });

  it.each([
    '',
    '-1',
    '01',
    '1.5',
    '0x10',
    ' 8',
    ((1n << 256n)).toString(),
  ])('rejects invalid decimal %j', (nextNonce) => {
    expect(() => renderJournalStatusOutput({
      ...status(),
      nextNonce,
    })).toThrow('Invalid journal status output.');
  });

  it.each([
    { source: 'unknown' },
    { journal: 'unknown' },
    { gate: 'open' },
    { identity: { chainId: 0, signer: SIGNER } },
    { identity: { chainId: 4663, signer: SECRET } },
    { baseline: { ...observation(), anchor: null } },
    { attempts: [null] },
    { repairs: [null] },
  ])('rejects malformed public fields: %j', (patch) => {
    expect(() => renderJournalStatusOutput({
      ...status(),
      ...patch,
    })).toThrow('Invalid journal status output.');
  });

  it.each([
    { attemptId: SECRET },
    { workId: undefined },
    { workId: null },
    { workId: 42 },
    { workId: '' },
    { workId: 'x'.repeat(257) },
    { workId: 'work\nforged' },
    { workId: 'work\u0085forged' },
    { phase: SECRET },
    { createdAt: '2026-10-12T12:00:00Z' },
    { transactionHashes: [] },
    { transactionHashes: [HASH, SECRET] },
  ])('rejects malformed attempt fields: %j', (patch) => {
    const input = status();

    expect(() => renderJournalStatusOutput({
      ...input,
      attempts: [{ ...input.attempts[0], ...patch }],
    })).toThrow('Invalid journal status output.');
  });

  it.each([
    { kind: SECRET },
    { at: SECRET },
    { nextNonce: '4' },
    { observation: observation('9') },
  ])('rejects malformed repair fields: %j', (patch) => {
    const input = status();

    expect(() => renderJournalStatusOutput({
      ...input,
      repairs: [{ ...input.repairs[0], ...patch }],
    })).toThrow('Invalid journal status output.');
  });

  it('accepts a work identity at the maximum length', () => {
    const input = status();
    const workId = 'x'.repeat(256);
    input.attempts[0]!.workId = workId;

    expect(renderJournalStatusOutput(input).split('\n'))
      .toContain('    Work identity: ' + workId);
  });

  it('rejects a missing work identity', () => {
    const input = status();
    Reflect.deleteProperty(input.attempts[0]!, 'workId');

    expect(() => renderJournalStatusOutput(input))
      .toThrow('Invalid journal status output.');
  });

  it('rejects a work identity getter without invoking it', () => {
    const input = status();
    const getter = vi.fn(() => WORK_ID);

    Object.defineProperty(input.attempts[0]!, 'workId', {
      get: getter,
    });

    expect(() => renderJournalStatusOutput(input))
      .toThrow('Invalid journal status output.');

    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects an inherited work identity', () => {
    const input = status();
    const attempt = input.attempts[0]!;

    Object.setPrototypeOf(attempt, { workId: WORK_ID });
    Reflect.deleteProperty(attempt, 'workId');

    expect(() => renderJournalStatusOutput(input))
      .toThrow('Invalid journal status output.');
  });

  it('rejects a displayed getter without invoking it', () => {
    const input = status();
    const getter = vi.fn(() => SECRET);

    Object.defineProperty(input.identity, 'signer', {
      get: getter,
    });

    expect(() => renderJournalStatusOutput(input))
      .toThrow('Invalid journal status output.');

    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects inherited displayed fields', () => {
    const input = status();

    Object.setPrototypeOf(input.identity, { signer: SIGNER });
    Reflect.deleteProperty(input.identity, 'signer');

    expect(() => renderJournalStatusOutput(input))
      .toThrow('Invalid journal status output.');
  });

  it('rejects sparse attempt arrays', () => {
    expect(() => renderJournalStatusOutput({
      ...status(),
      attempts: new Array(1),
    })).toThrow('Invalid journal status output.');
  });
});