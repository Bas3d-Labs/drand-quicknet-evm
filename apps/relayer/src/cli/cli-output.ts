import {
  summarizeErrorForOutput,
} from '../diagnostics/error-output.js';

import type {
  SummarizeErrorOptions,
} from '../diagnostics/error-summary.js';

import type {
  DaemonStartupSummary,
} from '../daemon/daemon-startup.js';

import {
  isWorkId,
} from '../execution/work-identity.js';

import type {
  ImportQuicknetRoundResult,
} from '../rounds/import-round.js';

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
  BLOCKER_PRECEDENCE,
} from '../state/signer-gate.js';

import type {
  JournalIdentity,
} from '../state/transaction-journal.js';

import {
  renderDaemonSnapshotStatusOutput,
} from './daemon-snapshot-status-output.js';

import {
  renderJournalStatusOutput,
} from './journal-status-output.js';

import type {
  RelayerStatus,
} from './read-relayer-status.js';

import type {
  SyncNonceResult,
} from './sync-nonce.js';

export type CliOutput =
  | {
      type: 'help' | 'daemon-help'
    }
  | {
      type: 'nonce-sync-result';
      identity: JournalIdentity;
      mode: 'preview' | 'apply';
      result: SyncNonceResult;
    }
  | {
      type: 'relayer-status';
      result: RelayerStatus;
    }
  | {
      type: 'import-result';
      round: bigint;
      result: ImportQuicknetRoundResult;
    }
  | {
      type: 'daemon-startup';
      summary: DaemonStartupSummary;
    };

export type CliOutputHandler = (output: CliOutput) => void;

interface NonceSyncFields {
  chainId: number;
  signer: string;
  mode: 'preview' | 'apply';
  status:
    | 'repair-available'
    | 'already-synchronized'
    | 'applied'
    | 'deferred'
    | 'refused';
  reason?: string;
  previousNextNonce?: string;
  nextNonce?: string;
  durableBlock?: string;
  durableBlockHash?: string;
  repairAt?: string;
}

const MAX_STARTUP_CONSUMERS = 25;

const NONCE_SYNC_REFUSAL_REASONS = [
  'journal-missing',
  'journal-changed',
  'retained-attempts',
  'nonce-regression',
  'anchor-regression',
  'anchor-conflict',
] as const;

const HELP = [
  'Usage:',
  '  relayer <command> [options]',
  '',
  'Commands:',
  '  import                  Import an exact Quicknet round immediately.',
  '  import-when-available   Wait for and import an exact Quicknet round.',
  '  daemon                  Watch consumers and relay requested rounds.',
  '  sync-nonce              Preview or apply a forward signer nonce repair.',
  '  status                  Inspect journal or historical daemon status.',
  '',
  'Network selection:',
  '  --network <preset>       Use an official network preset.',
  '  --network-config <file>  Use a custom network configuration.',
  '',
  'Exactly one network selection option is required for import, ' +
    'import-when-available, and daemon.',
  '',
  'Status:',
  '  relayer status --chain-id <id> --signer <address>',
  '  --source <journal|daemon-snapshot>  Override launcher source selection.',
  '  --max-age-ms <milliseconds>         Snapshot age threshold; default 120000.',
  '',
  'Without --source, status selects journal when ownership is acquired',
  'and daemon-snapshot only when lock acquisition reports contention.',
  'Automatic and journal modes require an existing state directory and lock.',
  'Use --source daemon-snapshot with --max-age-ms for deterministic selection.',
  'Status uses QUICKNET_STATE_DIR from the launching environment.',
  'It requires no private key, RPC URL, or application env file.',
  'Snapshot freshness does not establish daemon health or signing authorization.',
  '',
  'Run relayer daemon --help for daemon-specific usage.',
  'Run relayer daemon --help for daemon-specific usage.',
].join('\n');

const DAEMON_HELP = [
  'Usage:',
  '  relayer daemon --network <preset>',
  '  relayer daemon --network-config <file>',
  '',
  'Network options:',
  '  --network <preset>       Use an official network preset.',
  '  --network-config <file>  Use a custom network configuration.',
  '',
  'Exactly one network option is required.',
  '',
  'Required daemon environment variables:',
  '  QUICKNET_CONSUMERS',
  '  QUICKNET_START_BLOCK',
  '  QUICKNET_CHECKPOINT_FILE',
  '',
  'Custom network environment:',
  '  QUICKNET_RPC_URL',
  '',
  'Optional environment variables:',
  '  QUICKNET_MAX_BLOCK_RANGE',
  '  QUICKNET_POLL_INTERVAL_MS',
].join('\n');

