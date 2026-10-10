import {
  WaitForTransactionReceiptTimeoutError,
} from 'viem';

import type {
  Account,
  Hash,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from 'viem';

import {
  createRegistryReader,
  type RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  fetchBeacon,
  type QuicknetBeacon,
} from '@based-labs/drand-quicknet';

import {
  reportImportProgress,
  type RoundImportProgress,
} from '../diagnostics/operation-context.js';

import type {
  SignerBlocker,
} from '../state/signer-gate.js';

import {
  simulateBeaconSubmission,
  type BeaconSubmissionDetails,
} from './simulate-beacon-submission.js';

import type {
  BeaconSubmitter,
} from './create-beacon-submitter.js';

export interface ImportQuicknetRoundOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  round: bigint;
  submitter: BeaconSubmitter;
  beacon?: QuicknetBeacon;
  onProgress?: ((progress: RoundImportProgress) => void) | undefined;
}

export type ImportQuicknetRoundResult =
  | {
      status: 'already-stored';
      round: bigint;
      randomness: Hex;
    }
  | ({
      status: 'imported';
      round: bigint;
      randomness: Hex;
      transactionHash: Hex;
    } & BeaconSubmissionDetails)
  | PendingImportResult
  | DeferredImportResult;

export interface PendingImportResult {
  readonly status: 'pending';
  readonly round: bigint;
  readonly attemptId: string;
  readonly transactionHash: Hash;
  readonly reason:
    | 'broadcast-not-acknowledged'
    | 'receipt-timeout';
}

export interface DeferredImportResult {
  readonly status: 'deferred';
  readonly round: bigint;
  readonly reason: 'signer-unavailable';
  readonly blocker: SignerBlocker;
}

export type CompletedImportResult = Extract<
  ImportQuicknetRoundResult,
  { status: 'imported' | 'already-stored' }
>;

export async function importQuicknetRound(
  options: ImportQuicknetRoundOptions,
): Promise<ImportQuicknetRoundResult> {
  const {
    publicClient,
    account,
    deployment,
    round,
    beacon: providedBeacon,
  } = options;

  if (round <= 0n) {
    throw new RangeError('Quicknet round must be greater than zero.');
  }

  reportImportProgress(options.onProgress, {
    round,
    phase: 'verify-deployment',
  });

  const registry = createRegistryReader({
    client: publicClient,
    deployment,
  });
  await registry.verifyDeployment();

  reportImportProgress(options.onProgress, {
    round,
    phase: 'check-stored',
  });

  if (await registry.isStored(round)) {
    const randomness = await registry.getBeacon(round);

    return {
      status: 'already-stored',
      round,
      randomness,
    };
  }

  let beacon = providedBeacon;
  if (beacon === undefined) {
    reportImportProgress(options.onProgress, {
      round,
      phase: 'fetch-beacon',
    });

    beacon = await fetchBeacon(round);
  }

  reportImportProgress(options.onProgress, {
    round,
    phase: 'validate-beacon',
  });

  if (beacon.round !== round) {
    throw new Error(
      `Quicknet round mismatch: requested ${round}, received ${beacon.round}.`
    );
  }

  const signature = beacon.signature;

  reportImportProgress(options.onProgress, {
    round,
    phase: 'prepare-submission',
  });

  const {
    request,
    result: simulatedRandomness,
    ...submission
  } = await simulateBeaconSubmission({
    publicClient,
    deployment,
    account,
    round,
    signature,
  });

  reportImportProgress(options.onProgress, {
    round,
    phase: 'submit-transaction',
  });
  
  const submitted = await options.submitter.submit(request);

  if (submitted.status === 'signer-unavailable') {
    return {
      status: 'deferred',
      round,
      reason: 'signer-unavailable',
      blocker: submitted.blocker,
    };
  }

  if (submitted.status === 'not-acknowledged') {
    return {
      status: 'pending',
      round,
      attemptId: submitted.attemptId,
      transactionHash: submitted.transactionHash,
      reason: 'broadcast-not-acknowledged',
    };
  }

  const hash = submitted.transactionHash;

  reportImportProgress(options.onProgress, {
    round,
    phase: 'wait-for-receipt',
    transactionHash: hash,
  });

  let receipt: TransactionReceipt;

  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
      throw error;
    }

    return {
      status: 'pending',
      round,
      attemptId: submitted.attemptId,
      transactionHash: submitted.transactionHash,
      reason: 'receipt-timeout',
    };
  }
  if (receipt.status !== 'success') {
    throw new Error(`Registry submission reverted: ${receipt.transactionHash}`);
  }

  reportImportProgress(options.onProgress, {
    round,
    phase: 'verify-stored-beacon',
    transactionHash: receipt.transactionHash,
  });

  const storedRandomness = await readStoredBeaconAtBlock(
    registry,
    round,
    receipt.blockNumber,
  );
  if (storedRandomness.toLowerCase() !== simulatedRandomness.toLowerCase()) {
    throw new Error(
      `Stored randomness mismatch for Quicknet round ${round}: simulated ${simulatedRandomness}, stored ${storedRandomness}.`
    );
  }

  return {
    status: 'imported',
    ...submission,
    round,
    randomness: storedRandomness,
    transactionHash: receipt.transactionHash,
  };
}

async function readStoredBeaconAtBlock(
  registry: ReturnType<typeof createRegistryReader>,
  round: bigint,
  blockNumber: bigint,
): Promise<Hex> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await registry.getBeacon(round, blockNumber);
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  throw lastError;
}