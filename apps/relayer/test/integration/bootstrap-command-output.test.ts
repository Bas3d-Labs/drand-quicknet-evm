import {
  execFileSync,
  spawnSync,
} from 'node:child_process';

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import {
  join,
} from 'node:path';

import process from 'node:process';

import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';

import {
  afterAll,
  beforeAll,
  expect,
  it,
} from 'vitest';

import {
  compileRelayerFixture,
} from '../helpers/compiled-relayer.js';

const APP = fileURLToPath(
  new URL('../..', import.meta.url),
);

const MODULE_PATHS = {
  bootstrap: 'bootstrap.js',
  'cli-output': 'cli/output/cli-output.js',
  config: 'config/config.js',
  clients: 'chain/clients.js',
  daemon: 'daemon/daemon.js',
  'daemon-command': 'cli/commands/daemon-command.js',
  'daemon-config': 'config/daemon-config.js',
  'daemon-startup': 'daemon/daemon-startup.js',
  'import-round': 'rounds/import-round.js',
  'import-round-when-available':
    'rounds/import-round-when-available.js',
  'inspect-nonce-sync': 'chain/inspect-nonce-sync.js',
  'open-beacon-submitter': 'cli/open-beacon-submitter.js',
  'service-lock': 'state/service-lock.js',
  'validate-consumers': 'consumers/validate-consumers.js',
} as const;

type ModuleName = keyof typeof MODULE_PATHS;

let fixture: string;
let compiledApplication: string;

function compiledModuleUrl(
  name: ModuleName,
): string {
  return pathToFileURL(
    join(compiledApplication, 'dist', MODULE_PATHS[name]),
  ).href;
}

beforeAll(() => {
  if (process.platform !== 'linux') {
    return;
  }

  const version = execFileSync(
    'flock',
    ['--version'],
    {
      encoding: 'utf8',
      timeout: 5_000,
    },
  );

  expect(version).toContain('util-linux');

  fixture = mkdtempSync(
    join(APP, '.bootstrap-command-output-'),
  );

  compiledApplication = compileRelayerFixture(APP, fixture);
}, 40_000);

afterAll(() => {
  if (fixture !== undefined) {
    rmSync(fixture, {
      recursive: true,
      force: true,
    });
  }
});

const COMMAND_OUTPUT_CASES = [
  ...(['import', 'import-when-available', 'daemon'] as const).map(
    (command) => ({
      command,
      outcome: 'imported' as const,
      outputFails: true,
    }),
  ),
  ...(['import', 'import-when-available'] as const).flatMap(
    (command) =>
      (['pending', 'deferred', 'already-retained'] as const).flatMap((outcome) =>
        [false, true].map((outputFails) => ({
          command,
          outcome,
          outputFails,
        })),
      ),
  ),
];

