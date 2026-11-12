import {
  createHash,
} from 'node:crypto';

import type {
  Hash,
} from 'viem';

import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

import type {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import type {
  TransactionHint,
} from '../chain/inspect-transaction-hint.js';

import {
  journalJson,
  readOperatorOutcome,
  readAttributionMetadata,
} from './journal-ledger-validation.js';

import type {
  OperatorAttributedOutcome,
  AnchoredNonceObservation,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface OperatorAttributionRequest {
  readonly hint: TransactionHint;
  readonly requestId: string;
  readonly operator: string;
  readonly at: string;
  readonly finality: FinalityPolicy;
}

export function journalSnapshotDigest(
  snapshot: TransactionJournalSnapshot,
): Hash {
  const canonical = validateJournalSnapshotStructure(snapshot, snapshot.identity);

  return digest(journalJson(canonical) + '\n');
}

export function finishOperatorOutcome(
  snapshot: TransactionJournalSnapshot,
  input: Omit<OperatorAttributedOutcome, 'proposalDigest'>,
): OperatorAttributedOutcome {
  // Validate and order fields before calculating a commitment. The placeholder
  // is not written; it only supplies the required field during validation.
  const checked = readOperatorOutcome({
    ...input,
    durable: lowerObservation(input.durable),
    lowerBound: lowerObservation(input.lowerBound),
    replacement: {
      transactionHash: input.replacement.transactionHash.toLowerCase() as Hash,
      inclusion: lowerAnchor(input.replacement.inclusion),
    },
    priorSearch: normalizedPriorSearch(input),
    proposalDigest: `0x${'00'.repeat(32)}`,
  });

  const { proposalDigest: _omitted, ...outcome } = checked;

  const proposalDigest = digest(journalJson({
    identity: snapshot.identity,
    requestId: checked.requestId,
    snapshotDigest: checked.snapshotDigest,
    outcome,
  }));

  return readOperatorOutcome({
    ...checked,
    proposalDigest,
  });
}

export function supersedesNoMatch(
  outcome: OperatorAttributedOutcome,
): boolean {
  const height = outcome.replacement.inclusion.blockNumber;

  const cursor = outcome.priorSearch.searchedThrough;

  return cursor !== null && height <= cursor.blockNumber;
}

export function validateAttributionRequest(
  input: OperatorAttributionRequest,
): void {
  try {
    readAttributionMetadata({
      requestId: input.requestId,
      operator: input.operator,
      at: input.at,
      finality: input.finality,
    });

    const hint = input.hint;

    if (!isUuidV4(hint.attemptId) || !isFixedHex(hint.transactionHash, 32)) {
      throw new TypeError();
    }

    if (hint.blockNumber !== undefined && (
      typeof hint.blockNumber !== 'bigint' ||
      hint.blockNumber < 0n ||
      hint.blockNumber > MAX_UINT256
    )) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError('Invalid operator attribution request.');
  }
}

function lowerAnchor(
  anchor: Readonly<BlockAnchor>,
): Readonly<BlockAnchor> {
  return {
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash.toLowerCase() as Hash,
  };
}

function lowerObservation(
  observation: AnchoredNonceObservation,
): AnchoredNonceObservation {
  return {
    anchor: lowerAnchor(observation.anchor),
    nonce: observation.nonce,
  };
}

function normalizedPriorSearch(
  input: Omit<OperatorAttributedOutcome, 'proposalDigest'>,
): OperatorAttributedOutcome['priorSearch'] {
  let searchedThrough = null;

  let exhausted = null;

  if (input.priorSearch.searchedThrough !== null) {
    searchedThrough = lowerAnchor(input.priorSearch.searchedThrough);
  }

  if (input.priorSearch.exhausted !== null) {
    exhausted = lowerObservation(input.priorSearch.exhausted);
  }

  return {
    searchedThrough,
    exhausted,
  };
}

function digest(
  contents: string,
): Hash {
  return `0x${createHash('sha256').update(contents, 'utf8').digest('hex')}`;
}
