import {
  afterEach,
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
  acceptUnattributed,
  type AcceptanceResult,
} from '../../../src/state/accept-unattributed.js';

import {
  ticketForOutcome,
} from '../../../src/state/acceptance-ticket.js';

import {
  runAcceptUnattributedCommand,
} from '../../../src/cli/commands/accept-unattributed-command.js';

import {
  readAcceptanceTicket,
} from '../../../src/cli/read-acceptance-ticket.js';

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
  maximumAcceptedOutcome,
} from '../../helpers/operator-acceptance-fixture.js';

vi.mock('../../../src/chain/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));
vi.mock('../../../src/state/accept-unattributed.js', () => ({
  acceptUnattributed: vi.fn(),
}));
vi.mock('../../../src/cli/read-acceptance-ticket.js', () => ({
  readAcceptanceTicket: vi.fn(),
}));
vi.mock('../../../src/config/config.js', () => ({
  loadRelayerConfig: vi.fn(),
}));
vi.mock('../../../src/diagnostics/relayer-log.js', () => ({
  createRelayerLog: vi.fn(),
}));

describe('acceptance command configuration and routing', () => {
  const source = {
    type: 'preset',
    network: 'robinhood-testnet',
  } as const;

  const output = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('QUICKNET_MAX_BLOCK_RANGE', '17');
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
    vi.mocked(acceptUnattributed).mockResolvedValue({
      status: 'refused',
      reason: 'journal-missing',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the same configured finality for the request and D', async () => {
    const result = await runAcceptUnattributedCommand({
      command: 'accept-unattributed',
      mode: 'dry-run',
      source,
      attemptId: request().hint.attemptId,
      operator: 'operator',
    }, output, {}, new AbortController().signal);

    expect(result).toBe('failure');

    const options = vi.mocked(acceptUnattributed).mock.calls[0]![0];

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
    expect(options.maxBlockRange).toBe(17n);
    expect(createRelayerLog).toHaveBeenCalledWith(expect.objectContaining({
      destination: process.stderr,
    }));
    expect(output).toHaveBeenCalledWith({
      type: 'operator-acceptance-result',
      result: {
        status: 'refused',
        reason: 'journal-missing',
      },
    });
  });

  it('rejects a bad ticket before loading configuration or creating clients', async () => {
    vi.mocked(readAcceptanceTicket).mockRejectedValue(
      new TypeError('Invalid operator acceptance ticket file.'),
    );

    await expect(runAcceptUnattributedCommand({
      command: 'accept-unattributed',
      source,
      mode: 'apply',
      ticketPath: '/ticket',
    }, output, {}, new AbortController().signal))
      .rejects.toThrow('Invalid operator acceptance ticket file.');

    expect(loadRelayerConfig).not.toHaveBeenCalled();
    expect(createRelayerClients).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    ['preview', 'success'],
    ['committed', 'success'],
    ['already-recorded', 'success'],
    ['attempt-already-accounted', 'failure'],
    ['ordinary-resolution-available', 'deferred'],
    ['refused', 'failure'],
    ['deferred', 'deferred'],
  ] as const)('maps %s to %s after reporting', async (status, expected) => {
    const outcome = maximumAcceptedOutcome(0, 1n);

    let result: AcceptanceResult;

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
            unattributedActivityRemains: false,
            blockers: ['recovery-incomplete'],
          },
        };
        break;
      case 'attempt-already-accounted':
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
            inclusion: outcome.durable.anchor,
          },
        };
        break;
      case 'deferred':
        result = {
          status,
          reason: 'search-incomplete',
          gap: {
            boundary: outcome.lowerBound.anchor,
            durable: outcome.durable.anchor,
            blocks: 10n,
            budget: 1n,
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

    vi.mocked(acceptUnattributed).mockResolvedValue(result);

    expect(await runAcceptUnattributedCommand({
      command: 'accept-unattributed',
      mode: 'dry-run',
      source,
      attemptId: request().hint.attemptId,
      operator: 'operator',
    }, output, {}, new AbortController().signal)).toBe(expected);
    expect(output).toHaveBeenCalledWith({
      type: 'operator-acceptance-result',
      result,
    });
  });
});
