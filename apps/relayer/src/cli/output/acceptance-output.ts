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
  journalJson,
  readAcceptedOutcome,
} from '../../state/journal-ledger-validation.js';

import {
  isTransactionAdmissionReason,
} from '../../state/transaction-manager-types.js';

import {
  decodeAcceptanceTicket,
  ticketMatchesOutcome,
} from '../../state/acceptance-ticket.js';

import type {
  AcceptanceResult,
} from '../../state/accept-unattributed.js';

import {
  renderAttributionOutput,
} from './attribution-output.js';

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
  'anchor-changed',
  'inconsistent-observations',
  'correction-required',
  'retained-candidate-unresolved',
  'nonce-unconsumed',
  'ledger-capacity-reached',
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
  'operator-acceptance-available',
  'search-incomplete',
]);

/** Explicit projection; neither extra result fields nor journal bytes reach stdout. */
export function renderAcceptanceOutput(
  result: AcceptanceResult,
): string {
  if (result.status === 'attempt-already-accounted') {
    return renderAttributionOutput(result);
  }

  if (result.status === 'deferred') {
    const gap = result.gap;

    if (
      result.reason !== 'search-incomplete' ||
      !validUint(gap.boundary.blockNumber) ||
      !isFixedHex(gap.boundary.blockHash, 32) ||
      !validUint(gap.durable.blockNumber) ||
      !isFixedHex(gap.durable.blockHash, 32) ||
      !validUint(gap.blocks) ||
      !validUint(gap.budget) ||
      gap.budget === 0n ||
      gap.blocks !== gap.durable.blockNumber - gap.boundary.blockNumber ||
      gap.blocks <= gap.budget
    ) {
      throw new TypeError('Invalid operator acceptance output.');
    }

    return journalJson({
      status: result.status,
      reason: result.reason,
      gap: {
        boundary: {
          blockNumber: gap.boundary.blockNumber,
          blockHash: gap.boundary.blockHash,
        },
        durable: {
          blockNumber: gap.durable.blockNumber,
          blockHash: gap.durable.blockHash,
        },
        blocks: gap.blocks,
        budget: gap.budget,
      },
      message: 'The remaining search gap exceeds one search budget. No progress was saved.',
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
      throw new TypeError('Invalid operator acceptance output.');
    }

    if (result.reason === 'ledger-capacity-reached') {
      return journalJson({
        status: result.status,
        reason: result.reason,
        message: 'Operator recovery history is full. ' +
          'No clearing operation is available in this version; ' +
          'further attributions or acceptances require a reviewed archival upgrade.',
      });
    }

    return journalJson({
      status: result.status,
      reason: result.reason,
    });
  }

  if (result.status === 'committed' || result.status === 'already-recorded') {
    const outcome = readAcceptedOutcome(result.outcome);

    return journalJson({
      status: result.status,
      outcome,
    });
  }

  if (result.status !== 'preview') {
    throw new TypeError('Invalid operator acceptance output.');
  }

  const ticket = decodeAcceptanceTicket(journalJson(result.ticket));

  const outcome = readAcceptedOutcome(result.preview.outcome);

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
    throw new TypeError('Invalid operator acceptance output.');
  }

  const unattributedActivityRemains =
    result.preview.blockers.includes('unattributed-signer-activity');

  let message = 'Acceptance ends recovery closed. Normal recovery must complete before submission.';

  if (unattributedActivityRemains) {
    message = 'Acceptance will not unblock submissions while unattributed activity remains.';
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
      blockers: Array.from(result.preview.blockers),
      unattributedActivityRemains,
      message,
    },
  });
}

function validUint(
  value: unknown,
): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT256;
}
