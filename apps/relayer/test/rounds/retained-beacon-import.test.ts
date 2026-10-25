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

import {
  keccak256,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  drandQuicknetBeaconRegistryAbi,
  type RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  createBeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import {
  createRoundImporter,
} from '../../src/rounds/create-round-importer.js';

import {
  BroadcastRetrySchedule,
} from '../../src/state/broadcast-retry-schedule.js';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import {
  SignerRecoveryCycle,
} from '../../src/state/signer-recovery-cycle.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);
const REGISTRY = `0x${'ab'.repeat(20)}` as const;
const HASH = `0x${'aa'.repeat(32)}` as const;
const SIGNATURE = `0x${'11'.repeat(48)}` as const;
const ROUND = 20_791_007n;

describe('retained beacon import', () => {
  it('defers a round recorded by real submission without repeating RPC or transaction work', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'relayer-retained-import-'),
    );

    try {
      const identity = {
        chainId: 4663,
        signer: ACCOUNT.address,
      };

      const anchor = {
        blockNumber: 100n,
        blockHash: HASH,
      };

      const observation = {
        anchor,
        nonce: 4n,
      };

      const store = await FileTransactionJournalStore.open({
        filePath: join(directory, 'journal.json'),
        identity,
      });

      await store.save({
        version: 1,
        identity,
        baseline: observation,
        lastObservation: observation,
        nextNonce: 4n,
        durableNextNonce: 4n,
        repairs: [],
        attempts: [],
      });

      const save = vi.spyOn(store, 'save');

      const coordinator = await SignerCoordinator.create({
        identity,
        store,
        maxRetainedAttempts: 1,
        log: createRelayerLog({
          chainId: identity.chainId,
          destination: {
            write() {},
          },
        }),
        createErrorSummary: (secrets = []) => ({
          scrubText: createScrubber({
            privateKey: KEY,
            rpcUrls: [],
            secrets,
          }),
        }),
      });

      const getBlock = vi.fn().mockResolvedValue({
        number: anchor.blockNumber,
        hash: anchor.blockHash,
      });

      const getTransactionCount = vi.fn().mockResolvedValue(4);
      const getTransactionReceipt = vi.fn();

      // These methods would be reached if the importer failed to defer
      // and started fresh deployment or fulfillment checks.
      const getChainId = vi.fn().mockRejectedValue(
        new Error('Unexpected deployment verification.'),
      );

      const getCode = vi.fn().mockRejectedValue(
        new Error('Unexpected code lookup.'),
      );

      const readContract = vi.fn().mockRejectedValue(
        new Error('Unexpected contract read.'),
      );

      const request = vi.fn(async (parameters: {
        method: string;
        params: readonly Hex[];
      }) => {
        expect(parameters.method).toBe('eth_sendRawTransaction');
        expect(parameters.params).toHaveLength(1);

        return keccak256(parameters.params[0]!);
      });

      const publicClient = {
        getBlock,
        getTransactionCount,
        getTransactionReceipt,
        getChainId,
        getCode,
        readContract,
        request,
      } as unknown as PublicClient;

      const prepareTransactionRequest = vi.fn().mockResolvedValue({
        type: 'eip1559',
        gas: 150_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      });

      const walletClient = {
        prepareTransactionRequest,
      } as unknown as WalletClient;

      const signTransaction = vi.fn(ACCOUNT.signTransaction);

      const account = {
        ...ACCOUNT,
        signTransaction,
      };

      const recovery = new SignerRecoveryCycle({
        coordinator,
        schedule: new BroadcastRetrySchedule({
          initialDelayMs: 100,
          maxDelayMs: 400,
          now: () => 0,
        }),
      });

      const readChainHeads = vi.fn().mockResolvedValue({
        latestBlock: 100n,
        durableBlock: 100n,
      });

      const submitter = createBeaconSubmitter({
        publicClient,
        walletClient,
        account,
        coordinator,
        recovery,
        readChainHeads,
        maxBlockRange: 2n,
      });

      // No submission or identity helper is mocked: this creates the
      // work identity and persists the actual signed transaction.
      const submitted = await submitter.submit({
        address: REGISTRY,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [ROUND, SIGNATURE],
      }, 7);

      expect(submitted).toMatchObject({
        status: 'acknowledged',
        nonce: 4n,
      });

      expect(signTransaction).toHaveBeenCalledOnce();
      expect(prepareTransactionRequest).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();

      const before = await store.load();

      if (before.kind !== 'present') {
        throw new Error('Expected a persisted submission.');
      }

      expect(before.snapshot.attempts).toHaveLength(1);

      const retained = before.snapshot.attempts[0]!;

      expect(retained).toMatchObject({
        workId: `quicknet-round:v1:4663:${REGISTRY}:${ROUND}`,
        nonce: 4n,
        phase: 'broadcast-may-have-occurred',
      });

      expect(retained.signedTransactions).toHaveLength(1);

      // Different address casing must still locate the identity created
      // by the real submission path.
      const deployment = {
        chainId: identity.chainId,
        address: `0x${'AB'.repeat(20)}`,
      } as RegistryDeployment;

      const onProgress = vi.fn();

      const importRound = createRoundImporter({
        publicClient,
        account,
        deployment,
      })({
        submitter,
        onProgress,
      });

      const writesBeforeImport = save.mock.calls.length;

      getBlock.mockClear();
      getTransactionCount.mockClear();
      getTransactionReceipt.mockClear();
      readChainHeads.mockClear();

      expect(await importRound(ROUND)).toEqual({
        status: 'deferred',
        reason: 'already-retained',
        round: ROUND,
        attemptId: retained.attemptId,
        workId: retained.workId,
      });

      expect(getBlock).not.toHaveBeenCalled();
      expect(getTransactionCount).not.toHaveBeenCalled();
      expect(getTransactionReceipt).not.toHaveBeenCalled();
      expect(getChainId).not.toHaveBeenCalled();
      expect(getCode).not.toHaveBeenCalled();
      expect(readContract).not.toHaveBeenCalled();
      expect(readChainHeads).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();

      expect(signTransaction).toHaveBeenCalledOnce();
      expect(prepareTransactionRequest).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledTimes(writesBeforeImport);

      expect(await store.load()).toEqual(before);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });
});