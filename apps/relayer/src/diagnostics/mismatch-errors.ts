import type {
  Address,
} from 'viem';

import {
  isFixedHex,
} from '../shared/hex.js';

export type MismatchDetails =
  | {
      kind: 'deployment-chain';
      expected: number;
      received: number;
    }
  | {
      kind: 'consumer-registry';
      consumer: Address;
      expected: Address;
      received: Address;
    };

const registered = new WeakMap<object, MismatchDetails>();

export function createDeploymentChainMismatchError(
  expected: number,
  received: number,
): Error {
  if (
    !Number.isSafeInteger(expected) ||
    expected <= 0 ||
    !Number.isSafeInteger(received) ||
    received <= 0
  ) {
    throw new TypeError('Invalid deployment chain mismatch.');
  }

  return register({
    kind: 'deployment-chain',
    expected,
    received,
  });
}

export function createConsumerRegistryMismatchError(
  consumer: Address,
  expected: Address,
  received: Address,
): Error {
  if (
    !isFixedHex(consumer, 20) ||
    !isFixedHex(expected, 20) ||
    !isFixedHex(received, 20)
  ) {
    throw new TypeError('Invalid consumer registry mismatch.');
  }

  return register({
    kind: 'consumer-registry',
    consumer,
    expected,
    received,
  });
}

function register(details: MismatchDetails): Error {
  const error = new Error(mismatchMessage(details));

  registered.set(error, Object.freeze(details));

  return error;
}

export function mismatchDetails(
  error: unknown,
): MismatchDetails | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const details = registered.get(error);

  if (details === undefined) {
    return undefined;
  }

  // Each summary receives its own copy.
  return { ...details };
}

export function mismatchMessage(details: MismatchDetails): string {
  if (details.kind === 'deployment-chain') {
    return (
      'Deployment manifest chain mismatch: ' +
      `expected ${details.expected}, received ${details.received}.`
    );
  }

  return (
    `Quicknet consumer ${details.consumer} uses registry ` +
    `${details.received}, but relayer is configured for ` +
    `${details.expected}.`
  );
}