import {
  isFixedHex,
} from '../shared/hex.js';

export type AnchoredReadClassification =
  | 'historical-state-unavailable'
  | 'unknown';

interface ErrorSummaryView {
  readonly message: string;
  readonly cause?: ErrorSummaryView;
}

/**
 * Diagnostic interpretation of an already-scrubbed summary.
 */
export function classifyAnchoredReadFailure(
  summary: ErrorSummaryView,
): AnchoredReadClassification {
  let current: ErrorSummaryView | undefined = summary;

  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (hasHistoricalStateMessage(current.message)) {
      return 'historical-state-unavailable';
    }

    current = current.cause;
  }

  return 'unknown';
}

function hasHistoricalStateMessage(
  message: string,
): boolean {
  for (const line of message.split('\n')) {
    let text = line.trim().toLowerCase();

    if (text.endsWith('.')) {
      text = text.slice(0, -1);
    }

    if (text === 'historical state is not available') {
      return true;
    }

    const prefix = 'historical state ';
    const suffix = ' is not available';

    if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
      continue;
    }

    let hash = text.slice(prefix.length, -suffix.length);

    if (!hash.startsWith('0x')) {
      hash = '0x' + hash;
    }

    if (isFixedHex(hash, 32)) {
      return true;
    }
  }

  return false;
}