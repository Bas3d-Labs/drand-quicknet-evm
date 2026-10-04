import type { Hash } from 'viem';

import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

// Diagnostic representations of evidence validated by the reconciler.
// Project checks structure and consistency. It does not prove canonicality.
interface InclusionEvidence {
  readonly anchor: Readonly<BlockAnchor>;
  readonly inclusion: Readonly<BlockAnchor>;
}

/**
 * `replaced` means a transaction with a different hash from the recorded
 * attempt, sent from the same signer, consumed the recorded nonce at the
 * configured durable anchor.
 * 
 * This describes an observed outcome. It does not identify who submitted
 * that transaction or why, and it does not imply that the relayer creates 
 * the replacements.
 */
export type AttemptResolutionEvidence = InclusionEvidence & (
  | {
      readonly outcome: 'success' | 'reverted';
      readonly transactionHash: Hash;
    }
  | {
      readonly outcome: 'replaced';
      readonly replacementTransactionHash: Hash;
      readonly nonceAtAnchor: bigint;
    }
);