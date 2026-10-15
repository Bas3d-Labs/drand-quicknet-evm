import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  JournalIdentity,
} from './transaction-journal.js';

export function captureJournalIdentity(
  identity: JournalIdentity,
): JournalIdentity {
  const {
    chainId,
    signer,
  } = identity;

  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !isFixedHex(signer, 20)
  ) {
    throw new TypeError('Invalid journal identity.');
  }

  return Object.freeze({
    chainId,
    signer,
  });
}

export function journalFilename(
  identity: JournalIdentity,
): string {
  return `transaction-journal-${identity.chainId}-${identity.signer.toLowerCase()}.json`;
}