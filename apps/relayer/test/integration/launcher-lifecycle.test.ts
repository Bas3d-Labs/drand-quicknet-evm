import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

import {
  delimiter,
  join,
} from 'node:path';

import process from 'node:process';

import {
  setTimeout as delay,
} from 'node:timers/promises';

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

const WAIT_TIMEOUT_MS = 5_000;
const CONTAINER_IMAGE = process.env.QUICKNET_TEST_CONTAINER_IMAGE;

let fixture: string;
let compiledApplication: string;
let launcher: string;

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

beforeAll(() => {
  if (process.platform !== 'linux') {
    return;
  }

  const version = execFileSync('flock', ['--version'], {
    encoding: 'utf8',
    timeout: WAIT_TIMEOUT_MS,
  });

  expect(version).toContain('util-linux');

  fixture = mkdtempSync(
    join(APP, '.launcher-lifecycle-'),
  );

  compiledApplication = compileRelayerFixture(APP, fixture);

  launcher = join(
    compiledApplication,
    'scripts',
    'relayer.sh',
  );

  // The copied launcher still resolves Node through PATH.
  symlinkSync(
    process.execPath,
    join(fixture, 'node'),
  );
}, 40_000);

afterAll(() => {
  if (fixture !== undefined) {
    rmSync(fixture, {
      recursive: true,
      force: true,
    });
  }
});

