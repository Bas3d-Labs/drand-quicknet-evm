import type { Hex } from "./types.js";

const COMPRESSED_SIGNATURE_BYTES = 48;
const HEX_CHARACTERS = new Set(
  "0123456789abcdefABCDEF",
);

export function parseCompressedSignature(
  signature: unknown,
): Hex {
  if (typeof signature !== 'string') {
    throw new TypeError('Invalid compressed Quicknet signature: expected a string');
  }

  const expectedLength = COMPRESSED_SIGNATURE_BYTES * 2;
  if (signature.length !== expectedLength) {
    throw new Error(
      `Invalid compressed Quicknet signature: expected ${COMPRESSED_SIGNATURE_BYTES} bytes.`
    );
  }

  if (!isHex(signature)) {
    throw new Error(
      "Invalid compressed Quicknet signature: contains non-hex characters",
    );
  }

  return `0x${signature.toLowerCase()}`;
}

function isHex(value: string): boolean {
  for (const character of value) {
    if (!HEX_CHARACTERS.has(character)) {
      return false;
    }
  }

  return true;
}