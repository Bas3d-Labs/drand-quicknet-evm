export type Hex = `0x${string}`;

export interface QuicknetBeacon {
  round: bigint;
  signature: Hex;
}