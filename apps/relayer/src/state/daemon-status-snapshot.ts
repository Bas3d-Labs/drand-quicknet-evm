import type {
  Hash,
} from 'viem';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

import type {
  JournalPersistenceState,
} from './journal-persistence.js';

import {
  BLOCKER_PRECEDENCE,
  type SignerBlocker,
} from './signer-gate.js';

import type {
  JournalAttempt,
  JournalIdentity,
} from './transaction-journal.js';

export interface DaemonStatusAttempt {
  readonly attemptId: string;

  /** Canonical unsigned decimal representation. */
  readonly nonce: string;

  readonly phase: JournalAttempt['phase'];

  /** Original transaction hash followed by fee replacement hashes. */
  readonly transactionHashes: readonly [Hash, ...Hash[]];
}

export interface DaemonStatusSnapshot {
  readonly version: 1;
  readonly identity: JournalIdentity;
  readonly runId: string;
  readonly observedAt: string;
  readonly journalInitialized: boolean;
  readonly attempts: readonly DaemonStatusAttempt[];
  readonly lastObservedGate: {
    readonly open: boolean;
    readonly primaryReason: SignerBlocker | null;
    readonly blockers: readonly SignerBlocker[];
    readonly recoveryComplete: boolean;
    readonly inclusionChecksComplete: boolean;
    readonly persistenceState: JournalPersistenceState;

    /**
     * Coordinator-reported start of its blocking episode.
     * May originate from a retained attempt's creation time on restart.
     * A primary-blocker change does not itself reset it.
     */
    readonly blockedSince: string | null;
  };
}

export type SnapshotAge =
  | {
      readonly status: 'fresh' | 'stale';
      readonly ageMs: number;
    }
  | {
      readonly status: 'clock-skew';
      readonly ageMs: null;
    };

const INVALID = 'Invalid daemon status snapshot.';

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Validates and projects public snapshot fields.
 */
export function readDaemonStatusSnapshot(
  input: unknown,
  expectedIdentity: JournalIdentity,
): DaemonStatusSnapshot {
  requireIdentity(expectedIdentity);

  const root = object(input);
  const identity = object(root.identity);
  const gate = object(root.lastObservedGate);

  if (
    root.version !== 1 ||
    identity.chainId !== expectedIdentity.chainId ||
    !isFixedHex(identity.signer, 20) ||
    (identity.signer as string).toLowerCase() !==
      expectedIdentity.signer.toLowerCase() ||
    !isUuidV4(root.runId) ||
    typeof root.journalInitialized !== 'boolean' ||
    typeof gate.open !== 'boolean' ||
    typeof gate.recoveryComplete !== 'boolean' ||
    typeof gate.inclusionChecksComplete !== 'boolean'
  ) {
    throw new TypeError(INVALID);
  }

  readTimestamp(root.observedAt);

  const persistenceState = readPersistenceState(
    gate.persistenceState,
  );

  const blockedSince = readNullableTimestamp(
    gate.blockedSince,
  );

  if (
    !Array.isArray(gate.blockers) ||
    gate.blockers.length > BLOCKER_PRECEDENCE.length
  ) {
    throw new TypeError(INVALID);
  }

  const blockers = gate.blockers.map(readBlocker);

  if (
    new Set(blockers).size !== blockers.length ||
    gate.primaryReason !== (blockers[0] ?? null)
  ) {
    throw new TypeError(INVALID);
  }

  if (
    gate.open &&
    (
      blockers.length !== 0 ||
      !root.journalInitialized ||
      !gate.recoveryComplete ||
      !gate.inclusionChecksComplete ||
      persistenceState !== 'idle'
    )
  ) {
    throw new TypeError(INVALID);
  }

  const attempts = readAttempts(root.attempts);

  if (!root.journalInitialized && attempts.length !== 0) {
    throw new TypeError(INVALID);
  }

  // A closed gate without reported blockers is valid.
  // These fields alone do not establish why the gate is closed.
  return Object.freeze({
    version: 1,
    identity: Object.freeze({
      chainId: expectedIdentity.chainId,
      signer: expectedIdentity.signer,
    }),
    runId: root.runId,
    observedAt: root.observedAt as string,
    journalInitialized: root.journalInitialized,
    attempts,
    lastObservedGate: Object.freeze({
      open: gate.open,
      primaryReason: blockers[0] ?? null,
      blockers: Object.freeze(blockers),
      recoveryComplete: gate.recoveryComplete,
      inclusionChecksComplete: gate.inclusionChecksComplete,
      persistenceState,
      blockedSince,
    }),
  });
}

