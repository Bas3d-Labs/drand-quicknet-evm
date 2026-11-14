import {
  randomUUID,
} from 'node:crypto';

import process from 'node:process';

import {
  createRelayerClients,
} from '../../chain/clients.js';

import {
  loadRelayerConfig,
} from '../../config/config.js';

import {
  parseMaxBlockRange,
} from '../../config/daemon-config.js';

import {
  createRelayerLog,
} from '../../diagnostics/relayer-log.js';

import {
  acceptUnattributed,
  type AcceptanceResult,
} from '../../state/accept-unattributed.js';

import type {
  CliOptions,
  CliOutcome,
} from '../cli-types.js';

import type {
  AcceptanceCommandArguments,
} from '../parse-acceptance-arguments.js';

import {
  readAcceptanceTicket,
} from '../read-acceptance-ticket.js';

import type {
  CliOutputHandler,
} from '../output/cli-output.js';

export async function runAcceptUnattributedCommand(
  command: AcceptanceCommandArguments,
  output: CliOutputHandler,
  options: CliOptions,
  signal: AbortSignal,
): Promise<CliOutcome> {
  signal.throwIfAborted();

  // Parse untrusted file contents before creating clients or inspecting chain state.
  const ticket = command.mode === 'apply'
    ? await readAcceptanceTicket(command.ticketPath)
    : undefined;

  const config = await loadRelayerConfig({
    source: command.source,
    ...(options.onDiagnostics === undefined ? {} : {
      onDiagnostics: options.onDiagnostics,
    }),
  });

  signal.throwIfAborted();

  const clients = createRelayerClients(config);

  const log = createRelayerLog({
    chainId: config.chain.id,
    level: process.env.QUICKNET_LOG_LEVEL ?? 'info',
    errorSummary: config.errorSummary,
    destination: process.stderr,
  });

  const common = {
    publicClient: clients.publicClient,
    maxBlockRange: parseMaxBlockRange(process.env.QUICKNET_MAX_BLOCK_RANGE),
    identity: {
      chainId: config.chain.id,
      signer: config.account.address,
    },
    finality: config.finality,
    createErrorSummary: config.createErrorSummary,
    log,
    signal,
  };

  let result: AcceptanceResult;

  if (command.mode === 'apply') {
    result = await acceptUnattributed({
      ...common,
      mode: 'apply',
      ticket: ticket!,
    });
  } else {
    result = await acceptUnattributed({
      ...common,
      mode: 'dry-run',
      request: {
        requestId: randomUUID(),
        at: new Date().toISOString(),
        operator: command.operator,
        finality: config.finality,
        attemptId: command.attemptId,
      },
    });
  }

  output({
    type: 'operator-acceptance-result',
    result,
  });

  if (result.status === 'refused' || result.status === 'attempt-already-accounted') {
    return 'failure';
  }

  if (result.status === 'ordinary-resolution-available' || result.status === 'deferred') {
    return 'deferred';
  }

  return 'success';
}