it.skipIf(process.platform !== 'linux').each(COMMAND_OUTPUT_CASES)(
  '$command reports $outcome (output fails: $outputFails)',
  ({ command, outcome, outputFails }) => {
    const checkpoint = join(fixture, command + '.json');
    const observed = join(fixture, command + '.observed');
    const entered = join(fixture, command + '.entered');
    const completed = join(fixture, command + '.completed');
    const preload = join(fixture, command + '.mjs');

    const renderer = compiledModuleUrl('cli-output');

    const setup = `
      const config = {
        account: {
          address: '0x' + '11'.repeat(20),
        },
        chain: {
          id: 46630,
        },
        deployment: {
          chainId: 46630,
          address: '0x' + '22'.repeat(20),
        },
        checkpointFile: ${JSON.stringify(checkpoint)},
        consumers: [],
      };
    `;

    const result = outcome === 'pending'
      ? `{
          status: 'pending',
          round: 100n,
          attemptId: '11111111-1111-4111-8111-111111111111',
          transactionHash: '0x' + '44'.repeat(32),
          reason: 'receipt-timeout',
        }`
      : outcome === 'deferred'
        ? `{
            status: 'deferred',
            round: 100n,
            reason: 'signer-unavailable',
            blocker: 'unresolved-attempt',
          }`
        : outcome === 'already-retained'
          ? `{
              status: 'deferred',
              round: 100n,
              reason: 'already-retained',
              attemptId: '11111111-1111-4111-8111-111111111111',
              workId: 'quicknet-round:v1:46630:0x2222222222222222222222222222222222222222:100',
            }`
          : `{
              status: 'imported',
              submission: 'witness',
              round: 100n,
              randomness: '0x' + '33'.repeat(32),
              transactionHash: '0x' + '44'.repeat(32),
            }`;

    // Stub configuration, network work, and signer-runtime opening.
    // Bootstrap, CLI dispatch, runDaemonCommand, output rendering,
    // and service-lock verification execute their actual compiled
    // implementations.
    const replacements = new Map<ModuleName, string>([
      [
        'config',
        setup + `
          export function parseRelayerNetworkPreset() {
            return 'robinhood-testnet';
          }

          export async function loadRelayerConfig() {
            return config;
          }
        `,
      ],
      [
        'clients',
        `
          export function createRelayerClients() {
            return {
              rpcMetrics: {
                snapshot() {
                  return {
                    collectorId: '11111111-1111-4111-8111-111111111111',
                    startedAt: '2026-10-22T12:00:00.000Z',
                    logical: [],
                    http: [],
                  };
                },
              },
            };
          }
        `,
      ],
      [
        'open-beacon-submitter',
        `
          export async function openBeaconSubmitter() {
            return Object.freeze({
              async recover() {
                throw new Error('Unexpected signer recovery in output test.');
              },
              async submit() {
                throw new Error('Unexpected beacon submission in output test.');
              },
            });
          }
        `,
      ],
      [
        'import-round',
        `
          import {
            closeSync,
            writeFileSync,
          } from 'node:fs';

          import {
            renderCliOutput,
          } from ${JSON.stringify(renderer)};

          export async function importQuicknetRound() {
            const result = ${result};

            // Confirm rendering succeeds before inducing write failure.
            renderCliOutput({
              type: 'import-result',
              round: 100n,
              result,
            });

            writeFileSync(
              ${JSON.stringify(completed)},
              'completed',
            );

            if (${outputFails}) {
              closeSync(1);
            }

            return result;
          }
        `,
      ],
      [
        'import-round-when-available',
        `
          import {
            closeSync,
            writeFileSync,
          } from 'node:fs';

          import {
            renderCliOutput,
          } from ${JSON.stringify(renderer)};

          export async function importQuicknetRoundWhenAvailable() {
            const result = ${result};

            renderCliOutput({
              type: 'import-result',
              round: 100n,
              result,
            });

            writeFileSync(
              ${JSON.stringify(completed)},
              'completed',
            );

            if (${outputFails}) {
              closeSync(1);
            }

            return result;
          }
        `,
      ],
      [
        'daemon-config',
        setup + `
          export async function loadDaemonConfig() {
            return config;
          }
        `,
      ],
      [
        'validate-consumers',
        `
          export async function validateQuicknetConsumers() {
            return [];
          }
        `,
      ],
      [
        'daemon',
        `
          import { writeFileSync } from 'node:fs';

          export async function runDaemon() {
            writeFileSync(
              ${JSON.stringify(entered)},
              'entered',
            );
          }
        `,
      ],
      [
        'daemon-startup',
        `
          import {
            closeSync,
            writeFileSync,
          } from 'node:fs';

          import {
            renderCliOutput,
          } from ${JSON.stringify(renderer)};

          import {
            assertServiceLockHeld,
          } from ${JSON.stringify(compiledModuleUrl('service-lock'))};

          export async function collectDaemonStartupSummary({
            config,
          }) {
            assertServiceLockHeld({
              checkpointFile: config.checkpointFile,
            });

            writeFileSync(
              ${JSON.stringify(observed)},
              'owned',
            );

            const summary = {
              chainId: 46630,
              signer: '0x' + '11'.repeat(20),
              signerBalance: 0n,
              registry: '0x' + '22'.repeat(20),
              registryRuntimeCodehash: '0x' + '33'.repeat(32),
              checkpointFile: config.checkpointFile,
              finality: {
                type: 'safe',
              },
              latestHead: 100n,
              durableHead: 90n,
              startBlock: 1n,
              maxBlockRange: 10n,
              pollIntervalMs: 1000,
              consumers: [],
              durableNextBlocks: new Map(),
            };

            renderCliOutput({
              type: 'daemon-startup',
              summary,
            });

            closeSync(1);

            return summary;
          }
        `,
      ],
    ]);

    // Match complete module URLs, including the new directories.
    const modules = [...replacements].map(([name, source]) => [
      compiledModuleUrl(name),
      source,
    ]);

    // Hooks replace modules in the child process only.
    // No compiled application files are overwritten.
    writeFileSync(
      preload,
      `
        import { registerHooks } from 'node:module';

        const modules = new Map(${JSON.stringify(modules)});

        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === '@based-labs/drand-quicknet-registry') {
              return {
                url: 'relayer-test:registry',
                shortCircuit: true,
              };
            }

            return nextResolve(specifier, context);
          },

          load(url, context, nextLoad) {
            if (url === 'relayer-test:registry') {
              return {
                format: 'module',
                source:
                  'export async function verifyRegistryDeployment() {}',
                shortCircuit: true,
              };
            }

            if (modules.has(url)) {
              return {
                format: 'module',
                source: modules.get(url),
                shortCircuit: true,
              };
            }

            return nextLoad(url, context);
          },
        });
      `,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      QUICKNET_LOG_LEVEL: 'info',
      PRIVATE_KEY: '',
      ROBINHOOD_TESTNET_RPC_URL: '',
      QUICKNET_RPC_URL: '',
      QUICKNET_STATE_DIR: fixture,
    };

    delete env.NODE_OPTIONS;

    const args = [
      '--import',
      preload,
      join(compiledApplication, 'dist', MODULE_PATHS.bootstrap),
      command,
      '--network',
      'robinhood-testnet',
    ];

    if (command !== 'daemon') {
      args.push('--round', '100');
    }

    const lockFile = join(fixture, 'relayer.flock');

    const child = spawnSync(
      'flock',
      [
        '--exclusive',
        '--nonblock',
        '--no-fork',
        '--conflict-exit-code',
        '75',
        lockFile,
        process.execPath,
        ...args,
      ],
      {
        cwd: APP,
        env,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1_048_576,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    
    let expectedExitCode: number;

    if (outputFails) {
      expectedExitCode = 2;
    } else if (outcome === 'pending') {
      expectedExitCode = 3;
    } else {
      expectedExitCode = 4;
    }

    expect(child.status, child.stderr).toBe(expectedExitCode);

    let failure: Record<string, unknown> = {};

    const records: Record<string, unknown>[] = child.stderr
      .trimEnd()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    if (command !== 'daemon') {
      const summaries = records.filter(
        (record) => record.event === 'rpc_usage',
      );

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        level: 30,
        event: 'rpc_usage',
        observedAt: expect.any(String),
        report: {
          collectorId: '11111111-1111-4111-8111-111111111111',
          startedAt: '2026-10-22T12:00:00.000Z',
          cumulative: {
            logical: [],
            http: [],
          },
          interval: {
            available: false,
            reason: 'no-baseline',
          },
        },
      });
    }

    if (outputFails) {
      expect(child.stdout).toBe('');
      expect(child.stderr).not.toContain('cli_failed');
      expect(child.stderr.endsWith('\n')).toBe(true);

      const outputFailures = records.filter(
        (record) => record.event === 'output_failed',
      );

      expect(outputFailures).toHaveLength(1);
      failure = outputFailures[0]!;

      if (command === 'daemon') {
        expect(records).toHaveLength(2);

        const loggingFailures = records.filter(
          (record) => record.event === 'logging_failed',
        );

        expect(loggingFailures).toHaveLength(1);

        // Destination errors may arrive without event attribution.
        const diagnostic = loggingFailures[0]!;

        expect(diagnostic).toMatchObject({
          event: 'logging_failed',
          code: 'LOG_OUTPUT_FAILED',
        });

        if (Object.hasOwn(diagnostic, 'rejected')) {
          expect(diagnostic.rejected).toBe('rpc_usage');
        }
      } else {
        expect(records.map((record) => record.event)).toEqual([
          'output_failed',
          'rpc_usage',
        ]);
      }

      expect(failure).toMatchObject({
        event: 'output_failed',
        code: 'CLI_OUTPUT_FAILED',
        err: {
          name: 'Error',
        },
      });
    } else {
      expect(records.map((record) => record.event))
        .toEqual(['rpc_usage']);
      expect(child.stderr.endsWith('\n')).toBe(true);

      const expected = outcome === 'pending'
        ? [
            'Quicknet round 100 import is pending.',
            'Reason: receipt-timeout',
            'Attempt: 11111111-1111-4111-8111-111111111111',
            'Transaction: ' + '0x' + '44'.repeat(32),
          ]
        : outcome === 'already-retained'
          ? [
              'Quicknet round 100 import is deferred.',
              'Reason: already-retained',
              'Retained attempt: 11111111-1111-4111-8111-111111111111',
              'Work identity: quicknet-round:v1:46630:0x2222222222222222222222222222222222222222:100',
            ]
          : [
              'Quicknet round 100 import is deferred.',
              'Reason: signer-unavailable',
              'Signer blocker: unresolved-attempt',
            ];

      expect(child.stdout).toBe(expected.join('\n') + '\n');
    }

    expect(existsSync(lockFile)).toBe(true);

    // Process exit releases ownership without removing the lock file.
    const reacquired = spawnSync(
      'flock',
      [
        '--exclusive',
        '--nonblock',
        '--no-fork',
        '--conflict-exit-code',
        '75',
        lockFile,
        process.execPath,
        '-e',
        '',
      ],
      {
        cwd: APP,
        env,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1_048_576,
      },
    );

    expect(reacquired.error).toBeUndefined();
    expect(reacquired.signal).toBeNull();
    expect(reacquired.status, reacquired.stderr).toBe(0);

    if (command === 'daemon') {
      expect(failure.output).toBe('daemon-startup');

      expect(
        readFileSync(observed, 'utf8'),
      ).toBe('owned');

      expect(
        existsSync(checkpoint + '.lock'),
      ).toBe(false);

      expect(
        existsSync(entered),
      ).toBe(false);
    } else {
      expect(
        readFileSync(completed, 'utf8'),
      ).toBe('completed');

      if (outputFails) {
        expect(failure).toMatchObject({
          output: 'import-result',
          status: outcome === 'already-retained' ? 'deferred' : outcome,
          round: '100',
        });

        if (outcome === 'deferred') {
          expect(failure).toMatchObject({
            reason: 'signer-unavailable',
            blocker: 'unresolved-attempt',
          });
          expect(failure).not.toHaveProperty('attemptId');
          expect(failure).not.toHaveProperty('transactionHash');
        } else if (outcome === 'already-retained') {
          expect(failure).toMatchObject({
            reason: 'already-retained',
            attemptId: '11111111-1111-4111-8111-111111111111',
            workId:
              'quicknet-round:v1:46630:0x2222222222222222222222222222222222222222:100',
          });

          expect(failure).not.toHaveProperty('blocker');
          expect(failure).not.toHaveProperty('transactionHash');
        } else {
          expect(failure.transactionHash)
            .toBe('0x' + '44'.repeat(32));

          if (outcome === 'pending') {
            expect(failure).toMatchObject({
              attemptId: '11111111-1111-4111-8111-111111111111',
              reason: 'receipt-timeout',
            });
          }
        }

        if (outcome !== 'imported') {
          expect(failure).not.toHaveProperty('randomness');
        }
      }
    }
  },
);