/**
 * Classifies timestamp age only, not daemon health.
 * 
 * maxAgeMs is supplied by the caller so the publication policy can
 * choose its threshold explicitly.
 */
export function classifySnapshotAge(
  observedAt: string,
  nowMs: number,
  maxAgeMs: number,
): SnapshotAge {
  const observedMs = readTimestamp(observedAt);

  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isFinite(new Date(nowMs).getTime()) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs <= 0
  ) {
    throw new TypeError('Invalid snapshot age parameters.');
  }

  const ageMs = nowMs - observedMs;

  if (!Number.isSafeInteger(ageMs)) {
    throw new TypeError('Invalid snapshot age parameters.');
  }

  if (ageMs < 0) {
    return {
      status: 'clock-skew',
      ageMs: null,
    };
  }

  return {
    status: ageMs <= maxAgeMs ? 'fresh' : 'stale',
    ageMs,
  };
}

function requireIdentity(identity: JournalIdentity): void {
  if (
    !Number.isSafeInteger(identity.chainId) ||
    identity.chainId <= 0 ||
    !isFixedHex(identity.signer, 20)
  ) {
    throw new TypeError('Invalid journal identity.');
  }
}

function object(input: unknown): Record<string, unknown> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new TypeError(INVALID);
  }

  return input as Record<string, unknown>;
}

function readBlocker(input: unknown): SignerBlocker {
  for (const blocker of BLOCKER_PRECEDENCE) {
    if (input === blocker) {
      return blocker;
    }
  }

  throw new TypeError(INVALID);
}

function readAttempts(
  input: unknown,
): readonly DaemonStatusAttempt[] {
  if (!Array.isArray(input)) {
    throw new TypeError(INVALID);
  }

  const attemptIds = new Set<string>();
  const attempts: DaemonStatusAttempt[] = [];
  let previousNonce: bigint | undefined;

  for (const item of input) {
    const attempt = readAttempt(item);
    const nonce = BigInt(attempt.nonce);

    if (
      attemptIds.has(attempt.attemptId) ||
      (previousNonce !== undefined && nonce <= previousNonce)
    ) {
      throw new TypeError(INVALID);
    }

    attemptIds.add(attempt.attemptId);
    previousNonce = nonce;
    attempts.push(attempt);
  }

  return Object.freeze(attempts);
}

function readAttempt(
  input: unknown,
): DaemonStatusAttempt {
  const value = object(input);

  if (!isUuidV4(value.attemptId)) {
    throw new TypeError(INVALID);
  }

  return Object.freeze({
    attemptId: value.attemptId,
    nonce: readNonce(value.nonce),
    phase: readAttemptPhase(value.phase),
    transactionHashes: readTransactionHashes(value.transactionHashes),
  });
}

function readNonce(
  input: unknown,
): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > 78 ||
    !isDecimalInteger(input) ||
    (input.length > 1 && input[0] === '0') ||
    BigInt(input) > MAX_UINT256
  ) {
    throw new TypeError(INVALID);
  }

  return input;
}

function readAttemptPhase(
  input: unknown,
): JournalAttempt['phase'] {
  switch (input) {
    case 'signed':
    case 'broadcast-may-have-occurred':
    case 'included':
      return input;

    default:
      throw new TypeError(INVALID);
  }
}

function readTransactionHashes(
  input: unknown,
): readonly [Hash, ...Hash[]] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(INVALID);
  }

  const seen = new Set<string>();

  function readHash(value: unknown): Hash {
    if (!isFixedHex(value, 32)) {
      throw new TypeError(INVALID);
    }

    const hash = value as Hash;
    const normalized = hash.toLowerCase();

    if (seen.has(normalized)) {
      throw new TypeError(INVALID);
    }

    seen.add(normalized);
    return hash;
  }

  const first = readHash(input[0]);
  const remaining: Hash[] = [];

  for (let index = 1; index < input.length; index += 1) {
    remaining.push(readHash(input[index]));
  }

  const hashes: [Hash, ...Hash[]] = [first, ...remaining];

  return Object.freeze(hashes);
}

function readPersistenceState(
  input: unknown,
): JournalPersistenceState {
  switch (input) {
    case 'idle':
    case 'writing':
    case 'failed':
      return input;

    default:
      throw new TypeError(INVALID);
  }
}

function readNullableTimestamp(
  input: unknown,
): string | null {
  if (input === null) {
    return null;
  }

  readTimestamp(input);
  return input as string;
}

function readTimestamp(input: unknown): number {
  if (typeof input !== 'string') {
    throw new TypeError(INVALID);
  }

  const milliseconds = Date.parse(input);

  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== input
  ) {
    throw new TypeError(INVALID);
  }

  return milliseconds;
}