function compiledModuleUrl(
  relativePath: string,
  applicationDirectory: string = compiledApplication,
): string {
  return pathToFileURL(
    join(applicationDirectory, 'dist', relativePath),
  ).href;
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  detail: () => string = () => '',
): Promise<void> {
  const deadline = performance.now() + WAIT_TIMEOUT_MS;

  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description}. ${detail()}`,
      );
    }

    await delay(10);
  }
}

function writePreload(
  directory: string,
  signal: NodeJS.Signals,
  runtimeDirectory: string = directory,
  applicationDirectory: string = compiledApplication,
): string {
  const preload = join(directory, 'preload.mjs');

  const replacements = new Map<string, string>();

  function replace(relativePath: string, source: string): void {
    replacements.set(
      compiledModuleUrl(relativePath, applicationDirectory),
      source,
    );
  }

  replace('config/config.js', `
    export function parseRelayerNetworkPreset() {
      return 'robinhood-testnet';
    }

    export async function loadRelayerConfig() {
      throw new Error('Unexpected import configuration load.');
    }
  `);

  replace('config/daemon-config.js', `
    import { join } from 'node:path';

    export async function loadDaemonConfig() {
      return {
        network: 'robinhood-testnet',
        chain: { id: 46630 },
        account: {
          address: '0x' + '11'.repeat(20),
        },
        deployment: {
          chainId: 46630,
          address: '0x' + '22'.repeat(20),
          runtimeCodehash: '0x' + '33'.repeat(32),
          verifierAddress: '0x' + '44'.repeat(20),
          verifierRuntimeCodehash: '0x' + '55'.repeat(32),
        },
        checkpointFile: join(
          process.env.QUICKNET_STATE_DIR,
          'checkpoint.json',
        ),
        consumers: [],
        startBlock: 1n,
        maxBlockRange: 10n,
        finality: { type: 'safe' },
        pollIntervalMs: 10,
      };
    }
  `);

  replace('chain/clients.js', `
    export function createRelayerClients() {
      return {
        publicClient: {},
        walletClient: {},
      };
    }
  `);

  replace('cli/open-beacon-submitter.js', `
    export async function openBeaconSubmitter() {
      return Object.freeze({
        async recover() {
          throw new Error('Unexpected signer recovery in lifecycle test.');
        },
        async submit() {
          throw new Error('Unexpected beacon submission in lifecycle test.');
        },
      });
    }
  `);

  replace('chain/chain-heads-reader.js', `
    export function createChainHeadsReader() {
      return async function readChainHeads() {
        throw new Error('Unexpected RPC work.');
      };
    }
  `);

  replace('consumers/validate-consumers.js', `
    export async function validateQuicknetConsumers() {
      return [];
    }
  `);

  replace('diagnostics/relayer-log.js', `
    export function createRelayerLog() {
      const logger = {
        withContext() {
          return logger;
        },
      };

      return logger;
    }
  `);

  replace('daemon/daemon-logging.js', `
    export function createDaemonLogger() {
      return {
        onCycle() {},
      };
    }
  `);

  replace('rounds/import-round.js', `
    export async function importQuicknetRound() {
      throw new Error('Unexpected round import.');
    }
  `);

  replace('rounds/import-round-when-available.js', `
    export async function importQuicknetRoundWhenAvailable() {
      throw new Error('Unexpected round import.');
    }
  `);

  replace('daemon/daemon-startup.js', `
    export async function collectDaemonStartupSummary({
      config,
      durableNextBlocks,
    }) {
      return {
        network: config.network,
        chainId: config.chain.id,
        rpcOrigin: 'https://rpc.example.test',
        signer: config.account.address,
        signerBalance: 0n,
        registry: config.deployment.address,
        registryRuntimeCodehash: config.deployment.runtimeCodehash,
        checkpointFile: config.checkpointFile,
        finality: config.finality,
        latestHead: 100n,
        durableHead: 90n,
        startBlock: config.startBlock,
        maxBlockRange: config.maxBlockRange,
        pollIntervalMs: config.pollIntervalMs,
        consumers: [],
        durableNextBlocks,
      };
    }
  `);

  replace('daemon/daemon-cycle.js', `
    import { spawn } from 'node:child_process';

    import {
      existsSync,
      writeFileSync,
    } from 'node:fs';

    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';

    import {
      assertServiceLockHeld,
    } from ${JSON.stringify(
      compiledModuleUrl(
        'state/service-lock.js',
        applicationDirectory,
      ),
    )};

    const directory = ${JSON.stringify(runtimeDirectory)};
    const shutdownSignal = ${JSON.stringify(signal)};

    let calls = 0;

    export async function runDaemonCycle() {
      calls += 1;

      if (calls !== 1) {
        writeFileSync(join(directory, 'unexpected-cycle'), '');
        throw new Error('Another cycle started after shutdown.');
      }

      assertServiceLockHeld();

      // Record the PID after the launcher has exec'd Node.
      writeFileSync(
        join(directory, 'owner-pid'),
        String(process.pid),
      );

      if (shutdownSignal !== 'SIGKILL') {
        // The real CLI must already have installed its handler.
        if (process.listenerCount(shutdownSignal) !== 1) {
          throw new Error('Expected the CLI shutdown handler.');
        }

        // This observer only acknowledges delivery. The real CLI
        // handler must abort the daemon to prevent a second cycle.
        process.once(shutdownSignal, () => {
          writeFileSync(join(directory, 'signal-observed'), '');
        });
      }

      const childSource = \`
        const {
          existsSync,
          fstatSync,
          readdirSync,
          statSync,
          writeFileSync,
        } = require('node:fs');

        const { join } = require('node:path');

        const directory = process.argv[1];

        const expected = statSync(
          join(directory, 'relayer.flock'),
          { bigint: true },
        );

        let lockDescriptors = 0;

        for (const name of readdirSync('/proc/self/fd')) {
          const fd = Number(name);

          if (!Number.isSafeInteger(fd) || fd < 0) {
            continue;
          }

          try {
            const actual = fstatSync(fd, { bigint: true });

            if (
              actual.dev === expected.dev &&
              actual.ino === expected.ino
            ) {
              lockDescriptors += 1;
            }
          } catch {
            // Enumeration can include a descriptor that has since closed.
          }
        }

        writeFileSync(
          join(directory, 'child-lock-descriptors'),
          String(lockDescriptors),
        );

        writeFileSync(
          join(directory, 'child-ready'),
          String(process.pid),
        );

        const timer = setInterval(() => {
          if (existsSync(join(directory, 'stop-child'))) {
            clearInterval(timer);
            writeFileSync(join(directory, 'child-done'), '');
          }
        }, 10);

        // Bound the lifetime even if the test runner disappears.
        setTimeout(() => process.exit(0), 15_000).unref();
      \`;

      const childEnv = { ...process.env };
      delete childEnv.NODE_OPTIONS;

      const child = spawn(
        process.execPath,
        ['-e', childSource, directory],
        {
          detached: true,
          stdio: 'inherit',
          env: childEnv,
        },
      );

      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });

      child.unref();

      writeFileSync(join(directory, 'cycle-entered'), '');

      const deadline = Date.now() + 15_000;

      while (!existsSync(join(directory, 'finish-cycle'))) {
        if (Date.now() >= deadline) {
          throw new Error('Pending cycle was not released.');
        }

        await delay(10);
      }

      assertServiceLockHeld();

      writeFileSync(join(directory, 'cycle-completed'), '');

      return { consumers: [] };
    }
  `);

  writeFileSync(preload, `
    import { registerHooks } from 'node:module';

    const replacements = new Map(
      ${JSON.stringify([...replacements])},
    );

    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@based-labs/drand-quicknet-registry') {
          return {
            url: 'relayer-lifecycle:registry',
            shortCircuit: true,
          };
        }

        return nextResolve(specifier, context);
      },

      load(url, context, nextLoad) {
        if (url === 'relayer-lifecycle:registry') {
          return {
            format: 'module',
            source:
              'export async function verifyRegistryDeployment() {}',
            shortCircuit: true,
          };
        }

        if (replacements.has(url)) {
          return {
            format: 'module',
            source: replacements.get(url),
            shortCircuit: true,
          };
        }

        return nextLoad(url, context);
      },
    });
  `);

  return preload;
}