function own(
  input: unknown,
  key: string,
): unknown {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Invalid CLI output.');
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw new TypeError('Invalid CLI output field.');
  }

  return descriptor.value;
}

function uint(
  value: unknown,
): string {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > MAX_UINT256
  ) {
    throw new TypeError('Invalid CLI integer.');
  }

  return value.toString();
}

function hex(
  value: unknown,
  bytes: number,
): string {
  if (!isFixedHex(value, bytes)) {
    throw new TypeError('Invalid CLI hex value.');
  }

  return value;
}

function positiveInteger(
  value: unknown,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError('Invalid CLI number.');
  }

  return value;
}

function finality(
  value: unknown,
): string {
  const type = own(value, 'type');
  if (type === 'safe' || type === 'finalized') {
    return type;
  }

  if (type === 'confirmations') {
    return uint(own(value, 'confirmations')) + ' confirmations';
  }

  throw new TypeError('Invalid CLI finality policy.');
}

function consumerLines(
  summary: unknown,
): string[] {
  const consumers = own(summary, 'consumers');
  if (!Array.isArray(consumers)) {
    throw new TypeError('Invalid CLI consumers.');
  }

  const length = own(consumers, 'length');
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new TypeError('Invalid CLI consumers.');
  }

  const checkpoints = own(summary, 'durableNextBlocks');

  // The collector supplies a Map. Validate its brand and avoid invoking
  // a supplied get method, including when the consumer array is empty.
  Map.prototype.has.call(checkpoints, '');

  const count = Math.min(length, MAX_STARTUP_CONSUMERS);
  const lines = ['Consumers:'];

  for (let index = 0; index < count; index += 1) {
    const consumer = hex(own(consumers, String(index)), 20);
    const nextBlock = Map.prototype.get.call(checkpoints, consumer);

    let line = '  - ' + consumer;

    if (nextBlock !== undefined) {
      line += ' (next durable block: ' + uint(nextBlock) + ')';
    }

    lines.push(line);
  }

  if (length > count) {
    lines.push('  Additional consumers omitted: ' + (length - count));
  }

  return lines;
}

function nonceSyncFields(
  output: unknown,
): NonceSyncFields {
  const identity = own(output, 'identity');
  const chainId = positiveInteger(own(identity, 'chainId'));
  const signer = hex(own(identity, 'signer'), 20);
  const mode = own(output, 'mode');

  if (mode !== 'preview' && mode !== 'apply') {
    throw new TypeError('Invalid nonce sync mode.');
  }

  const result = own(output, 'result');
  const status = own(result, 'status');

  if (status === 'already-synchronized') {
    return {
      chainId,
      signer,
      mode,
      status,
    };
  }

  if (status === 'deferred' || status === 'refused') {
    const reason = own(result, 'reason');

    const validReason = status === 'deferred'
      ? (
          reason === 'nonce-count-mismatch' ||
          reason === 'anchor-changed'
        )
      : NONCE_SYNC_REFUSAL_REASONS.some(
        (allowed) => allowed === reason,
      );
    
    if (typeof reason !== 'string' || !validReason) {
      throw new TypeError('Invalid nonce sync reason.');
    }

    return {
      chainId,
      signer,
      mode,
      status,
      reason,
    };
  }

  if (status !== 'repair-available' && status !== 'applied') {
    throw new TypeError('Invalid nonce sync status.');
  }

  if (
    (status === 'repair-available' && mode !== 'preview') ||
    (status === 'applied' && mode !== 'apply')
  ) {
    throw new TypeError('Invalid nonce sync outcome mode.');
  }

  const repair = own(result, 'repair');

  if (own(repair, 'kind') !== 'sync-nonce') {
    throw new TypeError('Invalid nonce repair kind.');
  }

  const previousNextNonce = uint(own(repair, 'previousNextNonce'));
  const nextNonce = uint(own(repair, 'nextNonce'));

  if (BigInt(nextNonce) <= BigInt(previousNextNonce)) {
    throw new TypeError('Invalid nonce repair progression.');
  }

  const observation = own(repair, 'observation');

  if (uint(own(observation, 'nonce')) !== nextNonce) {
    throw new TypeError('Invalid nonce repair observation.');
  }

  const anchor = own(observation, 'anchor');
  const durableBlock = uint(own(anchor, 'blockNumber'));
  const durableBlockHash = hex(own(anchor, 'blockHash'), 32);
  const repairAt = own(repair, 'at');

  if (typeof repairAt !== 'string') {
    throw new TypeError('Invalid nonce repair timestamp.');
  }

  const timestamp = Date.parse(repairAt);

  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== repairAt
  ) {
    throw new TypeError('Invalid nonce repair timestamp.');
  }

  return {
    chainId,
    signer,
    mode,
    status,
    previousNextNonce,
    nextNonce,
    durableBlock,
    durableBlockHash,
    repairAt,
  };
}

