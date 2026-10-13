/**
 * Process-death coverage using SIGKILL and a real journal/launcher.
 *
 * This does not simulate power loss, lost filesystem caches, torn sectors,
 * or storage-stack durability failures. Those require filesystem fault
 * injection beyond terminating a process.
 */

import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';

import {
  createServer,
  type ServerResponse,
} from 'node:http';

import {
  delimiter,
  join,
} from 'node:path';

import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';

import {
  keccak256,
  parseTransaction,
  type Hex,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import type {
  PersistenceBoundary,
} from '../../src/state/durable-replace.js';

import {
  compileRelayerFixture,
} from '../helpers/compiled-relayer.js';

import {
  writeSignerCrashPreload,
} from '../helpers/signer-crash-child.js';

const APP = fileURLToPath(new URL('../..', import.meta.url));

const CHAIN_ID = 4663;
const SIGNER = privateKeyToAccount(
  `0x${'11'.repeat(32)}`,
).address;

const IDENTITY = {
  chainId: CHAIN_ID,
  signer: SIGNER,
};

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVED_AT = '2000-01-01T00:00:00.000Z';

const NONCE = 4n;
const INITIAL_DELAY_MS = 5_000;
const WAIT_MS = 10_000;

const JOURNAL_FILENAME =
  `transaction-journal-${CHAIN_ID}-${SIGNER.toLowerCase()}.json`;

type ChainMode = 'initial' | 'included' | 'dropped';

type ChildMode = ChainMode | 'restored-signed';

interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

interface SendRecord {
  readonly raw: Hex;
  readonly hash: Hex;
}

type Boundary =
  | {
      readonly kind: 'send';
      readonly record: SendRecord;
      readonly reply: () => void;
    }
  | {
      readonly kind: 'checkpoint';
      readonly body: Record<string, unknown>;
      readonly reply: () => void;
    }
  | {
      readonly kind: 'failure';
      readonly error: unknown;
    };

interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

async function bounded<T>(
  promise: Promise<T>,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description}.`));
        }, WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function blockHash(number: bigint): Hex {
  return `0x${number.toString(16).padStart(64, '0')}`;
}

function quantity(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

/**
 * The test process owns all chain evidence and accepted request bytes.
 * None of it disappears when the relayer child is killed.
 */
async function startRpcFixture() {
  let mode: ChainMode = 'initial';
  let durable = 100n;
  let latest = 100n;
  let expectedTransactionHash: Hex | undefined;

  const sends: SendRecord[] = [];
  const queued: Boundary[] = [];

  const waiters: Array<(event: Boundary) => void> = [];

  function publish(event: Boundary): void {
    const waiter = waiters.shift();

    if (waiter === undefined) {
      queued.push(event);
    } else {
      waiter(event);
    }
  }

  function next(signal: AbortSignal): Promise<Boundary> {
    signal.throwIfAborted();

    const event = queued.shift();

    if (event !== undefined) {
      return Promise.resolve(event);
    }

    return new Promise<Boundary>((resolve, reject) => {
      function accept(event: Boundary): void {
        signal.removeEventListener('abort', abort);
        resolve(event);
      }

      function abort(): void {
        const index = waiters.indexOf(accept);

        if (index !== -1) {
          waiters.splice(index, 1);
        }

        reject(signal.reason);
      }

      signal.addEventListener('abort', abort, { once: true });
      waiters.push(accept);
    });
  }

  function json(
    response: ServerResponse,
    value: unknown,
  ): void {
    response.writeHead(200, {
      'content-type': 'application/json',
    });

    response.end(JSON.stringify(value));
  }

  function blockNumber(tag: unknown): bigint {
    if (tag === 'safe' || tag === 'finalized') {
      return durable;
    }

    if (tag === 'latest' || tag === 'pending') {
      return latest;
    }

    if (typeof tag !== 'string') {
      throw new Error('Unexpected block selector.');
    }

    const number = BigInt(tag);

    if (number < 100n || number > latest) {
      throw new Error('Requested block is outside fixture history.');
    }

    return number;
  }

  function block(number: bigint) {
    return {
      number: quantity(number),
      hash: blockHash(number),
      parentHash: blockHash(number - 1n),
      nonce: '0x0000000000000000',
      sha3Uncles: blockHash(0n),
      logsBloom: `0x${'00'.repeat(256)}`,
      transactionsRoot: blockHash(0n),
      stateRoot: blockHash(0n),
      receiptsRoot: blockHash(0n),
      miner: SIGNER,
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      size: '0x1',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      timestamp: quantity(1_000n + number),
      baseFeePerGas: '0x1',
      transactions: [],
      uncles: [],
    };
  }

  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }

      const body = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      );

      if (request.url === '/checkpoint') {
        publish({
          kind: 'checkpoint',
          body,
          reply: () => json(response, {}),
        });

        return;
      }

      if (request.url !== '/') {
        throw new Error('Unexpected fixture endpoint.');
      }

      const rpc = body as RpcRequest;

      function reply(result: unknown): void {
        json(response, {
          jsonrpc: '2.0',
          id: rpc.id,
          result,
        });
      }

      switch (rpc.method) {
        case 'eth_getBlockByNumber':
          reply(block(blockNumber(rpc.params[0])));
          return;

        case 'eth_getTransactionCount': {
          expect(String(rpc.params[0]).toLowerCase())
            .toBe(SIGNER.toLowerCase());

          const at = blockNumber(rpc.params[1]);

          reply(quantity(
            mode === 'included' && at >= 101n
              ? NONCE + 1n
              : NONCE,
          ));

          return;
        }

        case 'eth_getTransactionReceipt': {
          expect(expectedTransactionHash).toBeDefined();
          expect(rpc.params[0]).toBe(expectedTransactionHash);

          if (mode !== 'included') {
            reply(null);
            return;
          }

          reply({
            transactionHash: expectedTransactionHash,
            transactionIndex: '0x0',
            blockNumber: quantity(101n),
            blockHash: blockHash(101n),
            from: SIGNER,
            to: SIGNER,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x2',
            contractAddress: null,
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            type: '0x2',
          });

          return;
        }

        case 'eth_sendRawTransaction': {
          expect(rpc.params).toHaveLength(1);

          const raw = rpc.params[0] as Hex;
          const transaction = parseTransaction(raw);

          expect(transaction.chainId).toBe(CHAIN_ID);
          expect(transaction.nonce).toBe(Number(NONCE));

          const record = {
            raw,
            hash: keccak256(raw),
          };

          if (expectedTransactionHash === undefined) {
            expectedTransactionHash = record.hash;
          } else {
            expect(record.hash).toBe(expectedTransactionHash);
          }

          sends.push(record);

          // This is the acceptance boundary. The first response is
          // deliberately never sent, including during child shutdown.
          publish({
            kind: 'send',
            record,
            reply: () => reply(record.hash),
          });

          return;
        }

        default:
          throw new Error(
            `Unexpected JSON-RPC method: ${rpc.method}`,
          );
      }
    })().catch((error: unknown) => {
      publish({ kind: 'failure', error });

      if (!response.headersSent) {
        response.writeHead(500);
      }

      response.end();
    });
  });

  await bounded(new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }), 'RPC fixture startup');

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('RPC fixture has no TCP address.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    sends,
    next,

    restartAs(branch: 'included' | 'dropped'): void {
      mode = branch;
      latest = branch === 'included' ? 101n : 100n;
      durable = 100n;
    },

    makeInclusionDurable(): void {
      expect(mode).toBe('included');
      durable = 101n;
    },

    expectTransaction(hash: Hex): void {
      if (expectedTransactionHash !== undefined) {
        expect(hash).toBe(expectedTransactionHash);
      }

      expectedTransactionHash = hash;
    },

    async close(): Promise<void> {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });

      // Includes the intentionally unanswered initial broadcast.
      server.closeAllConnections();
      await bounded(closed, 'RPC fixture shutdown');
    },
  };
}

describe.skipIf(process.platform !== 'linux')(
  'signer recovery after accepted broadcast and SIGKILL',
  () => {
    let fixture: string;
    let launcher: string;
    let preload: string;

    beforeAll(() => {
      expect(execFileSync('flock', ['--version'], {
        encoding: 'utf8',
        timeout: WAIT_MS,
      })).toContain('util-linux');

      fixture = mkdtempSync(join(APP, '.signer-crash-'));

      const compiled = compileRelayerFixture(APP, fixture);
      launcher = join(compiled, 'scripts', 'relayer.sh');
      preload = writeSignerCrashPreload(fixture, compiled);

      // Ensure the shell launcher uses the same Node as the test runner.
      symlinkSync(process.execPath, join(fixture, 'node'));
    }, 40_000);

    afterAll(() => {
      if (fixture !== undefined) {
        rmSync(fixture, { recursive: true, force: true });
      }
    });

    function environment(directory: string): NodeJS.ProcessEnv {
      // Do not inherit application credentials, env-file selection,
      // checkpoint configuration, or unrelated Node preloads.
      return {
        PATH: fixture + delimiter + (process.env.PATH ?? ''),
        NODE_ENV: 'production',
        QUICKNET_STATE_DIR: directory,
      };
    }

    function launch(
      directory: string,
      rpcUrl: string,
      mode: ChildMode,
      killBoundary?: PersistenceBoundary,
    ) {
      const child = spawn('sh', [launcher, 'daemon'], {
        cwd: APP,
        env: {
          ...environment(directory),
          NODE_OPTIONS: '--import=' + pathToFileURL(preload).href,
          FAULT_RPC_URL: rpcUrl,
          FAULT_MODE: mode,
          ...(killBoundary === undefined ? {} : {
            FAULT_PERSISTENCE_BOUNDARY: killBoundary,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let closed = false;

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const exit = new Promise<ExitResult>((resolve, reject) => {
        child.once('error', reject);

        child.once('close', (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      });

      // A spawn error can arrive before the first boundary is awaited.
      void exit.catch(() => {});

      return {
        child,
        exit,
        detail: () => JSON.stringify({ stdout, stderr }),

        async stop(): Promise<void> {
          if (!closed) {
            child.kill('SIGKILL');
          }

          await bounded(exit, 'child cleanup');
        },
      };
    }

    function status(
      directory: string,
      source: 'journal' | 'daemon-snapshot',
    ): string {
      const result = spawnSync('sh', [
        launcher,
        'status',
        '--chain-id', String(CHAIN_ID),
        '--signer', SIGNER,
        '--source', source,
      ], {
        cwd: APP,
        env: environment(directory),
        encoding: 'utf8',
        timeout: WAIT_MS,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');

      return result.stdout;
    }

    async function journal(
      directory: string,
      filename: string = JOURNAL_FILENAME,
    ) {
      const result = await FileTransactionJournalStore.read({
        filePath: join(directory, filename),
        identity: IDENTITY,
      });

      if (result.kind !== 'present') {
        throw new Error('Expected a persisted journal.');
      }

      return result.snapshot;
    }

    async function nextBoundary(
      rpc: Awaited<ReturnType<typeof startRpcFixture>>,
      owner: ReturnType<typeof launch>,
    ): Promise<Exclude<Boundary, { kind: 'failure' }>> {
      const controller = new AbortController();

      try {
        const event = await bounded(Promise.race([
          rpc.next(controller.signal),
          owner.exit.then((result): never => {
            throw new Error(
              `Child exited before boundary: ${
                JSON.stringify(result)
              } ${owner.detail()}`,
            );
          }),
        ]), 'child/RPC boundary');

        if (event.kind === 'failure') {
          throw event.error;
        }

        return event;
      } finally {
        controller.abort();
      }
    }

    async function nextCheckpoint(
      rpc: Awaited<ReturnType<typeof startRpcFixture>>,
      owner: ReturnType<typeof launch>,
      name: string,
    ) {
      const event = await nextBoundary(rpc, owner);

      if (event.kind !== 'checkpoint') {
        throw new Error(`Unexpected send before ${name}.`);
      }

      expect(event.body.name).toBe(name);
      return event;
    }

    it.each(['included', 'dropped'] as const)(
      'recovers the original transaction when it is %s',
      async (branch) => {
        const directory = join(
          mkdtempSync(join(fixture, branch + '-')),
          'state',
        );

        const rpc = await startRpcFixture();
        const children: ReturnType<typeof launch>[] = [];

        const boundary = (owner: ReturnType<typeof launch>) =>
          nextBoundary(rpc, owner);

        const checkpoint = (
          owner: ReturnType<typeof launch>,
          name: string,
        ) => nextCheckpoint(rpc, owner, name);

        try {
          const original = launch(directory, rpc.url, 'initial');
          children.push(original);

          const prepared = await checkpoint(original, 'prepared');

          expect(prepared.body.signCalls).toBe(1);
          expect(rpc.sends).toHaveLength(0);

          const beforeSend = await journal(directory);
          expect(beforeSend.attempts).toHaveLength(1);
          expect(beforeSend.attempts[0]!.phase).toBe('signed');
          expect(beforeSend.nextNonce).toBe(NONCE + 1n);

          prepared.reply();

          const accepted = await boundary(original);

          if (accepted.kind !== 'send') {
            throw new Error('Expected initial transaction acceptance.');
          }

          // The parent fixture received the request. No child-side
          // notification or broadcast response participates in this kill.
          expect(original.child.kill('SIGKILL')).toBe(true);

          expect(await bounded(
            original.exit,
            'SIGKILL exit',
          ), original.detail()).toEqual({
            code: null,
            signal: 'SIGKILL',
          });

          expect(rpc.sends).toHaveLength(1);

          const persisted = await journal(directory);
          expect(persisted.attempts).toHaveLength(1);

          const attempt = persisted.attempts[0]!;
          const candidate = attempt.signedTransactions[0];

          expect(attempt.attemptId)
            .toBe(beforeSend.attempts[0]!.attemptId);

          expect(attempt.phase).toBe('broadcast-may-have-occurred');
          expect(attempt.nonce).toBe(NONCE);
          expect(attempt.inclusion).toBeNull();
          expect(attempt.signedTransactions).toHaveLength(1);
          expect(persisted.nextNonce).toBe(NONCE + 1n);
          expect(persisted.durableNextNonce).toBe(NONCE);

          // Join the fixture's network evidence to the committed journal.
          expect(candidate.signedTransaction).toBe(accepted.record.raw);
          expect(candidate.transactionHash).toBe(accepted.record.hash);

          const journalPath = join(directory, JOURNAL_FILENAME);
          const snapshotPath = join(directory, 'daemon-status.json');

          const journalBytes = readFileSync(journalPath);
          const snapshotBytes = readFileSync(snapshotPath);
          const entries = readdirSync(directory).sort();

          // This crash follows completed journal persistence. No owned
          // temporary file should remain at this particular boundary.
          expect(entries).toEqual([
            'daemon-status.json',
            JOURNAL_FILENAME,
            'relayer.flock',
          ].sort());

          // Real launcher reacquisition proves kernel ownership release.
          // This also observes the pre-recovery state through real status.
          const journalOutput = status(directory, 'journal');

          expect(journalOutput).toContain('Journal: present');
          expect(journalOutput).toContain('Next nonce: 5');
          expect(journalOutput).toContain('Durable next nonce: 4');
          expect(journalOutput).toContain('Retained attempts: 1');
          expect(journalOutput).toContain(attempt.attemptId);
          expect(journalOutput)
            .toContain('Phase: broadcast-may-have-occurred');
          expect(journalOutput).toContain(candidate.transactionHash);
          expect(journalOutput).not.toContain(candidate.signedTransaction);

          const snapshotOutput = status(directory, 'daemon-snapshot');

          expect(snapshotOutput).toContain('Run ID: ' + RUN_ID);
          expect(snapshotOutput).toContain('Observed at: ' + OBSERVED_AT);
          expect(snapshotOutput)
            .toContain('Snapshot age classification: stale');

          expect(readFileSync(journalPath)).toEqual(journalBytes);
          expect(readFileSync(snapshotPath)).toEqual(snapshotBytes);
          expect(readdirSync(directory).sort()).toEqual(entries);

          rpc.restartAs(branch);

          const restarted = launch(directory, rpc.url, branch);
          children.push(restarted);

          const opened = await checkpoint(restarted, 'opened');

          expect(opened.body).toMatchObject({
            signCalls: 0,
            canBroadcast: false,
            status: {
              open: false,
              recoveryComplete: false,
              inclusionChecksComplete: false,
              persistenceState: 'idle',
            },
          });

          expect(rpc.sends).toHaveLength(1);

          // Opening an existing journal tolerates the dead run's snapshot.
          expect(readFileSync(snapshotPath)).toEqual(snapshotBytes);
          expect(await journal(directory)).toEqual(persisted);

          opened.reply();

          async function expectRetained(
            phase: 'included' | 'broadcast-may-have-occurred',
          ): Promise<void> {
            const current = await journal(directory);

            expect(current.nextNonce).toBe(persisted.nextNonce);
            expect(current.durableNextNonce).toBe(NONCE);
            expect(current.attempts).toHaveLength(1);

            expect(current.attempts[0]).toMatchObject({
              attemptId: attempt.attemptId,
              nonce: NONCE,
              phase,
              signedTransactions: attempt.signedTransactions,
            });
          }

          if (branch === 'included') {
            const included = await checkpoint(restarted, 'included');

            expect(included.body).toMatchObject({
              signCalls: 0,
              status: { open: false },
              result: {
                broadcast: null,
                retryDelayMs: null,
              },
            });

            expect(rpc.sends).toHaveLength(1);
            await expectRetained('included');

            const current = await journal(directory);

            expect(current.attempts[0]!.inclusion).toMatchObject({
              outcome: 'success',
              transactionHash: candidate.transactionHash,
              inclusion: {
                blockNumber: 101n,
                blockHash: blockHash(101n),
              },
            });

            // Receipt block B becomes durable only at this boundary.
            rpc.makeInclusionDurable();
            included.reply();

            const resolved = await checkpoint(restarted, 'resolved');

            expect(resolved.body).toMatchObject({
              signCalls: 0,
              status: {
                open: true,
                recoveryComplete: true,
                inclusionChecksComplete: true,
                persistenceState: 'idle',
              },
              result: {
                broadcast: null,
                retryDelayMs: null,
              },
            });

            const final = await journal(directory);

            expect(final.attempts).toHaveLength(0);
            expect(final.nextNonce).toBe(persisted.nextNonce);
            expect(final.durableNextNonce).toBe(NONCE + 1n);
            expect(rpc.sends).toHaveLength(1);

            resolved.reply();
          } else {
            const start = await checkpoint(restarted, 'retry-start');

            expect(start.body).toMatchObject({
              clock: 0,
              signCalls: 0,
              result: {
                broadcast: null,
                retryDelayMs: INITIAL_DELAY_MS,
              },
            });

            expect(rpc.sends).toHaveLength(1);
            await expectRetained('broadcast-may-have-occurred');
            start.reply();

            const before = await checkpoint(restarted, 'retry-before');

            expect(before.body).toMatchObject({
              clock: INITIAL_DELAY_MS - 1,
              signCalls: 0,
              result: {
                broadcast: null,
                retryDelayMs: 1,
              },
            });

            expect(rpc.sends).toHaveLength(1);
            await expectRetained('broadcast-may-have-occurred');
            before.reply();

            // The second network request, not a child announcement,
            // establishes that retry eligibility produced a broadcast.
            const retry = await boundary(restarted);

            if (retry.kind !== 'send') {
              throw new Error('Expected the recorded-byte rebroadcast.');
            }

            expect(rpc.sends).toHaveLength(2);
            expect(retry.record).toEqual(accepted.record);
            await expectRetained('broadcast-may-have-occurred');

            retry.reply();

            const rebroadcast = await checkpoint(
              restarted,
              'rebroadcast',
            );

            expect(rebroadcast.body).toMatchObject({
              clock: INITIAL_DELAY_MS,
              signCalls: 0,
              result: {
                broadcast: {
                  status: 'acknowledged',
                  attemptId: attempt.attemptId,
                  transactionHash: candidate.transactionHash,
                },
                retryDelayMs: INITIAL_DELAY_MS,
              },
            });

            await expectRetained('broadcast-may-have-occurred');
            rebroadcast.reply();
          }

          expect(await bounded(
            restarted.exit,
            'successful restart exit',
          ), restarted.detail()).toEqual({
            code: 0,
            signal: null,
          });

          expect(new Set(rpc.sends.map(({ raw }) => raw)).size).toBe(1);

          expect(rpc.sends).toHaveLength(
            branch === 'included' ? 1 : 2,
          );

          expect(readFileSync(snapshotPath)).toEqual(snapshotBytes);
        } finally {
          try {
            await Promise.all(children.map((child) => child.stop()));
          } finally {
            await rpc.close();
          }
        }
      },
      40_000,
    );

    it.each([
      'temp-synced',
      'renamed',
    ] as const)(
      'recovers the exact committed phase after SIGKILL at %s',
      async (killBoundary) => {
        const directory = join(
          mkdtempSync(join(fixture, killBoundary + '-')),
          'state',
        );

        const rpc = await startRpcFixture();
        const children: ReturnType<typeof launch>[] = [];

        const checkpoint = (
          owner: ReturnType<typeof launch>,
          name: string,
        ) => nextCheckpoint(rpc, owner, name);

        try {
          const original = launch(
            directory,
            rpc.url,
            'initial',
            killBoundary,
          );

          children.push(original);

          const prepared = await checkpoint(original, 'prepared');

          expect(prepared.body.signCalls).toBe(1);
          expect(rpc.sends).toHaveLength(0);

          const oldSnapshot = await journal(directory);
          expect(oldSnapshot.attempts).toHaveLength(1);

          const attempt = oldSnapshot.attempts[0]!;
          const candidate = attempt.signedTransactions[0];

          expect(attempt.phase).toBe('signed');
          expect(attempt.nonce).toBe(NONCE);
          expect(attempt.signedTransactions).toHaveLength(1);
          expect(oldSnapshot.nextNonce).toBe(NONCE + 1n);
          expect(oldSnapshot.durableNextNonce).toBe(NONCE);

          rpc.expectTransaction(candidate.transactionHash);

          const journalPath = join(directory, JOURNAL_FILENAME);
          const snapshotPath = join(directory, 'daemon-status.json');

          const oldJournalBytes = readFileSync(journalPath);
          const snapshotBytes = readFileSync(snapshotPath);

          const newSnapshot = {
            ...oldSnapshot,
            attempts: [{
              ...attempt,
              phase: 'broadcast-may-have-occurred' as const,
              inclusion: null,
            }],
          };

          prepared.reply();

          const held = await checkpoint(
            original,
            'persistence-' + killBoundary,
          );

          expect(held.body).toMatchObject({
            signCalls: 1,
            status: {
              open: false,
              persistenceState: 'writing',
            },
          });

          // The original child is still inside journal persistence.
          // No transaction request has reached the fixture.
          expect(rpc.sends).toHaveLength(0);

          expect(original.child.kill('SIGKILL')).toBe(true);

          expect(await bounded(
            original.exit,
            'persistence-boundary SIGKILL exit',
          ), original.detail()).toEqual({
            code: null,
            signal: 'SIGKILL',
          });

          expect(rpc.sends).toHaveLength(0);

          const expectedPhase = killBoundary === 'temp-synced'
            ? 'signed'
            : 'broadcast-may-have-occurred';

          const expectedSnapshot = killBoundary === 'temp-synced'
            ? oldSnapshot
            : newSnapshot;

          // Process death preserves the completed rename outcome.
          // Do not weaken this to an old-or-new assertion.
          expect(await journal(directory)).toEqual(expectedSnapshot);

          const entries = readdirSync(directory).sort();

          const tempFiles = entries.filter((name) => (
            name.startsWith(JOURNAL_FILENAME + '.') &&
            name.endsWith('.tmp')
          ));

          const ordinaryEntries = [
            'daemon-status.json',
            JOURNAL_FILENAME,
            'relayer.flock',
          ].sort();

          if (killBoundary === 'temp-synced') {
            expect(tempFiles).toHaveLength(1);

            expect(entries).toEqual([
              ...ordinaryEntries,
              tempFiles[0]!,
            ].sort());

            expect(readFileSync(journalPath)).toEqual(oldJournalBytes);

            // The orphan contains the complete prospective snapshot,
            // but readonly inspection must not promote it.
            expect(await journal(directory, tempFiles[0]!))
              .toEqual(newSnapshot);
          } else {
            expect(tempFiles).toHaveLength(0);
            expect(entries).toEqual(ordinaryEntries);
            expect(readFileSync(journalPath)).not.toEqual(oldJournalBytes);
          }

          // Capture every file, including the pre-rename orphan.
          const beforeStatus = entries.map((name) => ({
            name,
            bytes: readFileSync(join(directory, name)),
          }));

          const output = status(directory, 'journal');

          expect(output).toContain('Journal: present');
          expect(output).toContain('Next nonce: 5');
          expect(output).toContain('Durable next nonce: 4');
          expect(output).toContain('Retained attempts: 1');
          expect(output).toContain(attempt.attemptId);
          expect(output).toContain('Phase: ' + expectedPhase);
          expect(output).toContain(candidate.transactionHash);
          expect(output).not.toContain(candidate.signedTransaction);

          expect(readdirSync(directory).sort()).toEqual(entries);

          for (const file of beforeStatus) {
            expect(readFileSync(join(directory, file.name)))
              .toEqual(file.bytes);
          }

          expect(rpc.sends).toHaveLength(0);

          rpc.restartAs('dropped');

          const restarted = launch(
            directory,
            rpc.url,
            killBoundary === 'temp-synced'
              ? 'restored-signed'
              : 'dropped',
          );

          children.push(restarted);

          const opened = await checkpoint(restarted, 'opened');

          expect(opened.body).toMatchObject({
            signCalls: 0,
            canBroadcast: false,
            status: {
              open: false,
              recoveryComplete: false,
              inclusionChecksComplete: false,
              persistenceState: 'idle',
            },
          });

          // Only the real writable opening has removed the orphan.
          // It rewrites the committed snapshot, not the orphan's contents.
          expect(readdirSync(directory).sort()).toEqual(ordinaryEntries);
          expect(await journal(directory)).toEqual(expectedSnapshot);
          expect(readFileSync(snapshotPath)).toEqual(snapshotBytes);
          expect(rpc.sends).toHaveLength(0);

          opened.reply();

          if (killBoundary === 'renamed') {
            const start = await checkpoint(restarted, 'retry-start');

            expect(start.body).toMatchObject({
              clock: 0,
              signCalls: 0,
              result: {
                broadcast: null,
                retryDelayMs: INITIAL_DELAY_MS,
              },
            });

            expect(rpc.sends).toHaveLength(0);
            expect(await journal(directory)).toEqual(newSnapshot);
            start.reply();

            const before = await checkpoint(restarted, 'retry-before');

            expect(before.body).toMatchObject({
              clock: INITIAL_DELAY_MS - 1,
              signCalls: 0,
              result: {
                broadcast: null,
                retryDelayMs: 1,
              },
            });

            expect(rpc.sends).toHaveLength(0);
            expect(await journal(directory)).toEqual(newSnapshot);
            before.reply();
          }

          // For signed state this arrives at clock 0. For the renamed
          // marker it arrives only at the restored initial deadline.
          // In both cases it is the fixture's first transaction request.
          const sent = await nextBoundary(rpc, restarted);

          if (sent.kind !== 'send') {
            throw new Error('Expected the first recorded-byte broadcast.');
          }

          expect(rpc.sends).toHaveLength(1);
          expect(sent.record.raw).toBe(candidate.signedTransaction);
          expect(sent.record.hash).toBe(candidate.transactionHash);

          // Even the restored-signed case must persist its marker before
          // its first RPC send.
          expect(await journal(directory)).toEqual(newSnapshot);

          sent.reply();

          const completed = await checkpoint(restarted, 'rebroadcast');

          expect(completed.body).toMatchObject({
            clock: killBoundary === 'temp-synced'
              ? 0
              : INITIAL_DELAY_MS,
            signCalls: 0,
            result: {
              broadcast: {
                status: 'acknowledged',
                attemptId: attempt.attemptId,
                transactionHash: candidate.transactionHash,
              },
              retryDelayMs: INITIAL_DELAY_MS,
            },
          });

          expect(await journal(directory)).toEqual(newSnapshot);

          completed.reply();

          expect(await bounded(
            restarted.exit,
            'persistence recovery exit',
          ), restarted.detail()).toEqual({
            code: 0,
            signal: null,
          });

          expect(rpc.sends).toHaveLength(1);
          expect(new Set(rpc.sends.map(({ raw }) => raw)).size).toBe(1);
          expect(readdirSync(directory).sort()).toEqual(ordinaryEntries);
          expect(readFileSync(snapshotPath)).toEqual(snapshotBytes);
        } finally {
          try {
            await Promise.all(children.map((child) => child.stop()));
          } finally {
            await rpc.close();
          }
        }
      },
      40_000,
    );
  },
);