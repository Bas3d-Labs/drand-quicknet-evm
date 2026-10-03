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

export type AttemptResolutionEvidence = InclusionEvidence & (
  | {
      readonly outcome: 'success' | 'reverted';
      readonly transactionHash: Hash;
    }
  | {
      readonly outcome: 'superseded';
      readonly consumingTransactionHash: Hash;
      readonly nonceAtAnchor: bigint;
    }
);