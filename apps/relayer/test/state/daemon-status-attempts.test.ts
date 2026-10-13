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

const FIRST_HASH: Hash = `0x${'aa'.repeat(32)}`;
const SECOND_HASH: Hash = `0x${'bb'.repeat(32)}`;
const THIRD_HASH: Hash = `0x${'cc'.repeat(32)}`;

function attempt(): DaemonStatusAttempt {
  return {
    attemptId: FIRST_ID,
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

  it('rejects duplicate attempt IDs', () => {
    expect(() => readAttempts([
      attempt(),
      {
        ...attempt(),
        nonce: '5',
        transactionHashes: [THIRD_HASH],
      },
    ])).toThrow('Invalid daemon status snapshot.');
  });

  it.each(['4', '3'])(
    'rejects a non-increasing second nonce: %s',
    (nonce) => {
      expect(() => readAttempts([
        attempt(),
        {
          ...attempt(),
          attemptId: SECOND_ID,
          nonce,
          transactionHashes: [THIRD_HASH],
        },
      ])).toThrow('Invalid daemon status snapshot.');
    },
  );

  it('compares nonce ordering numerically rather than lexically', () => {
    const attempts = [
      { ...attempt(), nonce: '9' },
      {
        ...attempt(),
        attemptId: SECOND_ID,
        nonce: '10',
        transactionHashes: [THIRD_HASH],
      },
    ];

    expect(readAttempts(attempts).attempts).toEqual(attempts);
  });
});