it.skipIf(process.platform !== 'linux').each([
  {
    signal: 'SIGTERM',
    closedStdin: false,
  },
  {
    signal: 'SIGINT',
    closedStdin: false,
  },
  {
    signal: 'SIGKILL',
    closedStdin: false,
  },
  {
    signal: 'SIGTERM',
    closedStdin: true,
  },
] as const)(
  '$signal releases ownership only after exit; closed stdin: $closedStdin',
  async ({ signal, closedStdin }) => {
    const directory = mkdtempSync(
      join(fixture, `${signal}-`),
    );

    const preload = writePreload(directory, signal);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: fixture + delimiter + (process.env.PATH ?? ''),
      NODE_ENV: 'production',
      NODE_OPTIONS: '--import=' + pathToFileURL(preload).href,
      QUICKNET_STATE_DIR: directory,
      QUICKNET_LOG_LEVEL: 'info',
      PRIVATE_KEY: '',
      QUICKNET_RPC_URL: '',
      ROBINHOOD_TESTNET_RPC_URL: '',
    };

    delete env.QUICKNET_ENV_FILE;

    const args = [
      launcher,
      'daemon',
      '--network',
      'robinhood-testnet',
    ];

    let launchArgs = args;

    if (closedStdin) {
      launchArgs = [
        '-c',
        'exec 0<&-; exec sh "$@"',
        'launcher-closed-stdin',
        ...args,
      ];
    }

    const owner = spawn('sh', launchArgs, {
      cwd: APP,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let spawnError: Error | undefined;
    let outcome: ExitResult | undefined;

    owner.stdout.resume();

    owner.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    owner.once('error', (error) => {
      spawnError = error;
    });

    let streamsClosed = false;

    const exited = new Promise<ExitResult>((resolve) => {
      owner.once('exit', (code, exitSignal) => {
        outcome = { code, signal: exitSignal };
        resolve(outcome);
      });
    });

    owner.once('close', () => {
      streamsClosed = true;
    });

    function detail(): string {
      return JSON.stringify({
        stderr,
        spawnError: spawnError?.message,
        outcome,
      });
    }

    async function waitForMarker(name: string): Promise<void> {
      await waitUntil(
        () => {
          if (spawnError !== undefined) {
            throw spawnError;
          }

          if (outcome !== undefined) {
            throw new Error(
              `Relayer exited before ${name}. ${detail()}`,
            );
          }

          return existsSync(join(directory, name));
        },
        name,
        detail,
      );
    }

    function expectContention(): void {
      const contender = spawnSync('sh', launchArgs, {
        cwd: APP,
        env,
        encoding: 'utf8',
        timeout: WAIT_TIMEOUT_MS,
      });

      expect(contender.error).toBeUndefined();
      expect(contender.signal).toBeNull();
      expect(contender.status, contender.stderr).toBe(75);
    }

    try {
      await waitForMarker('cycle-entered');
      await waitForMarker('child-ready');

      expect(
        readFileSync(
          join(directory, 'child-lock-descriptors'),
          'utf8',
        ),
      ).toBe('0');

      const ownerPid = Number(
        readFileSync(join(directory, 'owner-pid'), 'utf8'),
      );

      // No shell or flock parent remains between the test and Node.
      expect(ownerPid).toBe(owner.pid);

      const childPid = Number(
        readFileSync(join(directory, 'child-ready'), 'utf8'),
      );

      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(childPid).toBeGreaterThan(0);

      const lockFile = join(directory, 'relayer.flock');
      const originalLock = statSync(lockFile);

      expectContention();

      expect(owner.kill(signal)).toBe(true);

      if (signal !== 'SIGKILL') {
        await waitForMarker('signal-observed');

        expect(outcome).toBeUndefined();
        expect(
          existsSync(join(directory, 'cycle-completed')),
        ).toBe(false);

        // Shutdown has begun, but the pending cycle still owns state.
        expectContention();

        // Repeated shutdown signals must not bypass pending work.
        expect(owner.kill(signal)).toBe(true);
        expectContention();

        writeFileSync(join(directory, 'finish-cycle'), '');
      }

      await waitUntil(
        () => outcome !== undefined,
        'relayer exit',
        detail,
      );

      const result = await exited;

      if (signal === 'SIGKILL') {
        expect(result).toEqual({
          code: null,
          signal: 'SIGKILL',
        });

        expect(
          existsSync(join(directory, 'cycle-completed')),
        ).toBe(false);
      } else {
        expect(result, stderr).toEqual({
          code: 0,
          signal: null,
        });

        expect(
          existsSync(join(directory, 'cycle-completed')),
        ).toBe(true);
      }

      expect(
        existsSync(join(directory, 'unexpected-cycle')),
      ).toBe(false);

      expect(stderr).toBe('');

      // The ordinary child is still alive after its parent exits.
      expect(() => process.kill(childPid, 0)).not.toThrow();

      const probeEnv = { ...env };
      delete probeEnv.NODE_OPTIONS;

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
          env: probeEnv,
          encoding: 'utf8',
          timeout: WAIT_TIMEOUT_MS,
        },
      );

      expect(reacquired.error).toBeUndefined();
      expect(reacquired.signal).toBeNull();
      expect(reacquired.status, reacquired.stderr).toBe(0);

      // Reacquisition did not depend on the detached child exiting.
      expect(() => process.kill(childPid, 0)).not.toThrow();

      const remainingLock = statSync(lockFile);

      expect(remainingLock.dev).toBe(originalLock.dev);
      expect(remainingLock.ino).toBe(originalLock.ino);
    } finally {
      writeFileSync(join(directory, 'stop-child'), '');
      writeFileSync(join(directory, 'finish-cycle'), '');

      if (outcome === undefined) {
        owner.kill('SIGKILL');

        await waitUntil(
          () => outcome !== undefined,
          'relayer cleanup',
          detail,
        );
      }

      await exited;

      // Recheck after owner exit in case child startup raced cleanup.
      await waitUntil(
        () => {
          if (!existsSync(join(directory, 'child-ready'))) {
            return true;
          }

          return existsSync(join(directory, 'child-done'));
        },
        'detached child cleanup',
      );

      await waitUntil(
        () => streamsClosed,
        'inherited output streams to close',
        detail,
      );
    }
  },
  20_000,
);

