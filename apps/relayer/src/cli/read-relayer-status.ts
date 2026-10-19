import { isPositiveSafeInteger } from '../shared/integer.js';
import {
  classifySnapshotAge,
  type DaemonStatusSnapshot,
  type SnapshotAge,
} from '../state/daemon-status-snapshot.js';

import {
  readDaemonStatusFile,
} from '../state/file-daemon-status-store.js';

import type {
  JournalStatus,
} from '../state/project-journal-status.js';

import type {
  JournalIdentity,
} from '../state/transaction-journal.js';

import {
  readJournalStatus,
} from './read-journal-status.js';

interface CommonStatusOptions {
  readonly identity: JournalIdentity;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export type ReadRelayerStatusOptions = CommonStatusOptions & (
  | {
      readonly source: 'journal';
    }
  | {
      readonly source: 'daemon-snapshot';
      readonly maxAgeMs: number;
      readonly now?: () => number;
    }
);

type DaemonSnapshotStatus =
  | {
      readonly source: 'daemon-snapshot';
      readonly snapshot: 'missing';
      readonly gate: 'unknown';
    }
  | {
      readonly source: 'daemon-snapshot';
      readonly snapshot: 'present';

      /** Current authorization is never established by a snapshot. */
      readonly gate: 'unknown';

      readonly age: SnapshotAge;
      readonly observation: DaemonStatusSnapshot;
  };

export type RelayerStatus = JournalStatus | DaemonSnapshotStatus;

/**
 * Reads exactly the selected diagnostic source.
 * 
 * Journal reads require verified service ownership. Snapshot reads do not.
 * Neither source establishes current signing authorization.
 * Failures do not trigger fallback to another source.
 */
export async function readRelayerStatus(
  options: ReadRelayerStatusOptions,
): Promise<RelayerStatus> {
  const identity = Object.freeze({
    chainId: options.identity.chainId,
    signer: options.identity.signer,
  });

  const env = { ...(options.env ?? process.env )};
  const signal = options.signal;

  signal?.throwIfAborted();

  switch (options.source) {
    case 'journal':
      return readJournalStatus({
        identity,
        env,
        ...(signal === undefined ? {} : { signal }),
      });

    case 'daemon-snapshot': {
      const maxAgeMs = options.maxAgeMs;
      const now = options.now ?? Date.now;

      if (!isPositiveSafeInteger(maxAgeMs)) {
        throw new TypeError('Invalid daemon snapshot maximum age.');
      }

      const observation = await readDaemonStatusFile({
        identity,
        env,
      });

      signal?.throwIfAborted();

      if (observation === null) {
        return Object.freeze({
          source: 'daemon-snapshot',
          snapshot: 'missing',
          gate: 'unknown',
        });
      }

      const age = Object.freeze(classifySnapshotAge(
        observation.observedAt,
        now(),
        maxAgeMs,
      ));

      return Object.freeze({
        source: 'daemon-snapshot',
        snapshot: 'present',
        gate: 'unknown',
        age,
        observation,
      });
    }

    default:
      throw new TypeError('Invalid relayer status source.');
  }
}