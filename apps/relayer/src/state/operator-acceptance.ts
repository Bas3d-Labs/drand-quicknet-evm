import {
  createHash,
} from 'node:crypto';

import type {
  Hash,
} from 'viem';

import {
  isUuidV4,
} from '../shared/uuid.js';

import {
  journalJson,
  readAcceptedOutcome,
  readAttributionMetadata,
} from './journal-ledger-validation.js';

import type {
  OperatorAttributionRequest,
} from './operator-attribution.js';

import type {
  AnchoredNonceObservation,
  OperatorAcceptedOutcome,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

export type OperatorAcceptanceRequest = Omit<OperatorAttributionRequest, 'hint'> & {
  readonly attemptId: string;
};

export function validateAcceptanceRequest(
  request: OperatorAcceptanceRequest,
): void {
  try {
    readAttributionMetadata({
      requestId: request.requestId,
      operator: request.operator,
      at: request.at,
      finality: request.finality,
    });

    if (!isUuidV4(request.attemptId)) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError('Invalid operator acceptance request.');
  }
}

export function finishAcceptedOutcome(
  snapshot: TransactionJournalSnapshot,
  input: Omit<OperatorAcceptedOutcome, 'proposalDigest'>,
): OperatorAcceptedOutcome {
  const lower = (
    observation: AnchoredNonceObservation,
  ): AnchoredNonceObservation => ({
    anchor: {
      blockNumber: observation.anchor.blockNumber,
      blockHash: observation.anchor.blockHash.toLowerCase() as Hash,
    },
    nonce: observation.nonce,
  });

  let searchedThrough = null;

  let exhausted = null;

  if (input.priorSearch.searchedThrough !== null) {
    searchedThrough = {
      blockNumber: input.priorSearch.searchedThrough.blockNumber,
      blockHash: input.priorSearch.searchedThrough.blockHash.toLowerCase() as Hash,
    };
  }

  if (input.priorSearch.exhausted !== null) {
    exhausted = lower(input.priorSearch.exhausted);
  }

  const checked = readAcceptedOutcome({
    ...input,
    durable: lower(input.durable),
    lowerBound: lower(input.lowerBound),
    priorSearch: {
      searchedThrough,
      exhausted,
    },
    proposalDigest: `0x${'00'.repeat(32)}`,
  });

  const { proposalDigest: _omitted, ...outcome } = checked;

  const payload = journalJson({
    identity: snapshot.identity,
    requestId: checked.requestId,
    snapshotDigest: checked.snapshotDigest,
    outcome,
  });

  return readAcceptedOutcome({
    ...checked,
    proposalDigest: `0x${createHash('sha256').update(payload, 'utf8').digest('hex')}`,
  });
}
