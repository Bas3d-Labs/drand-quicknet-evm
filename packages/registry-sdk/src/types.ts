import { Address, Hex } from "viem";
import { CompressedSignature, UncompressedSignature } from "../../drand-quicknet/dist/types.js";

export interface RegistryDeployment {
  chainId: number;
  address: Address;
  runtimeCodehash: Hex,
}

export type RegistrySignature =
  | CompressedSignature
  | UncompressedSignature;