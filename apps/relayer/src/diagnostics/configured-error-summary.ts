import type {
  SummarizeErrorOptions,
} from './error-summary.js';

import {
  createScrubber,
} from './text-scrubber.js';

interface ConfiguredErrorSummaryOptions {
  rpcUrl: string;
  privateKey: string;
}

export function createConfiguredErrorSummary(
  options: ConfiguredErrorSummaryOptions,
): SummarizeErrorOptions {
  const scrubText = createScrubber({
    rpcUrls: [options.rpcUrl],
    privateKey: options.privateKey,
  });

  return Object.freeze({
    scrubText,
  });
}