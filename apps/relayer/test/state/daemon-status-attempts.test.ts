import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  Hash,
} from 'viem';

import {
  readDaemonStatusSnapshot,
  type DaemonStatusAttempt,
  type DaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

const WORK_ID = ' work:e\u0301 ';
const OTHER_WORK_ID = 'other-work';

const FIRST_HASH: Hash = `0x${'aa'.repeat(32)}`;
const SECOND_HASH: Hash = `0x${'bb'.repeat(32)}`;
const THIRD_HASH: Hash = `0x${'cc'.repeat(32)}`;

function attempt(): DaemonStatusAttempt {
  return {
    attemptId: FIRST_ID,
    workId: WORK_ID,
    nonce: '4',
    phase: 'broadcast-may-have-occurred',
    transactionHashes: [FIRST_HASH, SECOND_HASH],
  };
}

function snapshot(): DaemonStatusSnapshot {
  return {
    version: 1,
    identity: IDENTITY,
    runId: '33333333-3333-4333-8333-333333333333',
    observedAt: '2026-10-12T12:00:00.000Z',
    journalInitialized: true,
    attempts: [attempt()],
    lastCompletedCycle: null,
    lastRetryObservation: null,
    lastObservedGate: {
      open: false,
      primaryReason: 'unresolved-attempt',
      blockers: ['unresolved-attempt'],
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle',
      blockedSince: '2026-10-12T11:59:00.000Z',
    },
  };
}

function readAttempts(attempts: unknown) {
  return readDaemonStatusSnapshot({
    ...snapshot(),
    attempts,
  }, IDENTITY);
}

describe('daemon status retained attempts', () => {
  it('projects every candidate hash without signed bytes or extra fields', () => {
    const source = {
      ...attempt(),
      signedTransaction: 'signed-bytes-canary',
      signedTransactions: [{
        signedTransaction: 'nested-signed-bytes-canary',
      }],
      extra: 'private-field-canary',
    };

    const result = readAttempts([source]);

    expect(result.attempts).toEqual([attempt()]);
    expect(JSON.stringify(result)).not.toContain('canary');

    expect(source.signedTransaction).toBe('signed-bytes-canary');
    expect(source.extra).toBe('private-field-canary');
  });

  it('detaches and freezes attempt records and hash arrays', () => {
    const hashes: [Hash, ...Hash[]] = [FIRST_HASH, SECOND_HASH];
    const source = {
      ...attempt(),
      transactionHashes: hashes,
    };
    const attempts = [source];

    const result = readAttempts(attempts);

    expect(Object.isFrozen(result.attempts)).toBe(true);
    expect(Object.isFrozen(result.attempts[0])).toBe(true);
    expect(Object.isFrozen(result.attempts[0]!.transactionHashes))
      .toBe(true);

    source.nonce = '99';
    source.workId = OTHER_WORK_ID;
    hashes.push(THIRD_HASH);
    attempts.length = 0;

    expect(result.attempts).toEqual([attempt()]);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(hashes)).toBe(false);
  });

  it.each([
    'signed',
    'broadcast-may-have-occurred',
    'included',
  ] as const)('preserves phase %s', (phase) => {
    const result = readAttempts([{ ...attempt(), phase }]);

    expect(result.attempts[0]!.phase).toBe(phase);
  });

  it.each([
    '0',
    '9007199254740993',
    ((1n << 256n) - 1n).toString(),
  ])('preserves canonical nonce %s without numeric conversion', (nonce) => {
    const result = readAttempts([{ ...attempt(), nonce }]);

    expect(result.attempts[0]!.nonce).toBe(nonce);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it.each([
    '',
    '00',
    '04',
    '-1',
    '1.5',
    '0x4',
    ' 4 ',
    '1e3',
    (1n << 256n).toString(),
    4,
    4n,
    null,
  ])('rejects invalid nonce %s', (nonce) => {
    expect(() => readAttempts([{ ...attempt(), nonce }]))
      .toThrow('Invalid daemon status snapshot.');
  });

  it.each([
    { attemptId: 'invalid' },
    { workId: undefined },
    { workId: null },
    { workId: 42 },
    { workId: '' },
    { workId: 'x'.repeat(257) },
    { workId: 'work\nforged' },
    { workId: 'work\u0085forged' },
    { workId: 'work:\ud800' },
    { workId: 'work:\udc00' },
    { phase: 'confirmed' },
    { transactionHashes: [] },
    { transactionHashes: ['0x1234'] },
    { transactionHashes: [FIRST_HASH, FIRST_HASH] },
    {
      transactionHashes: [
        FIRST_HASH,
        `0x${'AA'.repeat(32)}`,
      ],
    },
  ])('rejects malformed attempt fields: %j', (patch) => {
    expect(() => readAttempts([{ ...attempt(), ...patch }]))
      .toThrow('Invalid daemon status snapshot.');
  });

  it.each([undefined, null, {}])(
    'rejects a missing or non-array attempt list: %j',
    (attempts) => {
      expect(() => readAttempts(attempts))
        .toThrow('Invalid daemon status snapshot.');
    },
  );

  it('accepts an empty attempt list', () => {
    expect(readAttempts([]).attempts).toEqual([]);
  });

  it('rejects retained attempts without an initialized journal', () => {
    expect(() => readDaemonStatusSnapshot({
      ...snapshot(),
      journalInitialized: false,
    }, IDENTITY)).toThrow('Invalid daemon status snapshot.');
  });

  it('rejects a missing work identity', () => {
    const source = { ...attempt() };
    Reflect.deleteProperty(source, 'workId');

    expect(() => readAttempts([source]))
      .toThrow('Invalid daemon status snapshot.');
  });

  it('accepts a work identity at the maximum length', () => {
    const workId = 'x'.repeat(256);

    const result = readAttempts([{ ...attempt(), workId }]);

    expect(result.attempts[0]!.workId).toBe(workId);
  });

  it.each([
    { name: 'case', first: 'work:A', second: 'work:a' },
    { name: 'spacing', first: 'work:a', second: ' work:a ' },
    {
      name: 'Unicode representation',
      first: 'work:\u00e9',
      second: 'work:e\u0301',
    },
  ])(
    'preserves work identity differences in $name across snapshots',
    ({ first, second }) => {
      const firstResult = readAttempts([
        { ...attempt(), workId: first },
      ]);

      const secondResult = readAttempts([
        { ...attempt(), workId: second },
      ]);

      expect(firstResult.attempts[0]!.workId).toBe(first);
      expect(secondResult.attempts[0]!.workId).toBe(second);
      expect(firstResult.attempts[0]!.workId)
        .not.toBe(secondResult.attempts[0]!.workId);
    },
  );

  it.each([
    'signed',
    'broadcast-may-have-occurred',
    'included',
  ] as const)(
    'rejects two otherwise valid retained attempts in phase %s',
    (phase) => {
      const first: DaemonStatusAttempt = {
        ...attempt(),
        phase,
      };

      const second: DaemonStatusAttempt = {
        ...attempt(),
        attemptId: SECOND_ID,
        workId: OTHER_WORK_ID,
        nonce: '5',
        phase,
        transactionHashes: [THIRD_HASH],
      };

      // Each row is valid independently; their combined count is unsupported.
      expect(readAttempts([first]).attempts).toEqual([first]);
      expect(readAttempts([second]).attempts).toEqual([second]);

      expect(() => readAttempts([first, second]))
        .toThrow('Invalid daemon status snapshot.');
    },
  );
});