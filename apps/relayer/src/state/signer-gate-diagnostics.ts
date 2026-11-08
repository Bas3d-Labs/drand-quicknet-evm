import {
  BLOCKER_PRECEDENCE,
  type SignerBlocker,
  type SignerGateDecision,
} from './signer-gate.js';

export type SignerGateDiagnostic =
  | {
      readonly kind: 'blocked';
      readonly reason: SignerBlocker;
      readonly blockers: readonly SignerBlocker[];
      readonly blockedSince: string;
    }
  | {
      readonly kind: 'released';
      readonly cleared: readonly SignerBlocker[];
      readonly blockedSince: string;
    };

/**
 * Tracks diagnostic episodes from coordinator-supplied gate decisions.
 */
export class SignerGateDiagnostics {
  blockedSince: string | null = null;

  private previousBlockers: readonly SignerBlocker[] = [];
  private readonly episodeReasons = new Set<SignerBlocker>();

  constructor(
    private readonly timestamp: () => string,
  ) {}

  observe(
    gate: SignerGateDecision,
    publish: (event: SignerGateDiagnostic) => void,
  ): void {
    const blockersChanged =
      gate.blockers.length !== this.previousBlockers.length ||
      gate.blockers.some(
        (reason, index) => reason !== this.previousBlockers[index],
      );

    if (gate.blockers.length > 0) {
      this.blockedSince ??= this.timestamp();

      for (const reason of gate.blockers) {
        this.episodeReasons.add(reason);
      }

      if (blockersChanged) {
        publish({
          kind: 'blocked',
          reason: gate.primaryReason!,
          blockers: gate.blockers,
          blockedSince: this.blockedSince,
        });
      }
    }

    this.previousBlockers = [...gate.blockers];

    if (gate.open && this.blockedSince !== null) {
      const blockedSince = this.blockedSince;

      const cleared = BLOCKER_PRECEDENCE.filter(
        (reason) => this.episodeReasons.has(reason),
      );

      publish ({
        kind: 'released',
        cleared,
        blockedSince,
      });

      this.blockedSince = null;
      this.episodeReasons.clear();
    }
  }
}