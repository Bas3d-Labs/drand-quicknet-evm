import type {
  Hash,
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  AnchoredNonceObservation,
} from './transaction-journal.js';

interface InspectionBracketOptions {
  readonly publicClient: PublicClient;
  readonly head: Readonly<BlockAnchor>;
  readonly durableAnchor?: Readonly<BlockAnchor>;
}

export interface InspectionBracket {
  readonly publicClient: PublicClient;
  readonly head: Readonly<BlockAnchor>;
  readonly durableAnchor: Readonly<BlockAnchor> | undefined;
  durableNonce: bigint | undefined;

  /** Observed hashes for this inspection only; never persisted or cached. */
  durableObservations: ReadonlyMap<bigint, Hash>;
  phase:
    | 'opening'
    | 'durable'
    | 'latest'
    | 'closing'
    | 'persisting'
    | 'completed'
    | 'failed';
}

export function createInspectionBracket(
  options: InspectionBracketOptions,
): InspectionBracket {
  const head = Object.freeze({ ...options.head });

  const durable = options.durableAnchor;

  if (
    typeof head.blockNumber !== 'bigint' ||
    head.blockNumber < 0n ||
    head.blockNumber >= (1n << 256n) ||
    !isFixedHex(head.blockHash, 32) ||
    (
      durable !== undefined &&
      (
        typeof durable.blockNumber !== 'bigint' ||
        durable.blockNumber < 0n ||
        !isFixedHex(durable.blockHash, 32) ||
        head.blockNumber < durable.blockNumber ||
        (
          head.blockNumber === durable.blockNumber &&
          !blockAnchorsMatch(head, durable)
        )
      )
    )
  ) {
    throw new TypeError('Invalid signer inspection anchors.');
  }

  return {
    publicClient: options.publicClient,
    head,
    durableAnchor: durable === undefined
      ? undefined
      : Object.freeze({ ...durable }),
    durableNonce: undefined,
    durableObservations: new Map(),
    phase: 'opening',
  };
}

/** Matching repeats are allowed. Different hashes at one height fail closed. */
export function mergeBlockObservations(
  previous: ReadonlyMap<bigint, Hash>,
  observations: readonly Readonly<BlockAnchor>[],
): ReadonlyMap<bigint, Hash> | null {
  const merged = new Map(previous);

  for (const observation of observations) {
    const known = merged.get(observation.blockNumber);

    if (
      known !== undefined &&
      known.toLowerCase() !== observation.blockHash.toLowerCase()
    ) {
      return null;
    }

    merged.set(observation.blockNumber, observation.blockHash);
  }

  return merged;
}

/** Only the opening phase needs an RPC read; durable operations reuse it. */
export function inspectionNeedsOpening(bracket: InspectionBracket): boolean {
  if (bracket.phase === 'durable') {
    return false;
  }

  if (bracket.phase !== 'opening') {
    throw new Error('Signer inspection bracket cannot accept another operation.');
  }

  return true;
}

/** Failure is allowed from every phase, including a previously failed bracket. */
export function nextInspectionPhase(
  phase: InspectionBracket['phase'],
  next: InspectionBracket['phase'],
): InspectionBracket['phase'] {
  if (next === 'failed') {
    return next;
  }

  const successors = {
    opening: 'durable',
    durable: 'latest',
    latest: 'closing',
    closing: 'persisting',
    persisting: 'completed',
    completed: null,
    failed: null,
  } as const satisfies Record<InspectionBracket['phase'], InspectionBracket['phase'] | null>;

  if (successors[phase] !== next) {
    throw new Error('Signer inspection bracket cannot accept another operation.');
  }

  return next;
}

/** Returns the remembered nonce, or null when durable evidence contradicts it. */
export function observeDurableNonce(
  bracket: InspectionBracket,
  observation: AnchoredNonceObservation,
): bigint | null {
  if (
    bracket.durableAnchor === undefined ||
    !blockAnchorsMatch(bracket.durableAnchor, observation.anchor)
  ) {
    throw new Error('Durable observation does not match the inspection anchor.');
  }

  if (
    bracket.durableNonce !== undefined &&
    bracket.durableNonce !== observation.nonce
  ) {
    return null;
  }

  return observation.nonce;
}

export function latestNonceIsConsistent(
  bracket: InspectionBracket,
  nonce: bigint,
): boolean {
  return bracket.durableNonce === undefined || nonce >= bracket.durableNonce;
}

export function assertInspectionCompleted(bracket: InspectionBracket): void {
  if (bracket.phase !== 'completed') {
    throw new Error('Signer inspection bracket has not completed successfully.');
  }
}

/** Release only this inspection's evidence; no journal state is involved. */
export function discardInspectionEvidence(
  bracket: InspectionBracket,
): InspectionBracket {
  return { ...bracket, durableObservations: new Map() };
}
