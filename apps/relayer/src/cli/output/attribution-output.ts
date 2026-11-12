import {
  snapshotResolutionEvidence,
} from '../../diagnostics/resolution-validation.js';

import {
  isFixedHex,
} from '../../shared/hex.js';

import {
  MAX_UINT256,
} from '../../shared/uint.js';

import {
  isUuidV4,
} from '../../shared/uuid.js';

import {
  journalJson,
  readOperatorOutcome,
} from '../../state/journal-ledger-validation.js';

import {
  supersedesNoMatch,
} from '../../state/operator-attribution.js';

import {
  isTransactionAdmissionReason,
} from '../../state/transaction-manager-types.js';

import {
  decodeAttributionTicket,
  ticketMatchesOutcome,
} from '../../state/attribution-ticket.js';

import type {
  AttributionResult,
} from '../../state/attribute-transaction.js';

const REFUSALS = new Set([
  'configuration-mismatch',
  'journal-missing',
  'request-conflict',
  'snapshot-changed',
  'chain-mismatch',
  'ticket-anchor-not-durable',
  'proposal-unavailable',
  'proposal-changed',
  'missing-lower-bound',
  'wrong-attempt',
  'inclusion-outside-bound',
  'anchor-changed',
  'inconsistent-observations',
  'correction-required',
  'invalid-parent',
  'invalid-match',
  'retained-candidate-unresolved',
  'nonce-unconsumed',
  'ledger-capacity-reached',
  'locator-pending',
  'locator-not-found',
  'cursor-above-durable',
  'stale-evidence',
  'anchor-behind-exhaustion',
  'nonce-behind-journal',
  'no-attempt',
  'resolution-available',
  'unresolved',
  'search-reset-required',
  'search-unconsumed-bound-rebase-required',
  'search-lower-bound-replacement-required',
  'search-lower-bound-replacement-unavailable',
  'bootstrap-deferred',
  'operator-attribution-available',
]);

/** Explicit projection; neither extra result fields nor journal bytes reach stdout. */
export function renderAttributionOutput(
  result: AttributionResult,
): string {
  if (result.status === 'attempt-already-attributed') {
    if (!isUuidV4(result.requestedRequestId)) {
      throw new TypeError('Invalid operator attribution output.');
    }

    return journalJson({
      status: result.status,
      requestedRequestId: result.requestedRequestId,
      outcome: readOperatorOutcome(result.outcome),
    });
  }

  if (result.status === 'ordinary-resolution-available') {
    return journalJson({
      status: result.status,
      evidence: snapshotResolutionEvidence(result.evidence),
    });
  }

  if (result.status === 'refused') {
    if (!REFUSALS.has(result.reason)) {
      throw new TypeError('Invalid operator attribution output.');
    }

    if (result.reason === 'ledger-capacity-reached') {
      return journalJson({
        status: result.status,
        reason: result.reason,
        message: 'Operator-attribution history is full. No clearing operation is available ' +
          'in this version; further operator attributions require a reviewed archival upgrade.',
      });
    }

    return journalJson({
      status: result.status,
      reason: result.reason,
    });
  }

  if (result.status === 'committed' || result.status === 'already-recorded') {
    return journalJson({
      status: result.status,
      outcome: readOperatorOutcome(result.outcome),
    });
  }

  if (result.status !== 'preview') {
    throw new TypeError('Invalid operator attribution output.');
  }

  const ticket = decodeAttributionTicket(journalJson(result.ticket));

  const outcome = readOperatorOutcome(result.preview.outcome);

  const observation = result.preview.lastObservation;

  if (
    !ticketMatchesOutcome(ticket, ticket.identity, outcome) ||
    !isFixedHex(observation.anchor.blockHash, 32) ||
    !validUint(observation.anchor.blockNumber) ||
    !validUint(observation.nonce) ||
    !validUint(result.preview.previousDurableNextNonce) ||
    !validUint(result.preview.durableNextNonce) ||
    !Array.isArray(result.preview.blockers) ||
    result.preview.blockers.some((value) => !isTransactionAdmissionReason(value))
  ) {
    throw new TypeError('Invalid operator attribution output.');
  }

  return journalJson({
    status: 'preview',
    ticket,
    preview: {
      removedAttemptId: outcome.attemptId,
      previousDurableNextNonce: result.preview.previousDurableNextNonce,
      durableNextNonce: result.preview.durableNextNonce,
      lastObservation: {
        anchor: {
          blockNumber: observation.anchor.blockNumber,
          blockHash: observation.anchor.blockHash,
        },
        nonce: observation.nonce,
      },
      outcome,
      supersededNoMatch: supersedesNoMatch(outcome),
      blockers: Array.from(result.preview.blockers),
    },
  });
}

function validUint(
  value: unknown,
): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT256;
}
