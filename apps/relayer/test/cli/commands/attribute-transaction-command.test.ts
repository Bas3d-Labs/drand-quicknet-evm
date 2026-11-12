import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRelayerClients,
} from '../../../src/chain/clients.js';

import {
  attributeTransaction,
  type AttributionResult,
} from '../../../src/state/attribute-transaction.js';

import {
  ticketForOutcome,
} from '../../../src/state/attribution-ticket.js';

import {
  runAttributeTransactionCommand,
} from '../../../src/cli/commands/attribute-transaction-command.js';

import {
  readAttributionTicket,
} from '../../../src/cli/read-attribution-ticket.js';

import {
  loadRelayerConfig,
} from '../../../src/config/config.js';

import {
  createRelayerLog,
} from '../../../src/diagnostics/relayer-log.js';

import {
  IDENTITY,
  request,
} from '../../helpers/operator-attribution-fixture.js';

import {
  maximumOutcome,
} from '../../helpers/operator-outcome-fixture.js';

vi.mock('../../../src/chain/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));
vi.mock('../../../src/state/attribute-transaction.js', () => ({
  attributeTransaction: vi.fn(),
}));
vi.mock('../../../src/cli/read-attribution-ticket.js', () => ({
  readAttributionTicket: vi.fn(),
}));
vi.mock('../../../src/config/config.js', () => ({
  loadRelayerConfig: vi.fn(),
}));
vi.mock('../../../src/diagnostics/relayer-log.js', () => ({
  createRelayerLog: vi.fn(),
}));

describe('attribution command configuration and routing', () => {
  const source = {
    type: 'preset',
    network: 'robinhood-testnet',
  } as const;

  const output = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadRelayerConfig).mockResolvedValue({
      chain: {
        id: IDENTITY.chainId,
      },
      account: {
        address: IDENTITY.signer,
      },
      finality: {
        type: 'confirmations',
        confirmations: 12n,
      },
      errorSummary: {},
      createErrorSummary: () => ({}),
    } as never);

    vi.mocked(createRelayerClients).mockReturnValue({
      publicClient: {},
    } as never);
    vi.mocked(createRelayerLog).mockReturnValue({} as never);
    vi.mocked(attributeTransaction).mockResolvedValue({
      status: 'refused',
      reason: 'journal-missing',
    });
  });

  it('takes request finality and durable selection policy from the same loaded configuration', async () => {
    const result = await runAttributeTransactionCommand({
      command: 'attribute-transaction',
      mode: 'dry-run',
      source,
      attemptId: request().hint.attemptId,
      transactionHash: request().hint.transactionHash,
      operator: 'operator',
    }, output, {}, new AbortController().signal);

    expect(result).toBe('failure');

    const options = vi.mocked(attributeTransaction).mock.calls[0]![0];

    expect(options.mode).toBe('dry-run');

    if (options.mode !== 'dry-run') {
      throw new Error('Wrong mode.');
    }

    expect(options.request.finality).toBe(options.finality);
    expect(options.finality).toEqual({
      type: 'confirmations',
      confirmations: 12n,
    });
    expect(options.identity).toEqual(IDENTITY);
    expect(createRelayerLog).toHaveBeenCalledWith(expect.objectContaining({
      destination: process.stderr,
    }));
    expect(output).toHaveBeenCalledWith({
      type: 'operator-attribution-result',
      result: {
        status: 'refused',
        reason: 'journal-missing',
      },
    });
  });

  it('rejects a bad ticket before loading configuration or creating clients', async () => {
    vi.mocked(readAttributionTicket).mockRejectedValue(new TypeError('Invalid operator attribution ticket file.'));

    await expect(runAttributeTransactionCommand({
      command: 'attribute-transaction',
      source,
      mode: 'apply',
      ticketPath: '/ticket',
    }, output, {}, new AbortController().signal)).rejects.toThrow('Invalid operator attribution ticket file.');

    expect(loadRelayerConfig).not.toHaveBeenCalled();
    expect(createRelayerClients).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    ['preview', 'success'],
    ['committed', 'success'],
    ['already-recorded', 'success'],
    ['attempt-already-attributed', 'failure'],
    ['ordinary-resolution-available', 'deferred'],
    ['refused', 'failure'],
  ] as const)('maps %s to %s after reporting its distinct disposition', async (status, expected) => {
    const outcome = maximumOutcome(0, 1n);

    let result: AttributionResult;

    switch (status) {
      case 'preview':
        result = {
          status,
          ticket: ticketForOutcome(IDENTITY, outcome),
          preview: {
            removedAttemptId: outcome.attemptId,
            previousDurableNextNonce: 1n,
            durableNextNonce: 2n,
            lastObservation: outcome.durable,
            outcome,
            supersededNoMatch: false,
            blockers: ['recovery-incomplete'],
          },
        };
        break;
      case 'attempt-already-attributed':
        result = {
          status,
          requestedRequestId: request().requestId,
          outcome,
        };
        break;
      case 'ordinary-resolution-available':
        result = {
          status,
          evidence: {
            outcome: 'success',
            transactionHash: outcome.candidateHashes[0]!,
            anchor: outcome.durable.anchor,
            inclusion: outcome.replacement.inclusion,
          },
        };
        break;
      case 'refused':
        result = {
          status,
          reason: 'journal-missing',
        };
        break;
      default:
        result = {
          status,
          outcome,
        };
    }

    vi.mocked(attributeTransaction).mockResolvedValue(result);

    expect(await runAttributeTransactionCommand({
      command: 'attribute-transaction',
      mode: 'dry-run',
      source,
      attemptId: request().hint.attemptId,
      transactionHash: request().hint.transactionHash,
      operator: 'operator',
    }, output, {}, new AbortController().signal)).toBe(expected);
    expect(output).toHaveBeenCalledWith({
      type: 'operator-attribution-result',
      result,
    });
  });
});
