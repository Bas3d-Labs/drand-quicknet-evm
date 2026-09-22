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

import { join } from 'node:path';
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

const APP = fileURLToPath(new URL('..', import.meta.url));

let fixture: string;

beforeAll(() => {
  execFileSync(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.json'],
    {
      cwd: APP,
      stdio: 'pipe',
      timeout: 30_000,
    },
  );

  fixture = mkdtempSync(
    join(APP, '.bootstrap-command-output-'),
  );
}, 35_000);

afterAll(() => {
  if (fixture !== undefined) {
    rmSync(fixture, {
      recursive: true,
      force: true,
    });
  }
});

it.each([
  'import',
  'import-when-available',
  'daemon',
])(
  '%s preserves exit code 2 through the real command path',
  (command) => {
    const checkpoint = join(fixture, command + '.json');
    const observed = join(fixture, command + '.observed');
    const entered = join(fixture, command + '.entered');
    const completed = join(fixture, command + '.completed');
    const preload = join(fixture, command + '.mjs');

    const renderer = pathToFileURL(
      join(APP, 'dist', 'cli-output.js'),
    ).href;

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

    const result = `{
      status: 'imported',
      round: 100n,
      randomness: '0x' + '33'.repeat(32),
      transactionHash: '0x' + '44'.repeat(32),
    }`;

    // Stub configuration and network work. Bootstrap, CLI dispatch,
    // runDaemonCommand, output rendering, and FileCheckpointLock
    // execute their actual compiled implementations.
    const replacements = new Map([
      [
        'config.js',
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
        'clients.js',
        `
          export function createRelayerClients() {
            return {};
          }
        `,
      ],
      [
        'import-round.js',
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

            closeSync(1);

            return result;
          }
        `,
      ],
      [
        'import-round-when-available.js',
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

            closeSync(1);

            return result;
          }
        `,
      ],
      [
        'daemon-config.js',
        setup + `
          export async function loadDaemonConfig() {
            return config;
          }
        `,
      ],
      [
        'validate-consumers.js',
        `
          export async function validateQuicknetConsumers() {
            return [];
          }
        `,
      ],
      [
        'daemon.js',
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
        'daemon-startup.js',
        `
          import {
            closeSync,
            readFileSync,
            writeFileSync,
          } from 'node:fs';

          import {
            renderCliOutput,
          } from ${JSON.stringify(renderer)};

          export async function collectDaemonStartupSummary() {
            const lock = JSON.parse(
              readFileSync(
                ${JSON.stringify(checkpoint + '.lock')},
                'utf8',
              ),
            );

            if (lock.pid !== process.pid) {
              throw new Error('Expected an owned checkpoint lock.');
            }

            // Prove the lock existed and belonged to this process
            // before startup output failed.
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

    const modules = [...replacements].map(([name, source]) => [
      pathToFileURL(join(APP, 'dist', name)).href,
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
    };

    delete env.NODE_OPTIONS;

    const args = [
      '--import',
      preload,
      join(APP, 'dist', 'bootstrap.js'),
      command,
      '--network',
      'robinhood-testnet',
    ];

    if (command !== 'daemon') {
      args.push('--round', '100');
    }

    const child = spawnSync(process.execPath, args, {
      cwd: APP,
      env,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_048_576,
    });

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(2);
    expect(child.stdout).toBe('');

    // Output failure should produce one diagnostic, without a second
    // ordinary CLI failure when the sentinel reaches bootstrap.
    expect(child.stderr).not.toContain('cli_failed');
    expect(child.stderr.endsWith('\n')).toBe(true);

    expect(
      child.stderr.trimEnd().split('\n'),
    ).toHaveLength(1);

    const failure = JSON.parse(child.stderr);

    expect(failure).toMatchObject({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      err: {
        name: 'Error',
      },
    });

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

      expect(failure).toMatchObject({
        output: 'import-result',
        status: 'imported',
        round: '100',
        transactionHash: '0x' + '44'.repeat(32),
      });
    }
  },
);