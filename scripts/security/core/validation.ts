import {
  getAddress,
  isAddress,
  isHex,
  size,
  type Address,
  type Hex,
} from 'viem';

export function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${path} must be an object.`);
  }

  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  path: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0
  ) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return value;
}

export function requirePositiveInteger(
  value: unknown,
  path: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${path} must be a positive safe integer.`);
  }

  return value;
}

export function requireNonNegativeInteger(
  value: unknown,
  path: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }

  return value;
}

export function requireBoolean(
  value: unknown,
  path: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }

  return value;
}

export function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${path}.${key} is not supported.`,
      );
    }
  }
}

export function requireAddress(
  value: unknown,
  path: string,
): Address {
  const address = requireString(value, path);
  if (!isAddress(address)) {
    throw new Error(
      `${path} must be an EVM address.`,
    );
  }

  return getAddress(address);
}

export function requireHex(
  value: unknown,
  path: string,
): Hex {
  const hex = requireString(value, path);
  if (!isHex(hex)) {
    throw new Error(`${path} must be hex.`);
  }

  return hex.toLowerCase() as Hex;
}

export function requireBytes32(
  value: unknown,
  path: string,
): Hex {
  const hex = requireHex(value, path);
  if (size(hex) !== 32) {
    throw new Error(`${path} must be bytes32.`);
  }

  return hex;
}