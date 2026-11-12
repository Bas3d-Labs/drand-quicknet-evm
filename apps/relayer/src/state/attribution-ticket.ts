import type {
  Hash,
} from 'viem';

import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

import {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

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

import type {
  AnchoredNonceObservation,
  JournalIdentity,
  OperatorAttributedOutcome,
} from './transaction-journal.js';

export const MAX_ATTRIBUTION_TICKET_BYTES = 4_096;

export interface AttributionTicket {
  readonly version: 1;
  readonly identity: JournalIdentity;
  readonly requestId: string;
  readonly snapshotDigest: Hash;
  readonly proposalDigest: Hash;
  readonly operator: string;
  readonly at: string;
  readonly attemptId: string;
  readonly hintHash: Hash;
  readonly inclusion: Readonly<BlockAnchor>;
  readonly durable: AnchoredNonceObservation;
  readonly finality: FinalityPolicy;
}

/** Project only bounded, public attribution fields. Never accepts a journal. */
export function ticketForOutcome(
  identity: JournalIdentity,
  outcome: OperatorAttributedOutcome,
): AttributionTicket {
  return Object.freeze({
    version: 1,
    identity: captureJournalIdentity(identity),
    requestId: outcome.requestId,
    snapshotDigest: outcome.snapshotDigest,
    proposalDigest: outcome.proposalDigest,
    operator: outcome.operator,
    at: outcome.at,
    attemptId: outcome.attemptId,
    hintHash: outcome.replacement.transactionHash,
    inclusion: outcome.replacement.inclusion,
    durable: outcome.durable,
    finality: outcome.finality,
  });
}

/** A ticket is untrusted input. No parser failure exposes its contents. */
export function decodeAttributionTicket(
  contents: string,
): AttributionTicket {
  try {
    requireValid(Buffer.byteLength(contents, 'utf8') <= MAX_ATTRIBUTION_TICKET_BYTES);

    const root = fields(JSON.parse(contents), [
      'version',
      'identity',
      'requestId',
      'snapshotDigest',
      'proposalDigest',
      'operator',
      'at',
      'attemptId',
      'hintHash',
      'inclusion',
      'durable',
      'finality',
    ]);

    requireValid(root.version === 1);

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

    const inclusion = anchor(root.inclusion);

    const durable = Object.freeze({
      anchor: anchor(observation.anchor),
      nonce: decimal(observation.nonce),
    });

    requireValid(inclusion.blockNumber <= durable.anchor.blockNumber);

    return Object.freeze({
      version: 1,
      identity: capturedIdentity,
      requestId: metadata.requestId,
      snapshotDigest: hash(root.snapshotDigest),
      proposalDigest: hash(root.proposalDigest),
      operator: metadata.operator,
      at: metadata.at,
      attemptId: root.attemptId,
      hintHash: hash(root.hintHash),
      inclusion,
      durable,
      finality: metadata.finality,
    });
  } catch {
    throw new TypeError('Invalid operator attribution ticket.');
  }
}

export function ticketMatchesOutcome(
  ticket: AttributionTicket,
  identity: JournalIdentity,
  outcome: OperatorAttributedOutcome,
): boolean {
  return journalJson(ticket) === journalJson(ticketForOutcome(identity, outcome));
}

function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  requireValid(typeof input === 'object' && input !== null && !Array.isArray(input));
  requireValid(Object.keys(input).length === keys.length);

  for (const key of keys) {
    requireValid(Object.hasOwn(input, key));
  }

  return input as Record<string, unknown>;
}

function decimal(
  input: unknown,
): bigint {
  requireValid(typeof input === 'string' && input.length <= 78);
  requireValid(isDecimalInteger(input));

  const result = BigInt(input);

  requireValid(result >= 0n && result <= MAX_UINT256 && result.toString() === input);

  return result;
}

function hash(
  input: unknown,
): Hash {
  requireValid(isFixedHex(input, 32));
  requireValid(input === input.toLowerCase());

  return input;
}

function anchor(
  input: unknown,
): Readonly<BlockAnchor> {
  const value = fields(input, ['blockNumber', 'blockHash']);

  return Object.freeze({
    blockNumber: decimal(value.blockNumber),
    blockHash: hash(value.blockHash),
  });
}

function requireValid(
  value: unknown,
): asserts value {
  if (!value) {
    throw new TypeError('Invalid operator attribution ticket.');
  }
}
