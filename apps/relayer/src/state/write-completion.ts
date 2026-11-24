import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import {
  contradictsExhaustionNonce,
  supersedesNoMatch,
} from './operator-attribution.js';

import type {
  RecoveryWriteCompletion,
} from './plan-signer-recovery.js';

import type {
  JournalIdentity,
} from './transaction-journal.js';

export type PendingWrite =
  | RecoveryWriteCompletion
  | {
      kind: 'bootstrap';
    }
  | {
      kind: 'prepared';
    }
  | {
      kind: 'broadcast';
    };

export type SignerEventOperation =
  | 'prepare-attempt'
  | 'broadcast-attempt'
  | 'reconcile-attempt';

type WriteCompletionEvent =
  | {
      readonly kind: 'attemptResolved';
      readonly fields: Parameters<ScopedRelayerLog['attemptResolved']>[0];
    }
  | {
      readonly kind: 'attemptOperatorAccepted';
      readonly fields: Parameters<
        ScopedRelayerLog['attemptOperatorAccepted']
      >[0];
    }
  | {
      readonly kind: 'attemptOperatorAttributed';
      readonly fields: Parameters<
        ScopedRelayerLog['attemptOperatorAttributed']
      >[0];
    }
  | {
      readonly kind: 'searchReset';
      readonly fields: Parameters<ScopedRelayerLog['searchReset']>[0];
    }
  | {
      readonly kind: 'searchUnconsumedBoundRebased';
      readonly fields: Parameters<
        ScopedRelayerLog['searchUnconsumedBoundRebased']
      >[0];
    }
  | {
      readonly kind: 'searchLowerBoundReplaced';
      readonly fields: Parameters<
        ScopedRelayerLog['searchLowerBoundReplaced']
      >[0];
    };

interface WriteCompletionDescription {
  readonly operation: SignerEventOperation;
  readonly terminalCorrection: boolean;
  readonly event: WriteCompletionEvent | null;
}

/** Describes committed writes without performing their completion effects. */
export function describeWriteCompletion(
  pending: PendingWrite,
  signer: JournalIdentity['signer'],
): WriteCompletionDescription {
  switch (pending.kind) {
    case 'bootstrap':
    case 'observation':
    case 'search-progress':
      return {
        operation: 'reconcile-attempt',
        terminalCorrection: false,
        event: null,
      };

    case 'prepared':
      return {
        operation: 'prepare-attempt',
        terminalCorrection: false,
        event: null,
      };

    case 'broadcast':
      return {
        operation: 'broadcast-attempt',
        terminalCorrection: false,
        event: null,
      };

    case 'resolution': {
      return {
        operation: 'reconcile-attempt',
        terminalCorrection: false,
        event: {
          kind: 'attemptResolved',
          fields: pending.event,
        },
      };
    }

    case 'operator-acceptance': {
      const outcome = pending.outcome;

      return {
        operation: 'reconcile-attempt',
        terminalCorrection: true,
        event: {
          kind: 'attemptOperatorAccepted',
          fields: {
            signer,
            requestId: outcome.requestId,
            attemptId: outcome.attemptId,
            nonce: outcome.nonce,
            durableBlock: outcome.durable.anchor.blockNumber,
            durableBlockHash: outcome.durable.anchor.blockHash,
          },
        },
      };
    }

    case 'operator-attribution': {
      const outcome = pending.outcome;

      return {
        operation: 'reconcile-attempt',
        terminalCorrection: true,
        event: {
          kind: 'attemptOperatorAttributed',
          fields: {
            signer,
            requestId: outcome.requestId,
            attemptId: outcome.attemptId,
            transactionHash: outcome.replacement.transactionHash,
            nonce: outcome.nonce,
            durableBlock: outcome.durable.anchor.blockNumber,
            durableBlockHash: outcome.durable.anchor.blockHash,
            supersededNoMatch: supersedesNoMatch(outcome),
            contradictsExhaustionNonce: contradictsExhaustionNonce(outcome),
          },
        },
      };
    }

    case 'search-reset': {
      return {
        operation: 'reconcile-attempt',
        terminalCorrection: true,
        event: {
          kind: 'searchReset',
          fields: pending.event,
        },
      };
    }

    case 'search-unconsumed-bound-rebase': {
      const event = pending.event;
      const { evidence, observation } = event;

      return {
        operation: 'reconcile-attempt',
        terminalCorrection: true,
        event: {
          kind: 'searchUnconsumedBoundRebased',
          fields: {
            signer: event.signer,
            attemptId: event.attemptId,
            nonce: event.nonce,
            oldLowerBlock: evidence.lowerBound.anchor.blockNumber,
            oldLowerBlockHash: evidence.lowerBound.anchor.blockHash,
            oldLowerNonce: evidence.lowerBound.nonce,
            observedLowerBlockHash: evidence.observedLower.blockHash,
            durableBlock: observation.anchor.blockNumber,
            durableBlockHash: observation.anchor.blockHash,
            durableNonce: observation.nonce,
            invalidatedFact: {
              expectedBlock: evidence.fact.anchor.blockNumber,
              expectedBlockHash: evidence.fact.anchor.blockHash,
              observedBlock: evidence.observedFact.blockNumber,
              observedBlockHash: evidence.observedFact.blockHash,
            },
          },
        },
      };
    }

    case 'search-lower-bound-replacement': {
      const event = pending.event;
      let invalidatedFact = null;

      if (event.invalidatedFact !== null) {
        invalidatedFact = {
          expectedBlock: event.invalidatedFact.fact.anchor.blockNumber,
          expectedBlockHash: event.invalidatedFact.fact.anchor.blockHash,
          observedBlock: event.invalidatedFact.observedAnchor.blockNumber,
          observedBlockHash: event.invalidatedFact.observedAnchor.blockHash,
        };
      }

      return {
        operation: 'reconcile-attempt',
        terminalCorrection: true,
        event: {
          kind: 'searchLowerBoundReplaced',
          fields: {
            signer: event.signer,
            attemptId: event.attemptId,
            nonce: event.nonce,
            oldLowerBlock: event.oldLowerBound.anchor.blockNumber,
            oldLowerBlockHash: event.oldLowerBound.anchor.blockHash,
            oldLowerNonce: event.oldLowerBound.nonce,
            observedLowerBlock: event.observedLower.blockNumber,
            observedLowerBlockHash: event.observedLower.blockHash,
            replacementBlock: event.replacement.anchor.blockNumber,
            replacementBlockHash: event.replacement.anchor.blockHash,
            replacementNonce: event.replacement.nonce,
            durableBlock: event.durableObservation.anchor.blockNumber,
            durableBlockHash: event.durableObservation.anchor.blockHash,
            durableNonce: event.durableObservation.nonce,
            probeCount: BigInt(event.probeCount),
            invalidatedFact,
          },
        },
      };
    }
  }

  const exhaustive: never = pending;

  return exhaustive;
}
