import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  Hash,
} from 'viem';

import {
  readSignerRuntimeObservation,
  type SignerRuntimeObservationSource,
} from '../../src/state/read-signer-runtime-observation.js';

import type {
  SignerBlocker,
} from '../../src/state/signer-gate.js';

const FIRST_HASH: Hash = `0x${'aa'.repeat(32)}`;
const SECOND_HASH: Hash = `0x${'bb'.repeat(32)}`;
const THIRD_HASH: Hash = `0x${'cc'.repeat(32)}`;

const ATTEMPT_ID = '12345678-1234-4123-8123-123456789abc';
const WORK_ID = ' work:e\u0301 ';
const BLOCKED_SINCE = '2026-10-12T12:00:00.000Z';

function fixture() {
  const blockers: SignerBlocker[] = ['unresolved-attempt'];

  const transactionHashes: [Hash, ...Hash[]] = [
    FIRST_HASH,
    SECOND_HASH,
  ];

  const source = {
    journalInitialized: true,
    status: {
      open: false,
      primaryReason: 'unresolved-attempt' as const,
      blockers,
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle' as const,
      blockedSince: BLOCKED_SINCE,
      extra: 'status-private',
    },
    attempts: [{
      attemptId: ATTEMPT_ID,
      workId: WORK_ID,
      nonce: 4n,
      phase: 'signed' as const,
      transactionHashes,
      signedTransaction: 'signed-bytes-canary',
      extra: 'attempt-private',
    }],
    extra: 'root-private',
  };

  // Check structural compatibility after inference so the fixture can
  // include undeclared fields that the projection must exclude.
  source satisfies SignerRuntimeObservationSource;

  return {
    source,
    blockers,
    transactionHashes,
  };
}

describe('readSignerRuntimeObservation', () => {
  it('selects public fields and retains every candidate hash', () => {
    const { source } = fixture();

    const observation = readSignerRuntimeObservation(source);

    expect(observation).toEqual({
      journalInitialized: true,
      status: {
        open: false,
        primaryReason: 'unresolved-attempt',
        blockers: ['unresolved-attempt'],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
        blockedSince: BLOCKED_SINCE,
      },
      attempts: [{
        attemptId: ATTEMPT_ID,
        workId: WORK_ID,
        nonce: 4n,
        phase: 'signed',
        transactionHashes: [
          FIRST_HASH,
          SECOND_HASH,
        ],
      }],
    });

    // Projection must not delete or modify input fields.
    expect(source.extra).toBe('root-private');
    expect(source.status.extra).toBe('status-private');
    expect(source.attempts[0]!.signedTransaction)
      .toBe('signed-bytes-canary');
  });

  it('returns detached, deeply frozen public containers', () => {
    const {
      source,
      blockers,
      transactionHashes,
    } = fixture();

    const observation = readSignerRuntimeObservation(source);

    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.status)).toBe(true);
    expect(Object.isFrozen(observation.status.blockers)).toBe(true);
    expect(Object.isFrozen(observation.attempts)).toBe(true);
    expect(Object.isFrozen(observation.attempts[0])).toBe(true);
    expect(
      Object.isFrozen(observation.attempts[0]!.transactionHashes),
    ).toBe(true);

    expect(observation.status).not.toBe(source.status);
    expect(observation.attempts[0]).not.toBe(source.attempts[0]);

    blockers.push('journal-capacity-reached');
    transactionHashes.push(THIRD_HASH);
    source.attempts[0]!.nonce = 99n;
    source.attempts[0]!.workId = 'different-work';
    source.status.blockedSince = '2026-10-12T13:00:00.000Z';

    expect(observation.status.blockers)
      .toEqual(['unresolved-attempt']);
    expect(observation.status.blockedSince).toBe(BLOCKED_SINCE);
    expect(observation.attempts[0]!.nonce).toBe(4n);
    expect(observation.attempts[0]!.workId).toBe(WORK_ID);
    expect(observation.attempts[0]!.transactionHashes).toEqual([
      FIRST_HASH,
      SECOND_HASH,
    ]);

    // Reading must not freeze the source's own containers.
    expect(Object.isFrozen(source.status)).toBe(false);
    expect(Object.isFrozen(blockers)).toBe(false);
    expect(Object.isFrozen(transactionHashes)).toBe(false);
  });

  it('preserves missing-journal and incomplete-recovery state', () => {
    const source: SignerRuntimeObservationSource = {
      journalInitialized: false,
      status: {
        open: false,
        primaryReason: 'recovery-incomplete',
        blockers: ['recovery-incomplete'],
        recoveryComplete: false,
        inclusionChecksComplete: false,
        persistenceState: 'idle',
        blockedSince: BLOCKED_SINCE,
      },
      attempts: [],
    };

    expect(readSignerRuntimeObservation(source)).toEqual(source);
  });

  it('preserves a closed gate without inventing a blocker', () => {
    const source: SignerRuntimeObservationSource = {
      journalInitialized: true,
      status: {
        open: false,
        primaryReason: null,
        blockers: [],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'writing',
        blockedSince: null,
      },
      attempts: [],
    };

    expect(readSignerRuntimeObservation(source)).toEqual(source);
  });
});