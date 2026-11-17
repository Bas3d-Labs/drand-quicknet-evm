import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

import type {
  ConflictingSearchFact,
  StoredFactNonceConflict,
} from '../state/stored-fact-nonce-conflict.js';

/** Explicit allowlist: extra fields must never reach operator output. */
export function projectStoredFactConflict(detail: StoredFactNonceConflict) {
  if (
    detail.reason !== 'stored-fact-nonce-conflict' ||
    !isFixedHex(detail.anchor.blockHash, 32) ||
    !validUint(detail.anchor.blockNumber) ||
    detail.first.nonce === detail.second.nonce
  ) {
    throw new TypeError('Invalid stored fact conflict output.');
  }

  return {
    reason: detail.reason,
    anchor: {
      blockNumber: detail.anchor.blockNumber,
      blockHash: detail.anchor.blockHash,
    },
    first: projectFact(detail.first),
    second: projectFact(detail.second),
  };
}

function projectFact(fact: ConflictingSearchFact) {
  if (
    !isUuidV4(fact.attemptId) ||
    !validUint(fact.nonce) ||
    (fact.kind !== 'lowerBound' && fact.kind !== 'exhausted') ||
    (fact.source !== 'candidate' && fact.source !== 'retained')
  ) {
    throw new TypeError('Invalid stored fact conflict output.');
  }

  return {
    attemptId: fact.attemptId,
    kind: fact.kind,
    nonce: fact.nonce,
    source: fact.source,
  };
}

function validUint(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT256;
}
