import {
  execFileSync,
  spawnSync,
} from 'node:child_process';

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import {
  join,
} from 'node:path';

import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import {
  compileRelayerFixture,
} from '../helpers/compiled-relayer.js';

const APP = fileURLToPath(new URL('../..', import.meta.url));

const SIGNER = `0x${'ab'.repeat(20)}`;
const HASH = `0x${'aa'.repeat(32)}`;
const CHAIN_ID = 4663;

const ARGS = [
  'status',
  '--chain-id', String(CHAIN_ID),
  '--signer', SIGNER,
];

describe.skipIf(process.platform !== 'linux')('status bootstrap', () => {
  let fixture: string;
  let compiled: string;
  let launcher: string;
  let outputFailurePreload: string;

  beforeAll(() => {
    expect(execFileSync('flock', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    })).toContain('util-linux');

    fixture = mkdtempSync(join(APP, '.status-bootstrap-'));
    compiled = compileRelayerFixture(APP, fixture);
    launcher = join(compiled, 'scripts', 'relayer.sh');

    outputFailurePreload = join(fixture, 'fail-stdout.mjs');

    // Preserve the real readers and renderers. Fail only the stdout write.
    writeFileSync(outputFailurePreload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';

      const original = fs.writeSync;

      fs.writeSync = function(fd, ...args) {
        if (fd === 1) {
          const error = new Error('Injected stdout failure.');
          error.code = 'EIO';
          throw error;
        }

        return original.call(fs, fd, ...args);
      };

      syncBuiltinESMExports();
    `);
  }, 40_000);

  afterAll(() => {
    if (fixture !== undefined) {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  function directory(): string {
    const state = mkdtempSync(join(fixture, 'state-'));
    writeFileSync(join(state, 'relayer.flock'), 'preserve-lock');
    return state;
  }

  function journalPath(state: string): string {
    return join(
      state,
      `transaction-journal-${CHAIN_ID}-${SIGNER}.json`,
    );
  }

  function seedJournal(state: string): void {
    const observation = {
      anchor: {
        blockNumber: '100',
        blockHash: HASH,
      },
      nonce: '4',
    };

    writeFileSync(journalPath(state), JSON.stringify({
      version: 1,
      identity: {
        chainId: CHAIN_ID,
        signer: SIGNER,
      },
      baseline: observation,
      lastObservation: observation,
      nextNonce: '4',
      durableNextNonce: '4',
      repairs: [],
      attempts: [],
    }) + '\n');
  }

  function seedSnapshot(
    state: string,
    observedAt = new Date().toISOString(),
  ): void {
    writeFileSync(join(state, 'daemon-status.json'), JSON.stringify({
      version: 1,
      identity: {
        chainId: CHAIN_ID,
        signer: SIGNER,
      },
      runId: '11111111-1111-4111-8111-111111111111',
      observedAt,
      journalInitialized: true,
      attempts: [],
      lastCompletedCycle: null,
      lastRetryObservation: null,
      lastObservedGate: {
        open: true,
        primaryReason: null,
        blockers: [],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
        blockedSince: null,
      },
    }) + '\n');
  }

  function contents(state: string): Record<string, string> {
    return Object.fromEntries(
      readdirSync(state).sort().map((name) => [
        name,
        readFileSync(join(state, name), 'utf8'),
      ]),
    );
  }

  function run(
    state: string,
    options: {
      args?: string[];
      held?: boolean;
      outputFails?: boolean;
      direct?: boolean;
    } = {},
  ) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      QUICKNET_STATE_DIR: state,
      QUICKNET_ENV_FILE: join(fixture, 'does-not-exist.env'),
    };

    delete env.NODE_OPTIONS;
    delete env.PRIVATE_KEY;
    delete env.QUICKNET_RPC_URL;
    delete env.ROBINHOOD_TESTNET_RPC_URL;

    if (options.outputFails) {
      env.NODE_OPTIONS =
        '--import=' + pathToFileURL(outputFailurePreload).href;
    }

    const args = options.args ?? ARGS;

    const executable = options.direct ? process.execPath : 'sh';
    const executableArgs = options.direct
      ? [join(compiled, 'dist', 'bootstrap.js'), ...args]
      : [launcher, ...args];

    const child = options.held
      ? spawnSync('flock', [
          '--exclusive',
          join(state, 'relayer.flock'),
          executable,
          ...executableArgs,
        ], {
          cwd: APP,
          env,
          encoding: 'utf8',
          timeout: 5_000,
        })
      : spawnSync(executable, executableArgs, {
          cwd: APP,
          env,
          encoding: 'utf8',
          timeout: 5_000,
        });

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();

    return child;
  }

  it.each(['journal', 'daemon-snapshot'] as const)(
    'reports a present %s without signing configuration or file changes',
    (source) => {
      const state = directory();
      seedJournal(state);
      seedSnapshot(state);

      // A status read must not sweep orphaned temporary files.
      writeFileSync(
        journalPath(state) +
          '.123.12345678-1234-4123-8123-123456789abc.tmp',
        'preserve-temporary-file',
      );

      const before = contents(state);

      const child = run(state, {
        args: [...ARGS, '--source', source],
      });

      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toBe('');
      expect(child.stdout).toContain(
        source === 'journal'
          ? 'Journal: present'
          : 'Snapshot: present',
      );
      expect(child.stdout)
        .toContain('Current signing authorization: unknown');
      expect(contents(state)).toEqual(before);
    },
  );

  it('automatically reads the journal when ownership is available', () => {
    const state = directory();
    seedJournal(state);

    const child = run(state);

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('Status source: journal');
    expect(child.stdout).toContain('Next nonce: 4');
  });

  it('automatically reads the snapshot under real contention', () => {
    const state = directory();
    seedSnapshot(state);

    // Any accidental journal read would fail.
    writeFileSync(journalPath(state), 'invalid journal');

    const child = run(state, { held: true });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toContain('Status source: daemon snapshot');
    expect(child.stdout).toContain('Snapshot: present');
  });

  it('preserves explicit journal contention as exit 75', () => {
    const state = directory();

    const child = run(state, {
      args: [...ARGS, '--source', 'journal'],
      held: true,
    });

    expect(child.status).toBe(75);
    expect(child.stdout).toBe('');
  });

  it.each(['journal', 'daemon-snapshot'] as const)(
    'reports missing %s successfully without creating it',
    (source) => {
      const state = directory();
      const before = contents(state);

      const child = run(state, {
        args: [...ARGS, '--source', source],
      });

      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toBe('');
      expect(child.stdout).toContain(
        source === 'journal'
          ? 'Journal: missing'
          : 'Snapshot: missing',
      );
      expect(contents(state)).toEqual(before);
    },
  );

  it('reports a stale snapshot without assigning a health failure exit', () => {
    const state = directory();
    seedSnapshot(state, '2000-01-01T00:00:00.000Z');

    const child = run(state, {
      args: [...ARGS, '--source', 'daemon-snapshot'],
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('Snapshot age classification: stale');
    expect(child.stdout)
      .toContain('Current signing authorization: unknown');
  });

  it.each(['journal', 'daemon-snapshot'] as const)(
    'preserves a corrupt %s as failure without falling back',
    (source) => {
      const state = directory();
      seedJournal(state);
      seedSnapshot(state);

      writeFileSync(
        source === 'journal'
          ? journalPath(state)
          : join(state, 'daemon-status.json'),
        'invalid JSON',
      );

      const before = contents(state);

      const child = run(state, {
        args: [...ARGS, '--source', source],
      });

      expect(child.status).toBe(1);
      expect(child.stdout).toBe('');
      expect(JSON.parse(child.stderr)).toMatchObject({
        event: 'cli_failed',
      });
      expect(contents(state)).toEqual(before);
    },
  );

  it.each(['journal', 'daemon-snapshot'] as const)(
    'reports %s output failure as exit 2 with compact context',
    (source) => {
      const state = directory();
      seedJournal(state);
      seedSnapshot(state);
      const before = contents(state);

      const child = run(state, {
        args: [...ARGS, '--source', source],
        outputFails: true,
      });

      expect(child.status, child.stderr).toBe(2);
      expect(child.stdout).toBe('');

      const diagnostic = JSON.parse(child.stderr);

      expect(diagnostic).toMatchObject({
        event: 'output_failed',
        code: 'CLI_OUTPUT_FAILED',
        output: 'relayer-status',
        source,
        gate: 'unknown',
        ...(source === 'journal'
          ? { journal: 'present' }
          : { snapshot: 'present' }),
      });

      expect(diagnostic).not.toHaveProperty('observation');
      expect(diagnostic).not.toHaveProperty('attempts');
      expect(child.stderr).not.toContain('cli_failed');
      expect(contents(state)).toEqual(before);
    },
  );

  it('rejects direct journal inspection without inherited ownership', () => {
    const state = directory();
    seedJournal(state);

    const child = run(state, {
      args: [...ARGS, '--source', 'journal'],
      direct: true,
    });

    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain('SERVICE_LOCK_NOT_HELD');
  });

  it('accepts signer casing differences for both sources', () => {
    const state = directory();
    seedJournal(state);
    seedSnapshot(state);

    for (const source of ['journal', 'daemon-snapshot']) {
      const child = run(state, {
        args: [
          'status',
          '--chain-id', String(CHAIN_ID),
          '--signer', `0x${'AB'.repeat(20)}`,
          '--source', source,
        ],
      });

      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toBe('');
    }
  });
});