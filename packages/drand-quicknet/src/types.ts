export type Hex = `0x${string}`;

export type CompressedSignature = Hex & {
  readonly __compressedSignature: unique symbol;
};

export type UncompressedSignature = Hex & {
  readonly __uncompressedSignature: unique symbol;
};

export interface QuicknetBeacon {
  round: bigint;
  signature: Hex;
}