const NONCE_SYNC_CASES = [
  ...([
    'preview',
    'already-synchronized',
    'applied',
    'deferred',
    'refused',
  ] as const).flatMap((outcome) =>
    [false, true].map((outputFails) => ({
      outcome,
      outputFails,
    })),
  ),
  {
    outcome: 'interrupted' as const,
    outputFails: false,
  },
];

it.skipIf(process.platform !== 'linux').each(NONCE_SYNC_CASES)(
  'sync-nonce reports $outcome (output fails: $outputFails)',
  ({ outcome, outputFails }) => {
    const directory = mkdtempSync(
      join(fixture, 'nonce-sync-'),
    );

    const signer = '0x' + '11'.repeat(20);
    const hash = '0x' + 'aa'.repeat(32);
    const chainId = 46630;

    const journalFile = join(
      directory,
      `transaction-journal-${chainId}-${signer}.json`,
    );

    const lockFile = join(directory, 'relayer.flock');
    const preload = join(directory, 'preload.mjs');

    const apply = outcome !== 'preview';

    const initial = {
      version: 1,
      identity: {
        chainId,
        signer,
      },
      baseline: {
        anchor: {
          blockNumber: '90',
          blockHash: hash,
        },
        nonce: '4',
      },
      lastObservation: {
        anchor: {
          blockNumber: '100',
          blockHash: hash,
        },
        nonce: '8',
      },
      nextNonce: outcome === 'already-synchronized' ? '8' : '4',
      durableNextNonce:
        outcome === 'already-synchronized' ? '8' : '4',
      repairs: [],
      attempts: [],
    };

    const originalContents = JSON.stringify(initial) + '\n';

    if (outcome !== 'refused') {
      writeFileSync(journalFile, originalContents);
    }

    const renderer = compiledModuleUrl('cli-output');

    const replacements = new Map<ModuleName, string>([
      [
        'config',
        `
          export function parseRelayerNetworkPreset() {
            return 'robinhood-testnet';
          }

          export async function loadRelayerConfig() {
            return {
              account: {
                address: ${JSON.stringify(signer)},
              },
              chain: {
                id: ${chainId},
              },
              finality: {
                type: 'safe',
              },
            };
          }
        `,
      ],
      [
        'clients',
        `
          export function createRelayerClients() {
            return {
              publicClient: {},
              walletClient: {},
              rpcMetrics: {
                snapshot() {
                  return {
                    collectorId: '11111111-1111-4111-8111-111111111111',
                    startedAt: '2026-10-22T12:00:00.000Z',
                    logical: [],
                    http: [],
                  };
                },
              },
            };
          }
        `,
      ],
      [
        'inspect-nonce-sync',
        `
          export async function inspectNonceSync({ signal }) {
            if (${JSON.stringify(outcome)} === 'refused') {
              throw new Error('Unexpected RPC inspection for missing journal.');
            }

            if (${JSON.stringify(outcome)} === 'interrupted') {
              if (!(signal instanceof AbortSignal)) {
                throw new Error('Expected shutdown signal.');
              }

              // CLI handlers are installed before this operation begins.
              process.emit('SIGTERM');
              signal.throwIfAborted();

              throw new Error('Expected cancellation.');
            }

            return {
              status: 'observed',
              observation: {
                anchor: {
                  blockNumber: 110n,
                  blockHash: ${JSON.stringify(hash)},
                },
                nonce: 8n,
              },
              latestNonce: 8n,
              pendingNonce: ${
                outcome === 'deferred' ? '9n' : '8n'
              },
            };
          }
        `,
      ],
      [
        'cli-output',
        `
          import { closeSync } from 'node:fs';

          import {
            renderCliOutput as actualRender,
          } from ${JSON.stringify(renderer + '?nonce-sync-test')};

          export {
            renderOutputFailure,
          } from ${JSON.stringify(renderer + '?nonce-sync-test')};

          export function renderCliOutput(record) {
            const rendered = actualRender(record);

            if (
              record.type === 'nonce-sync-result' &&
              ${outputFails}
            ) {
              // Rendering succeeded. Fail the actual bootstrap write
              // after the command has produced its result.
              closeSync(1);
            }

            return rendered;
          }
        `,
      ],

      // Prevent unrelated command dependencies from doing any work.
      [
        'daemon-command',
        `
          export async function runDaemonCommand() {
            throw new Error('Unexpected daemon command.');
          }
        `,
      ],
      [
        'open-beacon-submitter',
        `
          export async function openBeaconSubmitter() {
            throw new Error('Unexpected signer runtime.');
          }
        `,
      ],
      [
        'import-round',
        `
          export async function importQuicknetRound() {
            throw new Error('Unexpected round import.');
          }
        `,
      ],
      [
        'import-round-when-available',
        `
          export async function importQuicknetRoundWhenAvailable() {
            throw new Error('Unexpected round import.');
          }
        `,
      ],
    ]);

    const modules = [...replacements].map(([name, source]) => [
      compiledModuleUrl(name),
      source,
    ]);

    writeFileSync(preload, `
      import { registerHooks } from 'node:module';

      const modules = new Map(${JSON.stringify(modules)});

      registerHooks({
        load(url, context, nextLoad) {
          if (modules.has(url)) {
            return {
              format: 'module',
              source: modules.get(url),
              shortCircuit: true,
            };
          }

          return nextLoad(url, context);
        },
      });
    `);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      QUICKNET_LOG_LEVEL: 'info',
      QUICKNET_STATE_DIR: directory,
      PRIVATE_KEY: '',
      QUICKNET_RPC_URL: '',
      ROBINHOOD_TESTNET_RPC_URL: '',
    };

    delete env.NODE_OPTIONS;
    delete env.QUICKNET_ENV_FILE;

    const args = [
      '--import',
      preload,
      join(compiledApplication, 'dist', MODULE_PATHS.bootstrap),
      'sync-nonce',
      '--network',
      'robinhood-testnet',
      ...(apply ? ['--apply'] : []),
    ];

    const child = spawnSync('flock', [
      '--exclusive',
      '--nonblock',
      '--no-fork',
      '--conflict-exit-code',
      '75',
      lockFile,
      process.execPath,
      ...args,
    ], {
      cwd: APP,
      env,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_048_576,
    });

    const normalExitCodes = {
      preview: 0,
      'already-synchronized': 0,
      applied: 0,
      deferred: 4,
      refused: 1,
      interrupted: 5,
    } as const;

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(
      outputFails ? 2 : normalExitCodes[outcome],
    );

    const records: Record<string, unknown>[] =
      child.stderr.trim().length === 0
        ? []
        : child.stderr.trimEnd().split('\n').map(
            (line) => JSON.parse(line),
          );

    const expectedEvents = [
      ...(outcome === 'applied' ? ['signer_nonce_synced'] : []),
      ...(outputFails ? ['output_failed'] : []),
      'rpc_usage',
    ];

    expect(records.map((record) => record.event))
      .toEqual(expectedEvents);

    expect(records.at(-1)).toMatchObject({
      level: 30,
      event: 'rpc_usage',
      chainId,
      observedAt: expect.any(String),
      report: {
        collectorId: '11111111-1111-4111-8111-111111111111',
        startedAt: '2026-10-22T12:00:00.000Z',
        cumulative: {
          logical: [],
          http: [],
        },
        interval: {
          available: false,
          reason: 'no-baseline',
        },
      },
    });

    if (outcome === 'interrupted') {
      expect(child.stdout).toBe('');
    } else {
      const status = outcome === 'preview'
        ? 'repair-available'
        : outcome;

      if (outputFails) {
        expect(child.stdout).toBe('');

        const failure = records.find(
          (record) => record.event === 'output_failed',
        );

        expect(failure).toMatchObject({
          code: 'CLI_OUTPUT_FAILED',
          output: 'nonce-sync-result',
          chainId,
          signer,
          mode: apply ? 'apply' : 'preview',
          status,
        });

        expect(failure).not.toHaveProperty('snapshot');

        if (outcome === 'applied' || outcome === 'preview') {
          expect(failure).toMatchObject({
            previousNextNonce: '4',
            nextNonce: '8',
            durableBlock: '110',
            durableBlockHash: hash,
          });
        }

        if (outcome === 'refused') {
          expect(failure).toHaveProperty('reason', 'journal-missing');
        }

        if (outcome === 'deferred') {
          expect(failure).toHaveProperty('reason', 'nonce-count-mismatch');
        }
      } else {
        expect(child.stdout).toContain('Nonce sync: ' + status);
        expect(child.stdout.endsWith('\n')).toBe(true);
      }
    }

    if (outcome === 'applied') {
      const persisted = JSON.parse(readFileSync(journalFile, 'utf8'));

      expect(persisted).toMatchObject({
        identity: initial.identity,
        baseline: initial.baseline,
        lastObservation: {
          anchor: {
            blockNumber: '110',
            blockHash: hash,
          },
          nonce: '8',
        },
        nextNonce: '8',
        durableNextNonce: '8',
        attempts: [],
      });

      expect(persisted.repairs).toHaveLength(1);

      const repair = persisted.repairs[0];

      expect(repair).toMatchObject({
        kind: 'sync-nonce',
        previousNextNonce: '4',
        nextNonce: '8',
        observation: persisted.lastObservation,
      });

      expect(new Date(repair.at).toISOString()).toBe(repair.at);

      expect(records[0]).toMatchObject({
        event: 'signer_nonce_synced',
        level: 40,
        chainId,
        signer,
        previousNextNonce: '4',
        nextNonce: '8',
        durableBlock: '110',
        durableBlockHash: hash,
        durableNonce: '8',
        repairAt: repair.at,
      });

      if (outputFails) {
        expect(records[1]).toMatchObject({
          event: 'output_failed',
          status: 'applied',
          repairAt: repair.at,
        });
      }
    } else if (outcome === 'refused') {
      expect(existsSync(journalFile)).toBe(false);
    } else {
      expect(readFileSync(journalFile, 'utf8')).toBe(originalContents);
    }

    // Reacquisition must succeed after bootstrap exits.
    const reacquired = spawnSync('flock', [
      '--exclusive',
      '--nonblock',
      '--no-fork',
      '--conflict-exit-code',
      '75',
      lockFile,
      process.execPath,
      '-e',
      '',
    ], {
      cwd: APP,
      env,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_048_576,
    });

    expect(reacquired.error).toBeUndefined();
    expect(reacquired.signal).toBeNull();
    expect(reacquired.status, reacquired.stderr).toBe(0);
  },
);