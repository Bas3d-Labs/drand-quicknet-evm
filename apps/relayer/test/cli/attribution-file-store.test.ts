import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  expect,
  it,
  vi,
} from 'vitest';

import {
  attributeTransaction,
} from '../../src/state/attribute-transaction.js';

import {
  decodeAttributionTicket,
} from '../../src/state/attribution-ticket.js';

import {
  renderAttributionOutput,
} from '../../src/cli/output/attribution-output.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import {
  journalFilename,
} from '../../src/state/journal-identity.js';

import {
  assertServiceLockHeld,
} from '../../src/state/service-lock.js';

import {
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

import {
  DURABLE,
  IDENTITY,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

// The launcher test exercises real cross-process flock; this test isolates
// the command's real file-store encode/save/reload path under stable ownership.
vi.mock('../../src/state/service-lock.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/service-lock.js')>(),
  assertServiceLockHeld: vi.fn(),
}));

it('round-trips a stdout ticket, saves through the real store and recognizes it after reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attribution-store-'));

  const path = join(directory, journalFilename(IDENTITY));

  try {
    vi.mocked(assertServiceLockHeld).mockReturnValue({
      stateDirectory: directory,
      dev: 1n,
      ino: 2n,
    });

    const snapshot = await fixture();

    const before = await encodeJournalSnapshot(snapshot, IDENTITY);

    await writeFile(path, before);

    const rpc = client();

    const original = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      if (input?.blockTag === 'safe') {
        return {
          number: DURABLE.blockNumber,
        } as never;
      }

      return original(input);
    });

    Object.assign(rpc.publicClient, {
      getChainId: vi.fn().mockResolvedValue(IDENTITY.chainId),
      getBlockNumber: vi.fn().mockResolvedValue(106n),
    });

    const lines: string[] = [];

    const createErrorSummary = () => ({
      scrubText: createScrubber({
        rpcUrls: [],
      }),
    });

    const common = {
      identity: IDENTITY,
      publicClient: rpc.publicClient,
      finality: {
        type: 'safe' as const,
      },
      env: {
        QUICKNET_STATE_DIR: directory,
      },
      createErrorSummary,
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
        errorSummary: createErrorSummary(),
        destination: {
          write: (line: string) => { lines.push(line); },
        },
      }),
    };

    const preview = await attributeTransaction({
      ...common,
      mode: 'dry-run',
      request: request(),
    });

    expect(await readFile(path, 'utf8')).toBe(before);

    const output = JSON.parse(renderAttributionOutput(preview));

    const ticket = decodeAttributionTicket(JSON.stringify(output.ticket));

    const applied = await attributeTransaction({
      ...common,
      mode: 'apply',
      ticket,
    });

    expect(applied.status).toBe('committed');

    const loaded = await FileTransactionJournalStore.read({
      filePath: path,
      identity: IDENTITY,
    });

    expect(loaded.kind).toBe('present');

    if (loaded.kind !== 'present' || applied.status !== 'committed') {
      throw new Error('Missing committed snapshot.');
    }

    expect(loaded.snapshot.ledger.outcomes).toEqual([applied.outcome]);
    expect(loaded.snapshot.attempts).toEqual([]);
    expect(loaded.snapshot.durableNextNonce).toBe(5n);
    expect(await readdir(directory)).toEqual([journalFilename(IDENTITY)]);

    const after = await readFile(path, 'utf8');

    const repeated = await attributeTransaction({
      ...common,
      mode: 'apply',
      ticket,
    });

    expect(repeated).toEqual({
      status: 'already-recorded',
      outcome: applied.outcome,
    });
    expect(await readFile(path, 'utf8')).toBe(after);
    expect(lines.filter((line) => line.includes('signer_attempt_operator_attributed'))).toHaveLength(1);
    expect(lines.join('')).not.toContain(snapshot.attempts[0]!.signedTransactions[0].signedTransaction);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
