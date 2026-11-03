import type {
  PublicClient,
} from 'viem';

import {
  getBlockAnchor,
} from '../chain/block-anchor.js';

import type {
  ChainHeads,
} from '../chain/chain-heads.js';

import type {
  TransactionManager,
} from '../state/transaction-manager.js';

import type {
  SubmitTransactionWorkResult,
  TransactionAttemptSummary,
  TransactionReconciliationReport,
  TransactionRecoveryObservation,
} from '../state/transaction-manager-types.js';

import {
  submitBeaconTransaction,
  type SubmitBeaconTransactionOptions,
} from './submit-beacon-transaction.js';

export type BeaconSubmissionRequest =
  SubmitBeaconTransactionOptions['request'];

export type BeaconRecoveryObservation =
  TransactionRecoveryObservation;

export interface BeaconSubmitter {
  findRetainedWork(workId: string): TransactionAttemptSummary | null;

  recover(cycle?: number): Promise<TransactionReconciliationReport>;

  submit(
    request: BeaconSubmissionRequest,
    cycle?: number,
  ): Promise<SubmitTransactionWorkResult>;
}

export interface CreateBeaconSubmitterOptions {
  readonly publicClient: PublicClient;
  readonly manager: Pick<
    TransactionManager,
    'status' | 'reconcile' | 'submit'
  >;
  readonly readChainHeads: () => Promise<ChainHeads>;
  readonly signal?: AbortSignal | undefined;
}

export function createBeaconSubmitter(
  options: CreateBeaconSubmitterOptions,
): BeaconSubmitter {
  const {
    publicClient,
    manager,
    readChainHeads,
    signal,
  } = options;

  function findRetainedWork(
    workId: string,
  ): TransactionAttemptSummary | null {
    return manager.status.attempts.find(
      (attempt) => attempt.workId === workId,
    ) ?? null;
  }

  async function recover(
    cycle?: number,
  ): Promise<TransactionReconciliationReport> {
    signal?.throwIfAborted();

    const {
      durableBlock,
      latestBlock,
    } = await readChainHeads();

    signal?.throwIfAborted();

    if (durableBlock > latestBlock) {
      throw new Error(
        'Cannot recover a signer with the durable block ahead of latest.'
      );
    }

    const durable = await getBlockAnchor(publicClient, durableBlock);

    signal?.throwIfAborted();

    let head = durable;

    if (latestBlock !== durableBlock) {
      head = await getBlockAnchor(publicClient, latestBlock);
      signal?.throwIfAborted();
    }

    return manager.reconcile({
      head,
      durable,
      signal,
      cycle,
    });
  }

  async function submit(
    request: BeaconSubmissionRequest,
    cycle?: number,
  ): Promise<SubmitTransactionWorkResult> {
    return submitBeaconTransaction({
      manager,
      request,
      signal,
    }, cycle);
  }

  return Object.freeze({
    findRetainedWork,
    recover,
    submit,
  });
}