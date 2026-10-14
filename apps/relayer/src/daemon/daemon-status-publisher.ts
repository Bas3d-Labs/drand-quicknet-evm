import {
  readDaemonStatusSnapshot,
  type DaemonStatusCompletedCycle,
  type DaemonStatusRetryObservation,
} from '../state/daemon-status-snapshot.js';

import {
  writeDaemonStatusFile,
} from '../state/file-daemon-status-store.js';

import type {
  SignerRuntimeObservation,
} from '../state/read-signer-runtime-observation.js';

import type {
  JournalIdentity,
} from '../state/transaction-journal.js';

export interface DaemonStatusPublisherOptions {
  readonly identity: JournalIdentity;
  readonly runId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly write?: typeof writeDaemonStatusFile;

  /** Synchronous diagnostic callback. Must not perform transaction work. */
  readonly onFailure: (error: unknown) => void;
}

export interface DaemonStatusPublisher {
  onInitialized(
    readObservation: () => SignerRuntimeObservation,
  ): void;

  onRecoveryCompleted(
    observation: { readonly retryDelayMs: number | null },
  ): void;

  onCycleCompleted(cycle: number): void;

  /** Resolves after this publication attempt, including failure reporting. */
  publish(): Promise<void>;
}

/**
 * Maintains diagnostic observations and serializes snapshot publications.
 */
export function createDaemonStatusPublisher(
  options: DaemonStatusPublisherOptions,
): DaemonStatusPublisher {
  const identity = Object.freeze({
    chainId: options.identity.chainId,
    signer: options.identity.signer,
  });

  const runId = options.runId;
  const env = Object.freeze({ ...(options.env ?? process.env) });
  const now = options.now ?? Date.now;
  const write = options.write ?? writeDaemonStatusFile;
  const onFailure = options.onFailure;

  let readObservation: (() => SignerRuntimeObservation) | undefined;
  let lastCompletedCycle: DaemonStatusCompletedCycle | null = null;
  let lastRetryObservation: DaemonStatusRetryObservation | null = null;
  let publication = Promise.resolve();

  function reportFailure(error: unknown): void {
    try {
      onFailure(error);
    } catch {
      // Diagnostic delivery must not stop transaction processing.
    }
  }

  function timestamp(): string {
    const milliseconds = now();

    if (
      !Number.isSafeInteger(milliseconds) ||
      !Number.isFinite(new Date(milliseconds).getTime())
    ) {
      throw new TypeError('Invalid daemon status observation time.');
    }

    return new Date(milliseconds).toISOString();
  }

  function onInitialized(
    reader: () => SignerRuntimeObservation,
  ): void {
    readObservation = reader;
  }

  function onRecoveryCompleted(
    observation: { readonly retryDelayMs: number | null },
  ): void {
    try {
      const retryDelayMs = observation.retryDelayMs;

      if (
        retryDelayMs !== null &&
        (
          !Number.isSafeInteger(retryDelayMs) ||
          retryDelayMs < 0
        )
      ) {
        throw new TypeError('Invalid daemon status retry delay.');
      }

      lastRetryObservation = Object.freeze({
        observedAt: timestamp(),
        retryDelayMs,
      });
    } catch (error) {
      reportFailure(error);
    }
  }

  function onCycleCompleted(cycle: number): void {
    try {
      if (!Number.isSafeInteger(cycle) || cycle <= 0) {
        throw new TypeError('Invalid daemon status cycle.');
      }

      lastCompletedCycle = Object.freeze({
        cycle,
        completedAt: timestamp(),
      });
    } catch (error) {
      reportFailure(error);
    }
  }

  async function publishCurrent(): Promise<void> {
    try {
      if (readObservation === undefined) {
        return;
      }

      const runtime = readObservation();

      if (!runtime.journalInitialized) {
        return;
      }

      const snapshot = readDaemonStatusSnapshot({
        version: 1,
        identity,
        runId,
        observedAt: timestamp(),
        journalInitialized: runtime.journalInitialized,
        lastCompletedCycle,
        lastRetryObservation,
        lastObservedGate: runtime.status,
        attempts: runtime.attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          workId: attempt.workId,
          nonce: attempt.nonce.toString(),
          phase: attempt.phase,
          transactionHashes: attempt.transactionHashes,
        })),
      }, identity);

      await write({
        identity,
        snapshot,
        env,
      });
    } catch (error) {
      reportFailure(error);
    }
  }

  function publish(): Promise<void> {
    // Capture current observations when this publication starts.
    // A previous publication must finish before another write begins.
    publication = publication.then(publishCurrent);
    return publication;
  }

  return Object.freeze({
    onInitialized,
    onRecoveryCompleted,
    onCycleCompleted,
    publish,
  });
}