it.skipIf(
  process.platform !== 'linux' ||
  CONTAINER_IMAGE === undefined,
)(
  'container PID 1 holds ownership until graceful shutdown completes',
  async () => {
    if (CONTAINER_IMAGE === undefined) {
      throw new Error('Container image was not configured.');
    }

    const directory = mkdtempSync(
      join(fixture, 'container-'),
    );

    const preload = writePreload(
      directory,
      'SIGTERM',
      '/state',
      '/home/node/app',
    );

    const suffix = directory.slice(directory.lastIndexOf('/') + 1);
    const containerName = `quicknet-lifecycle-${suffix}`;
    const volumeName = `${containerName}-state`;

    let volumeCreated = false;
    let containerCreated = false;

    function docker(args: string[]): string {
      return execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    }

    function evaluate(source: string): string {
      return docker([
        'exec',
        // Auxiliary probes must not inherit the application's preload.
        '--env',
        'NODE_OPTIONS=',
        containerName,
        'node',
        '-e',
        source,
      ]);
    }

    function markerExists(name: string): boolean {
      return evaluate(`
        const { existsSync } = require('node:fs');

        process.stdout.write(String(
          existsSync(${JSON.stringify('/state/' + name)}),
        ));
      `) === 'true';
    }

    function touch(name: string): void {
      evaluate(`
        const { writeFileSync } = require('node:fs');

        writeFileSync(
          ${JSON.stringify('/state/' + name)},
          '',
        );
      `);
    }

    function containerState(): {
      Running: boolean;
      ExitCode: number;
      OOMKilled: boolean;
    } {
      return JSON.parse(
        docker([
          'inspect',
          '--format',
          '{{json .State}}',
          containerName,
        ]),
      );
    }

    function expectContention(): void {
      // Exercise the image's normal launcher against the same volume.
      // It must refuse before loading application configuration.
      const contender = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--mount',
          `type=volume,source=${volumeName},target=/state`,
          CONTAINER_IMAGE!,
          'daemon',
          '--network',
          'robinhood-testnet',
        ],
        {
          encoding: 'utf8',
          timeout: 15_000,
        },
      );

      expect(contender.error).toBeUndefined();
      expect(contender.signal).toBeNull();
      expect(contender.status, contender.stderr).toBe(75);
    }

    try {
      docker(['volume', 'create', volumeName]);
      volumeCreated = true;

      docker([
        'create',
        '--name',
        containerName,
        '--network',
        'none',
        '--mount',
        `type=volume,source=${volumeName},target=/state`,
        '--env',
        'NODE_OPTIONS=--import=file:///tmp/lifecycle-preload.mjs',
        CONTAINER_IMAGE,
        'daemon',
        '--network',
        'robinhood-testnet',
      ]);
      containerCreated = true;

      // Copy only the test preload. Production application files and
      // the image entrypoint remain unchanged.
      docker([
        'cp',
        preload,
        `${containerName}:/tmp/lifecycle-preload.mjs`,
      ]);

      docker(['start', containerName]);

      await waitUntil(
        () => markerExists('cycle-entered'),
        'container cycle entry',
      );

      await waitUntil(
        () => markerExists('child-ready'),
        'container child readiness',
      );

      expect(evaluate(`
        const { readFileSync } = require('node:fs');

        process.stdout.write(
          readFileSync('/state/child-lock-descriptors', 'utf8'),
        );
      `)).toBe('0');

      const ownerPid = evaluate(`
        const { readFileSync } = require('node:fs');

        process.stdout.write(
          readFileSync('/state/owner-pid', 'utf8'),
        );
      `);

      expect(ownerPid).toBe('1');

      const originalIdentity = evaluate(`
        const { statSync } = require('node:fs');
        const lock = statSync('/state/relayer.flock');

        process.stdout.write(JSON.stringify({
          dev: lock.dev,
          ino: lock.ino,
        }));
      `);

      expectContention();

      docker([
        'kill',
        '--signal',
        'SIGTERM',
        containerName,
      ]);

      await waitUntil(
        () => markerExists('signal-observed'),
        'container SIGTERM delivery',
      );

      expect(containerState().Running).toBe(true);
      expect(markerExists('cycle-completed')).toBe(false);
      expectContention();

      // A second signal must not terminate PID 1 while work is pending.
      docker([
        'kill',
        '--signal',
        'SIGTERM',
        containerName,
      ]);

      expectContention();

      // Stop the fixture's child first. Unlike the host test, this
      // container cannot retain children after its PID 1 exits.
      touch('stop-child');

      await waitUntil(
        () => markerExists('child-done'),
        'container child completion',
      );

      touch('finish-cycle');

      await waitUntil(
        () => !containerState().Running,
        'container graceful exit',
      );

      expect(containerState()).toMatchObject({
        Running: false,
        ExitCode: 0,
        OOMKilled: false,
      });

      const logs = docker(['logs', containerName]);

      expect(logs).not.toContain('cli_failed');
      expect(logs).not.toContain('output_failed');

      // Reacquire the persistent lock in a fresh container and inspect
      // the completed work while holding it.
      const probeSource = `
        const {
          existsSync,
          statSync,
        } = require('node:fs');

        const lock = statSync('/state/relayer.flock');

        process.stdout.write(JSON.stringify({
          identity: {
            dev: lock.dev,
            ino: lock.ino,
          },
          completed: existsSync('/state/cycle-completed'),
          unexpectedCycle: existsSync('/state/unexpected-cycle'),
        }));
      `;

      const probe = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--mount',
          `type=volume,source=${volumeName},target=/state`,
          '--entrypoint',
          'flock',
          CONTAINER_IMAGE,
          '--exclusive',
          '--nonblock',
          '--no-fork',
          '--conflict-exit-code',
          '75',
          '/state/relayer.flock',
          'node',
          '-e',
          probeSource,
        ],
        {
          encoding: 'utf8',
          timeout: 15_000,
        },
      );

      expect(probe.error).toBeUndefined();
      expect(probe.signal).toBeNull();
      expect(probe.status, probe.stderr).toBe(0);

      expect(JSON.parse(probe.stdout)).toEqual({
        identity: JSON.parse(originalIdentity),
        completed: true,
        unexpectedCycle: false,
      });
    } finally {
      try {
        if (containerCreated) {
          docker(['rm', '--force', containerName]);
        }
      } finally {
        if (volumeCreated) {
          docker(['volume', 'rm', volumeName]);
        }
      }
    }
  },
  90_000,
);