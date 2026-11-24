import {
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRelayerClients,
} from '../../../src/chain/clients.js';

import {
  loadRelayerConfig,
} from '../../../src/config/config.js';

import {
  createScrubber,
} from '../../../src/diagnostics/text-scrubber.js';

import * as logging from '../../../src/diagnostics/relayer-log.js';

import {
  runAcceptUnattributedCommand,
} from '../../../src/cli/commands/accept-unattributed-command.js';

import {
  readAcceptanceTicket,
} from '../../../src/cli/read-acceptance-ticket.js';

import {
  acceptUnattributed,
} from '../../../src/state/accept-unattributed.js';

import {
  FileTransactionJournalStore,
} from '../../../src/state/file-transaction-journal-store.js';

import {
  assertServiceLockHeld,
} from '../../../src/state/service-lock.js';

import {
  SignerRestartRequiredError,
} from '../../../src/state/signer-restart-required-error.js';

import * as completion from '../../../src/state/write-completion.js';

import {
  DURABLE,
  IDENTITY,
  client,
  fixture,
} from '../../helpers/operator-attribution-fixture.js';

import {
  acceptanceRequest,
} from '../../helpers/operator-acceptance-fixture.js';

vi.mock('../../../src/chain/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));
vi.mock('../../../src/config/config.js', () => ({
  loadRelayerConfig: vi.fn(),
}));
vi.mock('../../../src/cli/read-acceptance-ticket.js', () => ({
  readAcceptanceTicket: vi.fn(),
}));
vi.mock('../../../src/state/file-transaction-journal-store.js', () => ({
  FileTransactionJournalStore: { read: vi.fn(), open: vi.fn() },
}));
vi.mock('../../../src/state/service-lock.js', async (original) => ({
  ...await original<typeof import('../../../src/state/service-lock.js')>(),
  assertServiceLockHeld: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it(
  'reports committed completion failure and a manual rerun applies nothing',
  async () => {
    let snapshot = await fixture();

    const rpc = client(200n);

    const getBlock = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      if (input?.blockTag === 'safe') {
        return { number: DURABLE.blockNumber } as never;
      }

      return getBlock(input);
    });
    Object.assign(rpc.publicClient, {
      getChainId: vi.fn().mockResolvedValue(IDENTITY.chainId),
      getBlockNumber: vi.fn().mockResolvedValue(106n),
    });

    const save = vi.fn(async (next: typeof snapshot) => {
      snapshot = next;
    });

    vi.mocked(FileTransactionJournalStore.read).mockImplementation(
      async () => ({ kind: 'present', snapshot }),
    );
    vi.mocked(FileTransactionJournalStore.open).mockResolvedValue({
      load: async () => ({ kind: 'present', snapshot }),
      save,
    } as unknown as FileTransactionJournalStore);
    vi.mocked(assertServiceLockHeld).mockReturnValue({
      stateDirectory: '/verified-state', dev: 1n, ino: 2n,
    });
    vi.stubEnv('QUICKNET_STATE_DIR', '/verified-state');
    vi.stubEnv('QUICKNET_MAX_BLOCK_RANGE', '2');

    const createErrorSummary = (secrets: readonly string[] = []) => ({
      scrubText: createScrubber({ rpcUrls: [], secrets }),
    });

    const log = logging.createRelayerLog({
      chainId: IDENTITY.chainId,
      errorSummary: createErrorSummary(),
      destination: { write() {} },
    });

    vi.spyOn(logging, 'createRelayerLog').mockReturnValue(log);
    vi.mocked(loadRelayerConfig).mockResolvedValue({
      chain: { id: IDENTITY.chainId },
      account: { address: IDENTITY.signer },
      finality: { type: 'safe' },
      errorSummary: createErrorSummary(),
      createErrorSummary,
    } as never);
    vi.mocked(createRelayerClients).mockReturnValue({
      publicClient: rpc.publicClient,
    } as never);

    const preview = await acceptUnattributed({
      mode: 'dry-run',
      request: acceptanceRequest(),
      publicClient: rpc.publicClient,
      maxBlockRange: 2n,
      identity: IDENTITY,
      finality: { type: 'safe' },
      createErrorSummary,
      log,
    });

    if (preview.status !== 'preview') {
      throw new Error('Missing acceptance preview.');
    }

    vi.mocked(readAcceptanceTicket).mockResolvedValue(preview.ticket);

    const command = {
      command: 'accept-unattributed' as const,
      mode: 'apply' as const,
      source: {
        type: 'preset' as const,
        network: 'robinhood-testnet' as const,
      },
      ticketPath: '/ticket',
    };

    const output = vi.fn();

    vi.spyOn(completion, 'describeWriteCompletion')
      .mockImplementationOnce(() => {
        throw new Error('Injected acknowledged completion fault');
      });

    const first = runAcceptUnattributedCommand(
      command, output, {}, new AbortController().signal,
    );

    await expect(first).rejects.toBeInstanceOf(SignerRestartRequiredError);
    await expect(first).rejects.toMatchObject({
      message:
        'Journal persistence was acknowledged, but coordinator ' +
        'completion failed. The committed journal is retained. ' +
        'Restart the relayer to reload it and run recovery; ' +
        'persistence retry is unavailable.',
    });
    expect(output).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(snapshot.ledger.outcomes).toEqual([preview.preview.outcome]);
    expect(snapshot.attempts).toEqual([]);

    const committed = structuredClone(snapshot);

    const rpcCalls = rpc.getBlock.mock.calls.length;

    const rerun = await runAcceptUnattributedCommand(
      command, output, {}, new AbortController().signal,
    );

    expect(rerun).toBe('success');
    expect(output).toHaveBeenCalledExactlyOnceWith({
      type: 'operator-acceptance-result',
      result: {
        status: 'already-recorded',
        outcome: preview.preview.outcome,
      },
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual(committed);
    expect(rpc.getBlock).toHaveBeenCalledTimes(rpcCalls);
  },
);
