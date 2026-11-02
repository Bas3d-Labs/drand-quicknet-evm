import type {
  LocalAccount,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  ChainHeads,
} from '../chain/chain-heads.js';

import {
  submitTransaction,
} from '../execution/submit-transaction.js';

import {
  BroadcastRetrySchedule,
  type BroadcastRetryScheduleOptions,
} from './broadcast-retry-schedule.js';

import {
  DurableRecoverySchedule,
  type DurableRecoveryScheduleOptions,
} from './durable-recovery-schedule.js';

import {
  recoverSignerAtHeads,
} from './recover-signer-at-heads.js';

import {
  SignerCoordinator,
  type SignerCoordinatorOptions,
} from './signer-coordinator.js';

import {
  SignerRecoveryCycle,
  type SignerRecoveryCycleResult,
} from './signer-recovery-cycle.js';

import type {
  ReconcileTransactionsOptions,
  SubmissionRecording,
  SubmitTransactionWorkOptions,
  SubmitTransactionWorkResult,
  TransactionBroadcastOutcome,
  TransactionManagerStatus,
  TransactionReconciliationReport,
} from './transaction-manager-types.js';

const registeredRecordings = new WeakMap<object, SubmissionRecording>();

function captureSubmissionRecording(
  recording: SubmissionRecording,
): SubmissionRecording {
  switch (recording.status) {
    case 'none':
      return Object.freeze({
        status: 'none',
      });

    case 'uncertain':
      return Object.freeze({
        status: 'uncertain',
        attempt: Object.freeze({
          workId: recording.attempt.workId,
          attemptId: recording.attempt.attemptId,
        }),
      });

    case 'retained':
      return Object.freeze({
        status: 'retained',
        attempt: Object.freeze({
          workId: recording.attempt.workId,
          attemptId: recording.attempt.attemptId,
        }),
      });
  }
}

class TransactionSubmissionError extends Error {
  constructor(
    cause: unknown,
    recording: SubmissionRecording,
  ) {
    const captured = captureSubmissionRecording(recording);

    super('Transaction submission did not complete.', { cause });

    this.name = 'TransactionSubmissionError';

    registeredRecordings.set(this, captured);
  }
}

export function submissionRecording(
  error: unknown,
): SubmissionRecording | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  return registeredRecordings.get(error);
}

export interface TransactionManagerOptions
  extends SignerCoordinatorOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: LocalAccount;
  readonly readChainHeads: () => Promise<ChainHeads>;
  readonly maxBlockRange: bigint;
  readonly retry: BroadcastRetryScheduleOptions;
  readonly durableRecovery?: DurableRecoveryScheduleOptions;
}

export class TransactionManager {
  private busy = false;

  private constructor(
    private readonly coordinator: SignerCoordinator,
    private readonly recovery: SignerRecoveryCycle,
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly account: LocalAccount,
    private readonly readChainHeads: () => Promise<ChainHeads>,
    private readonly maxBlockRange: bigint,
  ) {}

  static async create(
    options: TransactionManagerOptions,
  ): Promise<TransactionManager> {
    const {
      publicClient,
      walletClient,
      account,
      readChainHeads,
      maxBlockRange,
    } = options;

    if (
      typeof maxBlockRange !== 'bigint' ||
      maxBlockRange <= 0n ||
      maxBlockRange >= (1n << 256n)
    ) {
      throw new TypeError('Invalid transaction manager block range.');
    }

    const schedule = new BroadcastRetrySchedule(options.retry);

    let durableSchedule: DurableRecoverySchedule | undefined;

    if (options.durableRecovery !== undefined) {
      durableSchedule = new DurableRecoverySchedule(
        options.durableRecovery,
      );
    }

    const coordinator = await SignerCoordinator.create(options);

    const unresolved = coordinator.attempts.find(
      (attempt) => attempt.phase !== 'included'
    );

    schedule.track(unresolved ?? null);

    const recovery = new SignerRecoveryCycle({
      coordinator,
      schedule,
      ...(durableSchedule === undefined ? {} : { durableSchedule }),
    });

    return new TransactionManager(
      coordinator,
      recovery,
      publicClient,
      walletClient,
      account,
      readChainHeads,
      maxBlockRange,
    );
  }

  get status(): TransactionManagerStatus {
    return this.captureStatus(this.busy);
  }

  private captureStatus(
    busy: boolean,
  ): TransactionManagerStatus {
    const signer = this.coordinator.status;

    return Object.freeze({
      chainId: this.coordinator.chainId,
      journalInitialized: this.coordinator.journalInitialized,
      busy,
      open: signer.open && !busy,
      primaryReason: signer.primaryReason,
      blockers: Object.freeze([...signer.blockers]),
      recoveryComplete: signer.recoveryComplete,
      inclusionChecksComplete: signer.inclusionChecksComplete,
      persistenceState: signer.persistenceState,
      blockedSince: signer.blockedSince,
      attempts: this.coordinator.attempts,
    });
  }

