import type {
  DaemonStatusAttempt,
} from './daemon-status-snapshot.js';

type Hashes = DaemonStatusAttempt['transactionHashes'];

/**
 * Maximum full attempt records included in a daemon status snapshot.
 */
export const MAX_DAEMON_STATUS_ATTEMPT_DETAILS = 1;

export interface DaemonStatusAttemptSummary {
  readonly retainedCount: number;
  readonly includedCount: number;
  readonly unresolvedCount: number;

  readonly lowestNonce: string | null;
  readonly highestNonce: string | null;

  readonly detailedCount: number;
  readonly omittedCount: number;
}

export interface DaemonStatusAttemptProjection {
  readonly summary: DaemonStatusAttemptSummary;
  readonly details: readonly DaemonStatusAttempt[];
}

/**
 * Projects, validated, nonce-ordered status attempts into bounded details.
 * 
 * Counts describe stored phases, not fresh inclusions authorization.
 * Every non-included attempt counts as unresolved.
 * 
 * Unresolved attempts take priority over included attempts. Within each
 * group, lower nonces take priority. Returned details remain nonce-ordered.
 */
export function projectDaemonStatusAttempts(
  attempts: readonly DaemonStatusAttempt[],
): DaemonStatusAttemptProjection {
  let includedCount = 0;

  for (const attempt of attempts) {
    if (attempt.phase === 'included') {
      includedCount += 1;
    }
  }

  const selected: DaemonStatusAttempt[] = [];

  for (const attempt of attempts) {
    if (selected.length >= MAX_DAEMON_STATUS_ATTEMPT_DETAILS) {
      break;
    }

    if (attempt.phase !== 'included') {
      selected.push(attempt);
    }
  }

  for (const attempt of attempts) {
    if (selected.length >= MAX_DAEMON_STATUS_ATTEMPT_DETAILS) {
      break;
    }

    if (attempt.phase === 'included') {
      selected.push(attempt);
    }
  }

  selected.sort((first, second) => {
    const firstNonce = BigInt(first.nonce);
    const secondNonce = BigInt(second.nonce);

    if (firstNonce < secondNonce) {
      return -1;
    }

    if (firstNonce > secondNonce) {
      return 1;
    }

    return 0;
  });

  const details = Object.freeze(selected.map((attempt) =>
    Object.freeze({
      ...attempt,
      transactionHashes: Object.freeze([
        ...attempt.transactionHashes,
      ]) as Hashes,
    }),
  ));

  const summary: DaemonStatusAttemptSummary = Object.freeze({
    retainedCount: attempts.length,
    includedCount,
    unresolvedCount: attempts.length - includedCount,
    lowestNonce: attempts[0]?.nonce ?? null,
    highestNonce: attempts[attempts.length - 1]?.nonce ?? null,
    detailedCount: details.length,
    omittedCount: attempts.length - details.length,
  });

  return Object.freeze({
    summary,
    details,
  });
}