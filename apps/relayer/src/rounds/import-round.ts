import type {
  Account,
  Hex,
  PublicClient,
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
  simulateBeaconSubmission,
  type BeaconSubmissionDetails,
} from './simulate-beacon-submission.js';

import {
  reportImportProgress,
  type RoundImportProgress,
} from '../diagnostics/operation-context.js';

export interface ImportQuicknetRoundOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  round: bigint;
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
    } & BeaconSubmissionDetails);

export async function importQuicknetRound(
  options: ImportQuicknetRoundOptions,
): Promise<ImportQuicknetRoundResult> {
  const {
    publicClient,
    walletClient,
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
  
  let hash: Hex;

  // Narrow by function name so viem retains each request's ABI/args types.
  if (request.functionName === 'submitBeaconWithWitness') {
    hash = await walletClient.writeContract(request);
  } else {
    hash = await walletClient.writeContract(request);
  }

  reportImportProgress(options.onProgress, {
    round,
    phase: 'wait-for-receipt',
    transactionHash: hash,
  });

  const receipt = await publicClient.waitForTransactionReceipt({hash});
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