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
  createRelayerLog,
} from '../../diagnostics/relayer-log.js';

import {
  attributeTransaction,
  type AttributionResult,
} from '../../state/attribute-transaction.js';

import type {
  CliOptions,
  CliOutcome,
} from '../cli-types.js';

import type {
  AttributionCommandArguments,
} from '../parse-attribution-arguments.js';

import {
  readAttributionTicket,
} from '../read-attribution-ticket.js';

import type {
  CliOutputHandler,
} from '../output/cli-output.js';

export async function runAttributeTransactionCommand(
  command: AttributionCommandArguments,
  output: CliOutputHandler,
  options: CliOptions,
  signal: AbortSignal,
): Promise<CliOutcome> {
  signal.throwIfAborted();

  // Parse untrusted file contents before creating clients or inspecting chain state.
  const ticket = command.mode === 'apply'
    ? await readAttributionTicket(command.ticketPath)
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
    identity: {
      chainId: config.chain.id,
      signer: config.account.address,
    },
    finality: config.finality,
    createErrorSummary: config.createErrorSummary,
    log,
    signal,
  };

  let result: AttributionResult;

  if (command.mode === 'apply') {
    result = await attributeTransaction({
      ...common,
      mode: 'apply',
      ticket: ticket!,
    });
  } else {
    result = await attributeTransaction({
      ...common,
      mode: 'dry-run',
      request: {
        requestId: randomUUID(),
        at: new Date().toISOString(),
        operator: command.operator,
        finality: config.finality,
        hint: {
          attemptId: command.attemptId,
          transactionHash: command.transactionHash,
          ...(command.blockNumber === undefined ? {} : {
            blockNumber: command.blockNumber,
          }),
        },
      },
    });
  }

  output({
    type: 'operator-attribution-result',
    result,
  });

  if (result.status === 'refused' || result.status === 'attempt-already-attributed') {
    return 'failure';
  }

  if (result.status === 'ordinary-resolution-available') {
    return 'deferred';
  }

  return 'success';
}
