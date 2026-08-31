export type Hex = `0x${string}`;

export type CompressedSignature = Hex & {
  readonly __compressedSignature: unique symbol;
};

export interface QuicknetBeacon {
  round: bigint;
  signature: CompressedSignature;
}