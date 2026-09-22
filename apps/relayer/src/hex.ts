import { Hash } from "viem";

export function isFixedHex(
  value: unknown,
  bytes: number,
): value is Hash {
  if (
    typeof value !== 'string' ||
    value.length !== 2 + bytes * 2 ||
    !value.startsWith('0x')
  ) {
    return false;
  }

  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const decimal = code >= 48 && code <= 57;
    const uppercase = code >= 65 && code <= 70;
    const lowercase = code >= 97 && code <= 102;

    if (!decimal && !uppercase && !lowercase) {
      return false;
    }
  }

  return true;
}