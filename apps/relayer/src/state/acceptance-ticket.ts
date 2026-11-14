import type {
  Hash,
} from 'viem';

import {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

import {
  captureJournalIdentity,
} from './journal-identity.js';

import {
  journalJson,
  readAttributionMetadata,
} from './journal-ledger-validation.js';

import {
  anchor,
  decimal,
  fields,
  hash,
  requireValid,
} from './operator-ticket-fields.js';

import type {
  AnchoredNonceObservation,
  JournalIdentity,
  OperatorAcceptedOutcome,
} from './transaction-journal.js';

export const MAX_ACCEPTANCE_TICKET_BYTES = 4_096;

export interface AcceptanceTicket {
  readonly version: 1;
  readonly kind: 'operator-accepted-unattributed';
  readonly identity: JournalIdentity;
  readonly requestId: string;
  readonly snapshotDigest: Hash;
  readonly proposalDigest: Hash;
  readonly operator: string;
  readonly at: string;
  readonly attemptId: string;
  readonly durable: AnchoredNonceObservation;
  readonly finality: FinalityPolicy;
}

/** Project only bounded, public acceptance fields. Never accepts a journal. */
export function ticketForOutcome(
  identity: JournalIdentity,
  outcome: OperatorAcceptedOutcome,
): AcceptanceTicket {
  return Object.freeze({
    version: 1,
    kind: 'operator-accepted-unattributed',
    identity: captureJournalIdentity(identity),
    requestId: outcome.requestId,
    snapshotDigest: outcome.snapshotDigest,
    proposalDigest: outcome.proposalDigest,
    operator: outcome.operator,
    at: outcome.at,
    attemptId: outcome.attemptId,
    durable: outcome.durable,
    finality: outcome.finality,
  });
}

/** A ticket is untrusted input. No parser failure exposes its contents. */
export function decodeAcceptanceTicket(
  contents: string,
): AcceptanceTicket {
  try {
    requireValid(Buffer.byteLength(contents, 'utf8') <= MAX_ACCEPTANCE_TICKET_BYTES);

    const root = fields(JSON.parse(contents), [
      'version',
      'kind',
      'identity',
      'requestId',
      'snapshotDigest',
      'proposalDigest',
      'operator',
      'at',
      'attemptId',
      'durable',
      'finality',
    ]);

    requireValid(root.version === 1);
    requireValid(root.kind === 'operator-accepted-unattributed');

    const identity = fields(root.identity, ['chainId', 'signer']);

    requireValid(typeof identity.chainId === 'number');
    requireValid(isFixedHex(identity.signer, 20));

    const capturedIdentity = captureJournalIdentity({
      chainId: identity.chainId,
      signer: identity.signer,
    });

    const metadata = readAttributionMetadata({
      requestId: root.requestId,
      operator: root.operator,
      at: root.at,
      finality: FinalityPolicy.parseJson(root.finality),
    });

    requireValid(isUuidV4(root.attemptId));
    requireValid(root.attemptId === root.attemptId.toLowerCase());

    const observation = fields(root.durable, ['anchor', 'nonce']);

    const durable = Object.freeze({
      anchor: anchor(observation.anchor),
      nonce: decimal(observation.nonce),
    });

    return Object.freeze({
      version: 1,
      kind: 'operator-accepted-unattributed',
      identity: capturedIdentity,
      requestId: metadata.requestId,
      snapshotDigest: hash(root.snapshotDigest),
      proposalDigest: hash(root.proposalDigest),
      operator: metadata.operator,
      at: metadata.at,
      attemptId: root.attemptId,
      durable,
      finality: metadata.finality,
    });
  } catch {
    throw new TypeError('Invalid operator acceptance ticket.');
  }
}

export function ticketMatchesOutcome(
  ticket: AcceptanceTicket,
  identity: JournalIdentity,
  outcome: OperatorAcceptedOutcome,
): boolean {
  return journalJson(ticket) === journalJson(ticketForOutcome(identity, outcome));
}
