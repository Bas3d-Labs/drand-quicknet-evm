import type {
  Account,
  Address,
  PublicClient,
  WalletClient,
} from 'viem';

import { drandQuicknetBeaconRegistryAbi } from './abi.js';

import type {
  RegistryDeployment,
  RegistrySignature,
} from './types.js';

export interface SimulateSubmitBeaconOptions {
  publicClient: PublicClient;
  deployment: RegistryDeployment;
  account: Account | Address;
  round: bigint;
  signature: RegistrySignature;
}

export interface SubmitBeaconOptions
  extends SimulateSubmitBeaconOptions {
  walletClient: WalletClient;
}

export interface SimulateSubmitBeaconWithWitnessOptions
  extends SimulateSubmitBeaconOptions {
  // Most significant 128 bits of the signature y-coordinate.
  yHi: bigint;

  // Least significant 256 bits of the signature y-coordinate.
  yLo: bigint;
}

export interface SubmitBeaconWithWitnessOptions
  extends SimulateSubmitBeaconWithWitnessOptions {
  walletClient: WalletClient;
}

/**
 * Simulates compressed-signature submission without broadcasting.
 *
 * For stored rounds, the registry returns cached randomness without
 * examining the signature.
 */
export async function simulateSubmitBeacon(
  options: SimulateSubmitBeaconOptions,
) {
  const {
    publicClient,
    deployment,
    account,
    round,
    signature,
  } = options;

  return publicClient.simulateContract({
    account,
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'submitBeacon',
    args: [
      round,
      signature,
    ],
  });
}

/**
 * Simulates and submits a compressed-signature beacon import.
 *
 * Returns the transaction hash and simulated randomness.
 * Does not wait for a receipt or retry a failed attempt.
 */
export async function submitBeacon(
  options: SubmitBeaconOptions,
) {
  const {
    walletClient,
    ...simulationOptions
  } = options;

  const {
    request,
    result: randomness,
  } = await simulateSubmitBeacon(simulationOptions);

  const hash = await walletClient.writeContract(request);
  return { hash, randomness };
}

/**
 * Simulates witness-assisted submission without broadcasting.
 *
 * For stored rounds, the registry returns cached randomness without
 * examining the signature or witness.
 */
export async function simulateSubmitBeaconWithWitness(
  options: SimulateSubmitBeaconWithWitnessOptions,
) {
  const {
    publicClient,
    deployment,
    account,
    round,
    signature,
    yHi,
    yLo,
  } = options;

  return publicClient.simulateContract({
    account,
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'submitBeaconWithWitness',
    args: [
      round,
      signature,
      yHi,
      yLo,
    ],
  });
}

/**
 * Simulates and submits a witness-assisted beacon import.
 *
 * Returns the transaction hash and simulated randomness.
 * Does not wait for a receipt or retry a failed attempt.
 */
export async function submitBeaconWithWitness(
  options: SubmitBeaconWithWitnessOptions,
) {
  const {
    walletClient,
    ...simulationOptions
  } = options;

  const {
    request,
    result: randomness,
  } = await simulateSubmitBeaconWithWitness(simulationOptions);

  const hash = await walletClient.writeContract(request);

  return { hash, randomness };
}