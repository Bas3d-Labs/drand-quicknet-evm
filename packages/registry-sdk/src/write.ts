import { Account, Address, PublicClient, WalletClient } from "viem";
import { RegistryDeployment, RegistrySignature } from "./types.js";
import { drandQuicknetBeaconRegistryAbi } from "./abi.js";

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