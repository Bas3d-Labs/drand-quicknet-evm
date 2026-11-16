import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
  WalletClient,
} from 'viem';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  FutureRoundScheduler,
} from '../../src/daemon/future-round-scheduler.js';

import {
  processQuicknetRequestsWithOutcomes,
} from '../../src/consumers/request-processor.js';

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
  TransactionManager,
} from '../../src/state/transaction-manager.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  ACCOUNT,
  IDENTITY,
  anchor,
  client,
  fixture,
} from '../helpers/operator-attribution-fixture.js';

const REGISTRY = `0x${'33'.repeat(20)}` as const;

const CONSUMER = `0x${'22'.repeat(20)}` as const;

describe('scheduled retry through production retained-work lookup', () => {
  it('deduplicates scheduled, soft and durable calls after a real manager reload', async () => {
    const initial = await fixture();

    const workId = createBeaconWorkId({
      chainId: IDENTITY.chainId,
      registry: REGISTRY,
      round: 100n,
    });

    const snapshot = await decodeJournalSnapshot(await encodeJournalSnapshot({
      ...initial,
      attempts: initial.attempts.map((attempt) => ({
        ...attempt,
        workId,
      })),
    }, IDENTITY), IDENTITY);

    const createErrorSummary = () => ({
      scrubText: createScrubber({
        rpcUrls: [],
        secrets: [],
      }),
    });

    const prepare = vi.fn(() => {
      throw new Error('Duplicate preparation');
    });

    const rpc = client();

    const publicClient = rpc.publicClient as unknown as PublicClient;

    const readChainHeads = async () => ({
      latestBlock: 104n,
      durableBlock: 104n,
    });

    const manager = await TransactionManager.create({
      identity: IDENTITY,
      maxRetainedAttempts: 16,
      createErrorSummary,
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
        errorSummary: createErrorSummary(),
        destination: {
          write: () => {},
        },
      }),
      store: {
        load: async () => ({
          kind: 'present',
          snapshot,
        }),
        save: vi.fn(),
      },
      publicClient,
      walletClient: {
        prepareTransactionRequest: prepare,
      } as unknown as WalletClient,
      account: ACCOUNT,
      readChainHeads,
      maxBlockRange: 1n,
      retry: {
        initialDelayMs: 1000,
        maxDelayMs: 10000,
      },
    });

    const submitter = createBeaconSubmitter({
      publicClient,
      readChainHeads,
      manager,
    });

    const run = createRoundImporter({
      publicClient,
      account: ACCOUNT,
      deployment: {
        chainId: IDENTITY.chainId,
        address: REGISTRY,
        runtimeCodehash: anchor(1n).blockHash,
        verifierAddress: ACCOUNT.address,
        verifierRuntimeCodehash: anchor(2n).blockHash,
      },
      deferFutureRounds: true,
    })({
      submitter,
    });

    let now = Number(roundScheduledTime(100n) * 1000n) - 1000;

    const queue = new FutureRoundScheduler({
      chainId: IDENTITY.chainId,
      registry: REGISTRY,
      now: () => now,
    });

    const request = {
      consumer: CONSUMER,
      round: 100n,
      blockNumber: 99n,
      transactionHash: anchor(3n).blockHash,
      logIndex: 0,
    };

    // Fresh in-memory state rediscovers the waiting request after restart.
    await processQuicknetRequestsWithOutcomes({
      importRound: run,
      requests: [request],
      waiting: queue,
      waitingSource: 'soft',
    });

    expect(queue.size).toBe(1);

    now += 1000;

    const scheduled = await queue.dispatch(run);

    expect(scheduled.outcomes[0]).toMatchObject({
      status: 'returned',
      result: {
        status: 'deferred',
        reason: 'already-retained',
        workId,
      },
    });

    for (const source of ['soft', 'durable'] as const) {
      const outcomes = await processQuicknetRequestsWithOutcomes({
        importRound: run,
        requests: [request],
        waiting: queue,
        waitingSource: source,
      });

      expect(outcomes[0]).toMatchObject({
        status: 'deferred',
        reason: 'already-retained',
        workId,
      });
    }

    expect(prepare).not.toHaveBeenCalled();
    expect(submitter.findRetainedWork(workId)?.attemptId).toBe(initial.attempts[0]!.attemptId);
    expect(queue.size).toBe(0);
  });
});
