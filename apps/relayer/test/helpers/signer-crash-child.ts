import {
  writeFileSync,
} from 'node:fs';

import {
  join,
} from 'node:path';

import {
  pathToFileURL,
} from 'node:url';

/**
 * Replaces only the CLI entrypoint inside a compiled test application.
 * The launcher, bootstrap, journal, coordinator, recovery, and publisher
 * remain real.
 */
export function writeSignerCrashPreload(
  directory: string,
  compiledApplication: string,
): string {
  function moduleUrl(relativePath: string): string {
    return pathToFileURL(
      join(compiledApplication, 'dist', relativePath),
    ).href;
  }

  const source = `
    import assert from 'node:assert/strict';

    import {
      createPublicClient,
      createWalletClient,
      http,
    } from 'viem';

    import {
      privateKeyToAccount,
    } from 'viem/accounts';

    import {
      openSignerRuntime,
    } from ${JSON.stringify(moduleUrl('cli/open-signer-runtime.js'))};

    import {
      createBeaconSubmitter,
    } from ${JSON.stringify(moduleUrl('rounds/create-beacon-submitter.js'))};

    import {
      createRelayerLog,
    } from ${JSON.stringify(moduleUrl('diagnostics/relayer-log.js'))};

    import {
      createScrubber,
    } from ${JSON.stringify(moduleUrl('diagnostics/text-scrubber.js'))};

    import {
      createDaemonStatusPublisher,
    } from ${JSON.stringify(moduleUrl('daemon/daemon-status-publisher.js'))};

    import {
      readSignerRuntimeObservation,
    } from ${JSON.stringify(
      moduleUrl('state/read-signer-runtime-observation.js'),
    )};

    const CHAIN_ID = 4663;
    const RUN_ID = '11111111-1111-4111-8111-111111111111';
    const OBSERVED_AT = '2000-01-01T00:00:00.000Z';
    const INITIAL_DELAY_MS = 5_000;

    export async function main(_args, _output, options) {
      const url = process.env.FAULT_RPC_URL;
      const mode = process.env.FAULT_MODE;
      const killBoundary = process.env.FAULT_PERSISTENCE_BOUNDARY;

      let persistenceArmed = false;

      const errorSummary = {
        scrubText: createScrubber({
          privateKey: '0x' + '11'.repeat(32),
          rpcUrls: url === undefined ? [] : [url],
        }),
      };

      options.onDiagnostics(errorSummary);

      assert.ok(url);
      assert.ok(
        mode === 'initial' ||
        mode === 'included' ||
        mode === 'dropped' ||
        mode === 'restored-signed' ||
        mode === 'resolve-crash' ||
        mode === 'resolve-restart' ||
        mode === 'reorg-restart' ||
        mode === 'replaced',
      );

      assert.ok(
        killBoundary === undefined ||
        killBoundary === 'temp-synced' ||
        killBoundary === 'renamed',
      );

      if (killBoundary !== undefined) {
        assert.ok(mode === 'initial' || mode === 'resolve-crash');
      }

      let clock = 0;
      let signCalls = 0;

      // Public, test-only key. Never funded or used outside this fixture.
      const originalAccount = privateKeyToAccount(
        '0x' + '11'.repeat(32),
      );

      const account = {
        ...originalAccount,
        async signTransaction(...args) {
          signCalls += 1;
          return originalAccount.signTransaction(...args);
        },
      };

      const identity = {
        chainId: CHAIN_ID,
        signer: account.address,
      };

      const publicClient = createPublicClient({
        cacheTime: 0,
        transport: http(url, {
          retryCount: 0,
          timeout: 60_000,
        }),
      });

      const walletClient = createWalletClient({
        account,
        transport: http(url, {
          retryCount: 0,
          timeout: 60_000,
        }),
      });

      const runtime = await openSignerRuntime({
        identity,
        log: createRelayerLog({
          chainId: CHAIN_ID,
          runId: RUN_ID,
          level: 'silent',
          errorSummary,
        }),
        createErrorSummary: (signedTransactions = []) => ({
          scrubText: createScrubber({
            privateKey: '0x' + '11'.repeat(32),
            rpcUrls: [url],
            secrets: signedTransactions,
          }),
        }),
        retry: {
          initialDelayMs: INITIAL_DELAY_MS,
          maxDelayMs: 60_000,
          now: () => clock,
        },
        ...(killBoundary === undefined ? {} : {
          async onPersistenceBoundary(step) {
            if (persistenceArmed && step === killBoundary) {
              await checkpoint('persistence-' + step);
            }
          },
        }),
      });

      const { coordinator } = runtime;

      const submitter = createBeaconSubmitter({
        publicClient,
        walletClient,
        account,
        coordinator,
        recovery: runtime.recovery,
        maxBlockRange: 10n,
        async readChainHeads() {
          const durable = await publicClient.getBlock({
            blockTag: 'safe',
          });

          const latest = await publicClient.getBlock({
            blockTag: 'latest',
          });

          return {
            durableBlock: durable.number,
            latestBlock: latest.number,
          };
        },
      });

      const transaction = {
        type: 'eip1559',
        to: account.address,
        data: '0x1234',
        value: 0n,
        gas: 100_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      };

      async function checkpoint(name, result = null) {
        const response = await fetch(url + '/checkpoint', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name,
            clock,
            signCalls,
            status: coordinator.status,
            canBroadcast: coordinator.canBroadcast,
            result: result === null ? null : {
              broadcast: result.broadcast === null ? null : {
                status: result.broadcast.status,
                attemptId: result.broadcast.attemptId,
                transactionHash: result.broadcast.transactionHash,
              },
              retryDelayMs: result.retryDelayMs,
              replacementResolution:
                result.inspection.status === 'resolution-available' &&
                result.inspection.evidence.outcome === 'replaced'
                  ? {
                      outcome: 'replaced',
                      replacementTransactionHash:
                        result.inspection.evidence.replacementTransactionHash,
                      nonceAtAnchor:
                        result.inspection.evidence.nonceAtAnchor,
                      anchor: {
                        blockNumber:
                          result.inspection.evidence.anchor.blockNumber,
                        blockHash:
                          result.inspection.evidence.anchor.blockHash,
                      },
                      inclusion: {
                        blockNumber:
                          result.inspection.evidence.inclusion.blockNumber,
                        blockHash:
                          result.inspection.evidence.inclusion.blockHash,
                      },
                    }
                  : null,
            },
          }, (_key, value) => (
            typeof value === 'bigint' ? value.toString() : value
          )),
          signal: AbortSignal.timeout(30_000),
        });

        assert.equal(response.status, 200);

        // The parent deliberately withholds this response until it has
        // inspected the persisted state and selected the next boundary.
        await response.json();
      }

      if (mode === 'initial') {
        await submitter.recover();

        assert.equal(coordinator.journalInitialized, true);
        assert.equal(coordinator.status.open, true);

        const prepared = await coordinator.prepareAttempt({
          account,
          transaction,
        });

        const publicationFailures = [];

        const publisher = createDaemonStatusPublisher({
          identity,
          runId: RUN_ID,
          now: () => Date.parse(OBSERVED_AT),
          onFailure(error) {
            publicationFailures.push(error);
          },
        });

        publisher.onInitialized(
          () => readSignerRuntimeObservation(coordinator),
        );

        await publisher.publish();
        assert.equal(publicationFailures.length, 0);

        await checkpoint('prepared');
        persistenceArmed = true;

        // Depending on the case, the parent kills this process while
        // persistence is held at a boundary, or after the RPC fixture
        // receives the request. Neither suspended operation is released.
        await coordinator.broadcastAttempt({
          publicClient,
          attemptId: prepared.attemptId,
        });

        throw new Error('Initial broadcast unexpectedly returned.');
      }

      if (mode === 'resolve-restart') {
        assert.equal(coordinator.journalInitialized, true);
        assert.equal(coordinator.status.open, false);
        assert.equal(coordinator.canBroadcast, false);

        // Even an already-cleared journal must establish fresh recovery
        // and inclusion checks before preparation is authorized.
        await assert.rejects(
          coordinator.prepareAttempt({ account, transaction }),
          /signer gate must be open/,
        );

        assert.equal(signCalls, 0);
        await checkpoint('opened');

        const resolved = await submitter.recover();
        await checkpoint('resolved', resolved);

        assert.equal(signCalls, 0);
        return 'success';
      }

      if (mode === 'reorg-restart') {
        assert.equal(coordinator.journalInitialized, true);
        assert.equal(coordinator.attempts.length, 1);
        assert.equal(coordinator.attempts[0].phase, 'included');
        assert.equal(coordinator.status.open, false);
        assert.equal(coordinator.canBroadcast, false);

        await assert.rejects(
          coordinator.prepareAttempt({ account, transaction }),
          /signer gate must be open/,
        );

        // Included attempts are not broadcast candidates, even before
        // considering whether fresh recovery has completed.
        await assert.rejects(
          coordinator.broadcastAttempt({
            publicClient,
            attemptId: coordinator.attempts[0].attemptId,
          }),
          /Broadcast does not match a recorded attempt/,
        );

        await checkpoint('opened');

        // This pass contradicts the saved inclusion and starts the
        // restored attempt's retry schedule. It grants no send permit.
        const invalidated = await submitter.recover();
        await checkpoint('reorg-invalidated', invalidated);

        // Inspect the now-unresolved attempt again, without advancing
        // the clock. Fresh evidence can authorize broadcasting, but
        // the retry delay must still prevent a send.
        const authorized = await submitter.recover();
        await checkpoint('reorg-authorized', authorized);

        clock = INITIAL_DELAY_MS - 1;
        const before = await submitter.recover();
        await checkpoint('retry-before', before);

        clock = INITIAL_DELAY_MS;
        const due = await submitter.recover();
        await checkpoint('rebroadcast', due);

        assert.equal(signCalls, 0);
        return 'success';
      }

      assert.equal(coordinator.journalInitialized, true);
      assert.equal(coordinator.attempts.length, 1);
      assert.equal(coordinator.status.open, false);
      assert.equal(coordinator.canBroadcast, false);

      // A restored journal does not inherit preparation or send authority.
      await assert.rejects(
        coordinator.prepareAttempt({ account, transaction }),
        /signer gate must be open/,
      );

      await assert.rejects(
        coordinator.broadcastAttempt({
          publicClient,
          attemptId: coordinator.attempts[0].attemptId,
        }),
        /Fresh reconciliation is required/,
      );

      assert.equal(signCalls, 0);
      await checkpoint('opened');

      if (mode === 'restored-signed') {
        // A signed attempt is immediately retry-eligible, but only
        // fresh recovery can authorize its first broadcast.
        const due = await submitter.recover();
        await checkpoint('rebroadcast', due);
      } else if (
        mode === 'included' ||
        mode === 'resolve-crash' ||
        mode === 'replaced'
      ) {
        const included = await submitter.recover();
        await checkpoint('included', included);

        // Opening and non-durable inclusion persistence have completed.
        // The parent now exposes the receipt block as durable.
        if (mode === 'resolve-crash') {
          persistenceArmed = true;
        }

        const resolved = await submitter.recover();

        if (mode === 'resolve-crash') {
          throw new Error('Resolution unexpectedly passed the kill boundary.');
        }

        await checkpoint('resolved', resolved);
      } else {
        const start = await submitter.recover();
        await checkpoint('retry-start', start);

        clock = INITIAL_DELAY_MS - 1;
        const before = await submitter.recover();
        await checkpoint('retry-before', before);

        clock = INITIAL_DELAY_MS;
        const due = await submitter.recover();
        await checkpoint('rebroadcast', due);
      }

      assert.equal(signCalls, 0);
      return 'success';
    }
  `;

  const preload = join(directory, 'signer-crash-preload.mjs');

  writeFileSync(preload, `
    import { registerHooks } from 'node:module';

    const cliUrl = ${JSON.stringify(moduleUrl('cli/cli.js'))};
    const source = ${JSON.stringify(source)};

    registerHooks({
      load(url, context, nextLoad) {
        if (url === cliUrl) {
          return {
            format: 'module',
            source,
            shortCircuit: true,
          };
        }

        return nextLoad(url, context);
      },
    });
  `);

  return preload;
}