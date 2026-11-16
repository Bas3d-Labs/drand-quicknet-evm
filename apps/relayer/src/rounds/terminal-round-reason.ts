export type TerminalRoundReason = 'round-zero';

/** Closed terminal list for decoded uint64 request rounds. */
export function terminalRoundReason(
  round: bigint,
): TerminalRoundReason | undefined {
  if (round === 0n) {
    return 'round-zero';
  }

  return undefined;
}