  async reconcile(
    options: ReconcileTransactionsOptions,
  ): Promise<TransactionReconciliationReport> {
    this.enter();

    try {
      const captured: ReconcileTransactionsOptions = {
        head: Object.freeze({
          blockNumber: options.head.blockNumber,
          blockHash: options.head.blockHash,
        }),
        durable: Object.freeze({
          blockNumber: options.durable.blockNumber,
          blockHash: options.durable.blockHash,
        }),
        signal: options.signal,
        cycle: options.cycle,
      };

      const result = await this.reconcileOwned(captured);

      return this.captureReconciliationReport(result);
    } finally {
      this.busy = false;
    }
  }

  private captureReconciliationReport(
    result: SignerRecoveryCycleResult,
  ): TransactionReconciliationReport {
    let broadcast: TransactionBroadcastOutcome | null = null;

    if (result.broadcast !== null) {
      const outcome = result.broadcast;

      const attempt = this.coordinator.attempts.find(
        (candidate) => candidate.attemptId === outcome.attemptId,
      );

      if (attempt === undefined) {
        throw new Error(
          'Broadcast outcome has no retained transaction identity.'
        );
      }

      broadcast = Object.freeze({
        workId: attempt.workId,
        attemptId: outcome.attemptId,
        transactionHash: outcome.transactionHash,
        nonce: outcome.nonce,
        status: outcome.status,
      });
    }

    let inclusionStatus:
      TransactionReconciliationReport['inclusionStatus'] = null;

    if (result.inclusions !== null) {
      inclusionStatus = result.inclusions.status;
    }

    return Object.freeze({
      state: this.captureStatus(false),
      recoveryStatus: result.inspection.status,
      inclusionStatus,
      broadcast,
      retryDelayMs: result.retryDelayMs,
    });
  }

  async submit(
    options: SubmitTransactionWorkOptions,
  ): Promise<SubmitTransactionWorkResult> {
    this.enter();

    let workId: string | undefined;
    let preparationStarted = false;

    try {
      const signal = options.signal;
      const cycle = options.cycle;
      const work = options.work;

      workId = work.workId;

      const call = Object.freeze({
        to: work.call.to,
        data: work.call.data,
        value: work.call.value,
        gas: work.call.gas,
      });

      signal?.throwIfAborted();

      await this.reconcileSelectedHeadsOwned(signal, cycle);

      signal?.throwIfAborted();

      const status = this.coordinator.status;

      if (!status.open) {
        const primaryReason = status.primaryReason;

        if (primaryReason === null) {
          throw new Error(
            'Signer gate is closed without a reported blocker.'
          );
        }

        return Object.freeze({
          status: 'deferred',
          primaryReason,
          reasons: Object.freeze([
            primaryReason,
            ...status.blockers.slice(1),
          ] as const),
        });
      }

      const retained = this.coordinator.attempts.find(
        (attempt) => attempt.workId === workId,
      );

      if (retained !== undefined) {
        return Object.freeze({
          status: 'already-retained',
          retained: Object.freeze({
            workId: retained.workId,
            attemptId: retained.attemptId,
          }),
        });
      }

      preparationStarted = true;

      const result = await submitTransaction({
        publicClient: this.publicClient,
        walletClient: this.walletClient,
        account: this.account,
        coordinator: this.coordinator,
        call,
        workId,
        signal,
      }, cycle);

      if (result.status === 'already-retained') {
        return Object.freeze({
          status: 'already-retained',
          retained: Object.freeze({
            workId: result.workId,
            attemptId: result.attemptId,
          }),
        });
      }

      return Object.freeze({
        status: 'submitted',
        broadcast: Object.freeze({
          workId,
          attemptId: result.attemptId,
          transactionHash: result.transactionHash,
          nonce: result.nonce,
          status: result.status,
        }),
      });
    } catch (cause) {
      let recording: SubmissionRecording = {
        status: 'none',
      };

      // A pre-submit recovery failure belongs to existing journal work.
      // It must not be attributed to this new submission.
      if (preparationStarted && workId !== undefined) {
        recording = this.coordinator.captureSubmissionRecording(workId);
      }

      throw new TransactionSubmissionError(cause, recording);
    } finally {
      this.busy = false;
    }
  }

  private async reconcileOwned(
    options: ReconcileTransactionsOptions,
  ): Promise<SignerRecoveryCycleResult> {
    return this.coordinator.observeReconciliation(
      () => this.recovery.run({
        publicClient: this.publicClient,
        anchor: options.durable,
        head: options.head,
        maxBlockRange: this.maxBlockRange,
        ...(options.signal === undefined
          ? {}
          : { signal: options.signal }),
      }, options.cycle),
      options.cycle,
    );
  }

  private async reconcileSelectedHeadsOwned(
    signal: AbortSignal | undefined,
    cycle: number | undefined,
  ): Promise<SignerRecoveryCycleResult> {
    return recoverSignerAtHeads({
      publicClient: this.publicClient,
      readChainHeads: this.readChainHeads,
      maxBlockRange: this.maxBlockRange,
      signal,
      recovery: {
        run: (selected, selectedCycle) => {
          if (selected.head === undefined) {
            throw new Error('Selected transaction head is missing.');
          }

          return this.reconcileOwned({
            head: selected.head,
            durable: selected.anchor,
            signal: selected.signal,
            cycle: selectedCycle,
          });
        },
      },
    }, cycle);
  }

  private enter(): void {
    if (this.busy) {
      throw new Error('Transaction manager operation is already in progress.');
    }

    this.busy = true;
  }
}