import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRpcMetrics,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  createDiagnosticTrace,
  TRACE_LIMITS,
  type TraceWriter,
  type TraceLimits,
} from '../../../src/diagnostics/trace/diagnostic-trace.js';

import {
  projectTraceStatus,
} from '../../../src/diagnostics/trace/trace-projection.js';

import {
  AT,
  IDENTITY,
  RUN_ID,
  statusFixture,
} from './trace-fixtures.js';

function fixture(
  writer?: TraceWriter,
  limits?: TraceLimits,
) {
  const lines: string[] = [];

  const onFailure = vi.fn();

  const output = writer ?? {
    async write(bytes: Buffer) {
      lines.push(bytes.toString());
    },
    close: vi.fn(async () => {}),
  };

  const trace = createDiagnosticTrace({
    writer: output,
    identity: IDENTITY,
    runId: RUN_ID,
    onFailure,
    ...(limits === undefined ? {} : { limits }),
  });

  const metrics = createRpcMetrics({ onTrace: trace.rpc });

  trace.start(metrics.snapshot());

  return { trace, metrics, lines, onFailure, output };
}

const SECRET = 'https://private.quiknode.pro/credential-token?secret=abc';

describe('diagnostic trace', () => {
  it.each([0, 2, 1.5])(
    'rejects a snapshot attributed to cycle %s',
    async (cycle) => {
      const t = fixture();

      t.trace.cycle(cycle, statusFixture(t.metrics), 'success');

      await t.trace.close(t.metrics.snapshot());

      expect(t.trace.health().failure).toBe('invalid-event');

      expect(t.lines.join('')).not.toContain('cycle_completed_snapshot');
    },
  );

  it.each(['logical', 'http'] as const)(
    'marks an outstanding %s call invalid before writing the footer',
    async (layer) => {
      const t = fixture();

      const held = Promise.withResolvers<Response>();

      let pending: Promise<Response>;

      if (layer === 'logical') {
        pending = t.metrics.logical('public', 'eth_call', () => held.promise);
      } else {
        pending = t.metrics.http('public', () => held.promise);
      }

      await t.trace.close(t.metrics.snapshot());

      expect(JSON.parse(t.lines.at(-1)!).health).toMatchObject({
        valid: false,
        failure: 'rpc-in-flight',
      });

      held.resolve(new Response());

      await pending;

      expect(t.trace.health().failure).toBe('rpc-in-flight');

      expect(t.trace.health().droppedEvents).toBe(1);

      expect(t.onFailure).toHaveBeenCalledTimes(1);
    },
  );

  it('captures identity and limits before caller mutation', async () => {
    const lines: string[] = [];

    const options = {
      writer: {
        async write(bytes: Buffer) {
          lines.push(bytes.toString());
        },
        async close() {},
      },
      identity: IDENTITY,
      runId: RUN_ID,
      limits: { ...TRACE_LIMITS },
      onFailure: vi.fn(),
    };

    const trace = createDiagnosticTrace(options);

    options.runId = SECRET;

    options.limits.fileBytes = 1;

    const metrics = createRpcMetrics();

    trace.start(metrics.snapshot());

    await trace.close(metrics.snapshot());

    expect(trace.health().valid).toBe(true);

    expect(lines.join('')).not.toContain(SECRET);

    expect(JSON.parse(lines[0]!).limits).toEqual(TRACE_LIMITS);
  });

  it('writes ordered bounded values, public status and terminal counters', async () => {
    const t = fixture();

    await t.metrics.logical('public', 'eth_call', async () => SECRET);

    const status = statusFixture(t.metrics);

    t.trace.cycle(1, status, 'success');

    await t.trace.close(t.metrics.snapshot());

    const rows = t.lines.map((line) => JSON.parse(line));

    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);

    expect(rows[3].status).toEqual(status);

    expect(rows[4].counters.logical[0].completed).toBe(1);

    expect(rows[5].kind).toBe('trace_closed');

    expect(t.lines.join('')).not.toContain(SECRET);

    expect(t.trace.health().valid).toBe(true);
  });

  it('never serializes request results, raw rejection or unknown method labels', async () => {
    const t = fixture();

    const error = new Error(SECRET);

    await expect(
      t.metrics.logical('wallet', SECRET, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    await t.trace.close(t.metrics.snapshot());

    expect(t.lines.join('')).not.toContain(SECRET);

    expect(t.lines.join('')).toContain('"method":"other"');

    expect(t.trace.health().valid).toBe(true);
  });

  it.each(['providerUrl', 'credential', 'sensitivePath'])(
    'rejects unexpected status field %s',
    async (key) => {
      const t = fixture();

      const status = { ...statusFixture(t.metrics), [key]: SECRET };

      t.trace.cycle(1, status, 'success');

      await t.trace.close(t.metrics.snapshot());

      expect(t.trace.health().failure).toBe('invalid-event');

      expect(t.lines.join('')).not.toContain(SECRET);

      expect(t.onFailure).toHaveBeenCalledTimes(1);
    },
  );

  it('does not invoke getters or toJSON on embedded status', async () => {
    const t = fixture();

    const getter = vi.fn(() => SECRET);

    const status = statusFixture(t.metrics);

    Object.defineProperty(status, 'observedAt', { get: getter });

    t.trace.cycle(1, status, 'success');

    await t.trace.close(t.metrics.snapshot());

    expect(getter).not.toHaveBeenCalled();

    expect(t.trace.health().valid).toBe(false);
  });

  it.each([SECRET, '/home/private/key', 'credential-token'])(
    'rejects opaque work ID %s',
    (workId) => {
      const status = statusFixture();

      const populated = {
        ...status,
        attemptSummary: {
          retainedCount: 1,
          includedCount: 1,
          unresolvedCount: 0,
          lowestNonce: '1',
          highestNonce: '1',
          detailedCount: 1,
          omittedCount: 0,
        },
        attempts: [
          {
            attemptId: RUN_ID,
            workId,
            nonce: '1',
            phase: 'included',
            transactionHashes: [`0x${'aa'.repeat(32)}`],
          },
        ],
      };

      expect(() => projectTraceStatus(populated, IDENTITY)).toThrow();
      populated.attempts[0]!.workId = `quicknet-round:v1:46630:0x${'aa'.repeat(20)}:42`;

      expect(projectTraceStatus(populated, IDENTITY)).toEqual(populated);
    },
  );

  it('retains the synchronous cut when the caller mutates later', async () => {
    const t = fixture();

    const status = statusFixture(t.metrics);

    t.trace.cycle(1, status, 'success');

    status.observedAt = SECRET;

    await t.trace.close(t.metrics.snapshot());

    const row = t.lines
      .map((line) => JSON.parse(line))
      .find((row) => row.kind === 'cycle_completed_snapshot');

    expect(row.status.observedAt).toBe(AT);

    expect(t.lines.join('')).not.toContain(SECRET);
  });

  it('bounds the queue including the held write and invalidates once', async () => {
    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writer = { write: vi.fn(() => held), close: vi.fn(async () => {}) };

    const t = fixture(writer, { ...TRACE_LIMITS, bufferRecords: 2 });

    await new Promise(setImmediate);

    await t.metrics.logical('public', 'eth_call', async () => 1);

    expect(t.trace.health().failure).toBe('buffer-limit');

    expect(t.trace.health().bufferedBytes).toBeLessThanOrEqual(
      TRACE_LIMITS.bufferBytes,
    );

    expect(t.trace.health().droppedEvents).toBe(1);

    release();

    await t.trace.close(t.metrics.snapshot());

    expect(t.onFailure).toHaveBeenCalledTimes(1);

    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  it('bounds total accepted bytes and reserves an invalid footer', async () => {
    const t = fixture(undefined, { ...TRACE_LIMITS, fileBytes: 6000 });

    for (let i = 0; i < 20; i += 1) {
      await t.metrics.logical('public', 'eth_call', async () => 1);
    }

    await t.trace.close(t.metrics.snapshot());

    expect(t.trace.health().failure).toBe('file-limit');

    expect(Buffer.byteLength(t.lines.join(''))).toBeLessThanOrEqual(6000);

    expect(JSON.parse(t.lines.at(-1)!).health.valid).toBe(false);
  });

  it('contains writer and notification failures without changing RPC outcome', async () => {
    const writer = {
      write: vi.fn(async () => {
        throw new Error(SECRET);
      }),
      close: vi.fn(async () => {}),
    };

    const t = fixture(writer);

    t.onFailure.mockImplementation(() => {
      throw new Error(SECRET);
    });

    await expect(
      t.metrics.logical('public', 'eth_call', async () => 7),
    ).resolves.toBe(7);

    await t.trace.close(t.metrics.snapshot());

    expect(t.trace.health().failure).toBe('write-failed');

    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  it('times out shutdown without waiting forever for a stalled writer', async () => {
    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writer = { write: vi.fn(() => held), close: vi.fn(async () => {}) };

    const t = fixture(writer, { ...TRACE_LIMITS, closeTimeoutMs: 10 });

    await t.trace.close(t.metrics.snapshot());

    expect(t.trace.health().failure).toBe('close-timeout');

    release();

    await new Promise(setImmediate);

    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  it('closes once and reports close failure with no raw error', async () => {
    const writer = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {
        throw new Error(SECRET);
      }),
    };

    const t = fixture(writer);

    await Promise.all([
      t.trace.close(t.metrics.snapshot()),
      t.trace.close(t.metrics.snapshot()),
    ]);

    expect(writer.close).toHaveBeenCalledTimes(1);

    expect(t.onFailure).toHaveBeenCalledWith('close-failed');
  });
});
