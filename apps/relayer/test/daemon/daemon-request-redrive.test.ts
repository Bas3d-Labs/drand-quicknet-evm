import {
  mkdtemp,
  rm,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

// Keep the scan, checkpoint, importer lookup and coordinator real. The leaf
// importer stands in for fetching, simulating and submitting a beacon.
vi.mock('../../src/rounds/import-round-when-available.js', () => ({
  importQuicknetRoundWhenAvailable: vi.fn(),
}));

import {
  runDaemonIteration,
} from '../../src/daemon/daemon-iteration.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  createBeaconWorkId,
} from '../../src/rounds/beacon-work-identity.js';

import {
  createBeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import {
  createRoundImporter,
} from '../../src/rounds/create-round-importer.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../../src/rounds/import-round-when-available.js';

import {
  FileCheckpointStore,
} from '../../src/state/file-checkpoint-store.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

import {
  ACCOUNT,
  DURABLE,
  IDENTITY,
  anchor,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

const ROUND = 100n;

const REQUEST_BLOCK = 99n;

const CONSUMER = '0x2222222222222222222222222222222222222222';

const REGISTRY = '0x3333333333333333333333333333333333333333';

const DEPLOYMENT: RegistryDeployment = {
  chainId: IDENTITY.chainId,
  address: REGISTRY,
  runtimeCodehash: anchor(1n).blockHash,
  verifierAddress: ACCOUNT.address,
  verifierRuntimeCodehash: anchor(2n).blockHash,
};

describe('durable request re-drive after ordinary attempt removal', () => {
  it.each(['failed', 'deferred', 'completed'] as const)(
    'rescans after attribution and retains the checkpoint after a %s import',
    async (result) => {
      const directory = await mkdtemp(join(tmpdir(), 'request-redrive-'));

      try {
        const checkpointOptions = {
          filePath: join(directory, 'checkpoint.json'),
          deployment: DEPLOYMENT,
        };

        const initial = await fixture();

        const workId = createBeaconWorkId({
          chainId: IDENTITY.chainId,
          registry: DEPLOYMENT.address,
          round: ROUND,
        });

        let stored: TransactionJournalSnapshot = {
          ...initial,
          attempts: initial.attempts.map((attempt) => ({ ...attempt, workId })),
        };

        const createErrorSummary = () => ({
          scrubText: createScrubber({ rpcUrls: [], secrets: [] }),
        });

        const coordinator = await SignerCoordinator.create({
          identity: IDENTITY,
          maxRetainedAttempts: 16,
          createErrorSummary,
          log: createRelayerLog({
            chainId: IDENTITY.chainId,
            errorSummary: createErrorSummary(),
            destination: { write: () => {} },
          }),
          store: {
            load: async () => ({ kind: 'present', snapshot: stored }),
            save: async (next) => {
              stored = await decodeJournalSnapshot(
                await encodeJournalSnapshot(next, IDENTITY),
                IDENTITY,
              );
            },
          },
        });

        const readContract = vi.fn<PublicClient['readContract']>()
          .mockResolvedValue(false);

        const getLogs = vi.fn<PublicClient['getLogs']>()
          .mockResolvedValue([{
            address: CONSUMER,
            args: { round: ROUND },
            blockNumber: REQUEST_BLOCK,
            transactionHash: anchor(3n).blockHash,
            logIndex: 0,
          }] as never);

        const rpc = client();

        const publicClient = {
          ...rpc.publicClient,
          getLogs,
          readContract,
        } as unknown as PublicClient;

        const submitter = createBeaconSubmitter({
          publicClient,
          readChainHeads: async () => ({ latestBlock: 104n, durableBlock: 104n }),
          manager: {
            get status() {
              return {
                ...coordinator.status,
                chainId: IDENTITY.chainId,
                journalInitialized: true,
                busy: false,
                attempts: coordinator.attempts,
              };
            },
            reconcile: vi.fn(),
            submit: vi.fn(),
          },
        });

        expect(submitter.findRetainedWork(workId)).toMatchObject({
          attemptId: initial.attempts[0]!.attemptId,
          workId,
          nonce: 4n,
        });

        const bindRoundImporter = createRoundImporter({
          publicClient,
          account: ACCOUNT,
          deployment: DEPLOYMENT,
        });

        const run = async () => runDaemonIteration({
          publicClient,
          submitter,
          bindRoundImporter,
          deployment: DEPLOYMENT,
          checkpointStore: await FileCheckpointStore.open(checkpointOptions),
          consumer: CONSUMER,
          startBlock: REQUEST_BLOCK,
          maxBlockRange: 20n,
          finality: { type: 'safe' },
          // A soft cursor far ahead must not skip the durable request.
          softCursor: { nextBlock: 1_000n },
          readChainHeads: async () => ({ latestBlock: 104n, durableBlock: 104n }),
        });

        const checkpoint = await FileCheckpointStore.open(checkpointOptions);

        await checkpoint.save(CONSUMER, REQUEST_BLOCK);

        const leaf = vi.mocked(importQuicknetRoundWhenAvailable);

        leaf.mockReset();

        const first = await run();

        expect(first.durableNextBlock).toBe(REQUEST_BLOCK);
        expect(first.durableScan?.reconciliation?.imports[0]).toMatchObject({
          status: 'deferred',
          reason: 'already-retained',
          workId,
        });
        expect(leaf).not.toHaveBeenCalled();

        // Removal is performed by the actual A-hint inspector/planner/save path.
        const removal = await coordinator.recover({
          publicClient: rpc.publicClient,
          anchor: DURABLE,
          maxBlockRange: 1n,
          attribution: request(),
        });

        expect(removal.status).toBe('operator-attribution-committed');
        expect(coordinator.attempts).toEqual([]);
        expect(submitter.findRetainedWork(workId)).toBeNull();
        expect(stored.attempts).toEqual([]);
        expect(stored.ledger.outcomes).toHaveLength(1);
        expect(stored.ledger.obligations).toEqual([]);
        expect(coordinator.status.recoveryComplete).toBe(false);

        const failure = new Error('import unavailable');

        if (result === 'failed') {
          leaf.mockRejectedValueOnce(failure);
        } else if (result === 'deferred') {
          leaf.mockResolvedValueOnce({
            status: 'deferred',
            reason: 'signer-unavailable',
            blocker: 'recovery-incomplete',
            round: ROUND,
          });
        } else {
          leaf.mockResolvedValueOnce({
            status: 'already-stored',
            round: ROUND,
            randomness: anchor(4n).blockHash,
          });
        }

        if (result === 'failed') {
          await expect(run()).rejects.toThrow(failure);
        } else {
          expect((await run()).durableNextBlock).toBe(REQUEST_BLOCK);
        }

        expect(leaf).toHaveBeenCalledTimes(1);
        expect(leaf.mock.calls[0]![0]).toMatchObject({ round: ROUND, submitter });

        const reloaded = await FileCheckpointStore.open(checkpointOptions);

        expect(await reloaded.load(CONSUMER)).toBe(REQUEST_BLOCK);

        // Even a completed latest import above did not prove durable storage.
        readContract.mockResolvedValue(true);
        leaf.mockResolvedValueOnce({
          status: 'already-stored',
          round: ROUND,
          randomness: anchor(4n).blockHash,
        });

        expect((await run()).durableNextBlock).toBe(105n);
        expect(leaf).toHaveBeenCalledTimes(2);
        expect(getLogs).toHaveBeenCalledTimes(3);

        for (const [scan] of getLogs.mock.calls) {
          expect(scan).toMatchObject({
            address: [CONSUMER],
            fromBlock: REQUEST_BLOCK,
            toBlock: 104n,
          });
        }

        expect(readContract).toHaveBeenCalledTimes(3);

        for (const [read] of readContract.mock.calls) {
          expect(read).toMatchObject({
            address: REGISTRY,
            args: [ROUND],
            blockNumber: 104n,
            functionName: 'isStored',
          });
        }

        const finalStore = await FileCheckpointStore.open(checkpointOptions);

        expect(await finalStore.load(CONSUMER)).toBe(105n);
        expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
