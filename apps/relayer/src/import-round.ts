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
} from '@based-labs/drand-quicknet';

export interface ImportQuicknetRoundOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  round: bigint;
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

  const beacon = await fetchBeacon(round);
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

  const storedRandomness = await registry.getBeacon(round);
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