function renderNonceSyncOutput(
  output: unknown,
): string {
  const fields = nonceSyncFields(output);

  const lines = [
    'Nonce sync: ' + fields.status,
    'Mode: ' + fields.mode,
    'Chain ID: ' + fields.chainId,
    'Signer: ' + fields.signer,
  ];

  if (fields.reason !== undefined) {
    lines.push('Reason: ' + fields.reason);
  }

  if (fields.previousNextNonce !== undefined) {
    lines.push(
      'Previous next nonce: ' + fields.previousNextNonce,
      'Next nonce: ' + fields.nextNonce,
      'Durable block: ' + fields.durableBlock,
      'Durable block hash: ' + fields.durableBlockHash,
      (
        fields.status === 'applied'
          ? 'Repair timestamp: '
          : 'Proposed repair timestamp: '
      ) + fields.repairAt,
    );
  }

  if (fields.status === 'repair-available') {
    lines.push(
      'Preview only. No journal changes were made.',
      'Run with --apply to perform a fresh inspection and apply an eligible repair.',
    );
  }

  return lines.join('\n');
}

function renderRelayerStatus(
  result: unknown,
): string {
  switch (own(result, 'source')) {
    case 'journal':
      return renderJournalStatusOutput(result);

    case 'daemon-snapshot':
      return renderDaemonSnapshotStatusOutput(result);

    default:
      throw new TypeError('Invalid relayer status source.');
  }
}

function statusFailureFields(
  result: unknown,
): Record<string, unknown> {
  // Validate the entire result before preserving any diagnostic context.
  // The rendered text is deliberately not included in the arguments.
  renderRelayerStatus(result);

  const source = own(result, 'source');

  if (source === 'journal') {
    return {
      source,
      journal: own(result, 'journal'),
      gate: 'unknown',
    };
  }

  return {
    source,
    snapshot: own(result, 'snapshot'),
    gate: 'unknown',
  };
}

function deferredImportFields(
  result: unknown,
) {
  const reason = own(result, 'reason');

  if (reason === 'signer-unavailable') {
    const blocker = own(result, 'blocker');

    if (
      typeof blocker !== 'string' ||
      !BLOCKER_PRECEDENCE.some((allowed) => allowed === blocker)
    ) {
      throw new TypeError('Invalid signer blocker.');
    }

    return {
      reason: 'signer-unavailable' as const,
      blocker,
    };
  }

  if (reason === 'already-retained') {
    const attemptId = own(result, 'attemptId');
    const workId = own(result, 'workId');

    if (!isUuidV4(attemptId)) {
      throw new TypeError('Invalid CLI attempt ID.');
    }

    if (!isWorkId(workId)) {
      throw new TypeError('Invalid work identity.');
    }

    return {
      reason: 'already-retained' as const,
      attemptId,
      workId,
    };
  }

  throw new TypeError('Invalid deferral reason.');
}

