import { 
  createRegistryReader, 
  type RegistryDeployment, 
  submitBeacon 
} from '@based-labs/drand-quicknet-registry';
import type {
  Account,
  Hex,
  PublicClient,
  WalletClient,
} from 'viem';
import {
  decompressSignature,
  fetchBeacon,
  type QuicknetBeacon,
} from '@based-labs/drand-quicknet';

export interface ImportQuicknetRoundOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  round: bigint;
  beacon?: QuicknetBeacon;
}

export type ImportQuicknetRoundResult =
  | {
      status: 'already-stored';
      round: bigint;
      randomness: Hex;
    }
  | {
      status: 'imported';
      round: bigint;
      randomness: Hex;
      transactionHash: Hex;
    };

export async function importQuicknetRound(
  options: ImportQuicknetRoundOptions
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

  const registry = createRegistryReader({
    client: publicClient,
    deployment,
  });
  await registry.verifyDeployment();

  if (await registry.isStored(round)) {
    const randomness = await registry.getBeacon(round);

    return {
      status: 'already-stored',
      round,
      randomness,
    };
  }

  const beacon = providedBeacon ?? await fetchBeacon(round);
  if (beacon.round !== round) {
    throw new Error(
      `Quicknet round mismatch: requested ${round}, received ${beacon.round}.`
    );
  }

  const signature = decompressSignature(beacon.signature);

  const { hash, randomness: simulatedRandomness } = await submitBeacon({
    publicClient,
    walletClient,
    deployment,
    account,
    round,
    signature,
  });

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    throw new Error(`Registry submission reverted: ${receipt.transactionHash}`);
  }

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