// Construct and validate the complete output before any writer receives it.
export function renderCliOutput(
  output: CliOutput,
): string {
  const type = own(output, 'type');
  if (type === 'help') {
    return HELP;
  }

  if (type === 'daemon-help') {
    return DAEMON_HELP;
  }

  if (type === 'import-result') {
    const round = uint(own(output, 'round'));
    const result = own(output, 'result');

    const status = own(result, 'status');

    if (status === 'pending') {
      const attemptId = own(result, 'attemptId');
      const hash = hex(own(result, 'transactionHash'), 32);
      const reason = own(result, 'reason');

      if (!isUuidV4(attemptId)) {
        throw new TypeError('Invalid CLI attempt ID.');
      }

      if (
        reason !== 'broadcast-not-acknowledged' &&
        reason !== 'receipt-timeout'
      ) {
        throw new TypeError('Invalid pending reason.');
      }

      return [
        'Quicknet round ' + round + ' import is pending.',
        'Reason: ' + reason,
        'Attempt: ' + attemptId,
        'Transaction: ' + hash,
      ].join('\n');
    }

    if (status === 'deferred') {
      const fields = deferredImportFields(result);

      const lines = [
        'Quicknet round ' + round + ' import is deferred.',
        'Reason: ' + fields.reason,
      ];

      if (fields.reason === 'signer-unavailable') {
        lines.push('Signer blocker: ' + fields.blocker);
      } else {
        lines.push(
          'Retained attempt: ' + fields.attemptId,
          'Work identity: ' + fields.workId,
        );
      }

      return lines.join('\n');
    }

    const randomness = hex(own(result, 'randomness'), 32);

    if (status === 'already-stored') {
      return [
        'Quicknet round ' + round + ' is already stored.',
        'Randomness: ' + randomness,
      ].join('\n');
    }

    if (status === 'imported') {
      const hash = hex(own(result, 'transactionHash'), 32);
      const submission = own(result, 'submission');

      const lines = [
        'Imported Quicknet round ' + round + '.',
        'Randomness: ' + randomness,
        'Transaction: ' + hash,
      ];

      if (submission === 'witness') {
        lines.push('Submission: witness');
      } else if (submission === 'compressed') {
        const reason = own(result, 'fallbackReason');

        if (
          reason !== 'witness-rejected' &&
          reason !== 'witness-decode-failed'
        ) {
          throw new TypeError('Invalid fallback reason.');
        }

        lines.push(
          'Submission: compressed',
          'Fallback reason: ' + reason,
        );
      } else {
        throw new TypeError('Invalid submission method.');
      }

      return lines.join('\n');
    }

    throw new TypeError('Invalid import outcome.');
  }

  if (type === 'daemon-startup') {
    const summary = own(output, 'summary');

    return [
      'Relayer daemon starting',
      'Chain ID: ' + positiveInteger(own(summary, 'chainId')),
      'Signer: ' + hex(own(summary, 'signer'), 20),
      'Signer balance (wei): ' + uint(own(summary, 'signerBalance')),
      'Registry: ' + hex(own(summary, 'registry'), 20),
      'Registry codehash: ' +
        hex(own(summary, 'registryRuntimeCodehash'), 32),
      'Finality: ' + finality(own(summary, 'finality')),
      'Checkpoint: QUICKNET_CHECKPOINT_FILE (set)',
      'Latest head: ' + uint(own(summary, 'latestHead')),
      'Durable head: ' + uint(own(summary, 'durableHead')),
      'Start block: ' + uint(own(summary, 'startBlock')),
      'Max block range: ' + uint(own(summary, 'maxBlockRange')),
      'Poll interval (ms): ' +
        positiveInteger(own(summary, 'pollIntervalMs')),
      ...consumerLines(summary),
    ].join('\n');
  }

  if (type === 'nonce-sync-result') {
    return renderNonceSyncOutput(output);
  }

  if (type === 'relayer-status') {
    return renderRelayerStatus(own(output, 'result'));
  }

  throw new TypeError('Invalid CLI output type.');
}

// Preserve a known import outcome if rendering or writing its output fails.
export function renderOutputFailure(
  output: CliOutput,
  error: unknown,
  errorSummary?: SummarizeErrorOptions,
): string {
  let context: Record<string, unknown> = {
    output: 'unknown',
  };

  try {
    const type = own(output, 'type');

    if (type === 'relayer-status') {
      context = {
        output: type,
        ...statusFailureFields(own(output, 'result')),
      };
    } else if (type === 'nonce-sync-result') {
      context = {
        output: type,
        ...nonceSyncFields(output),
      };
    } else if (
      type === 'help' ||
      type === 'daemon-help' ||
      type === 'daemon-startup'
    ) {
      context = { output: type };
    } else if (type === 'import-result') {
      const round = uint(own(output, 'round'));
      const result = own(output, 'result');
      const status = own(result, 'status');

      if (status === 'pending') {
        const attemptId = own(result, 'attemptId');
        const transactionHash = hex(own(result, 'transactionHash'), 32);
        const reason = own(result, 'reason');

        if (!isUuidV4(attemptId)) {
          throw new TypeError('Invalid CLI attempt ID.');
        }

        if (
          reason !== 'broadcast-not-acknowledged' &&
          reason !== 'receipt-timeout'
        ) {
          throw new TypeError('Invalid pending reason.');
        }

        context = {
          output: type,
          round,
          status,
          attemptId,
          transactionHash,
          reason,
        };
      } else if (status === 'deferred') {
        const fields = deferredImportFields(result);

        context = {
          output: type,
          round,
          status,
          ...fields,
        };
      } else if (status === 'imported') {
        const randomness = hex(own(result, 'randomness'), 32);
        const transactionHash = hex(own(result, 'transactionHash'), 32);

        context = {
          output: type,
          round,
          status,
          randomness,
          transactionHash,
        };
      } else if (status === 'already-stored') {
        const randomness = hex(own(result, 'randomness'), 32);

        context = {
          output: type,
          round,
          status,
          randomness,
        };
      }
    }
  } catch {
    // Invalid output fields must not appear in the failure diagnostic.
  }

  return JSON.stringify({
    event: 'output_failed',
    code: 'CLI_OUTPUT_FAILED',
    ...context,
    err: summarizeErrorForOutput(error, errorSummary),
  });
}