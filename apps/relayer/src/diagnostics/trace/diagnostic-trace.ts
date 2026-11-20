import {
  performance,
} from 'node:perf_hooks';

import {
  isUuidV4,
} from '../../shared/uuid.js';

import {
  captureJournalIdentity,
} from '../../state/journal-identity.js';

import type {
  JournalIdentity,
} from '../../state/transaction-journal.js';

import type {
  RpcMetricsSnapshot,
  RpcTraceEvent,
} from '../rpc/rpc-metrics.js';

import {
  createRpcUsageSnapshot,
} from '../rpc/rpc-usage-snapshot.js';

import {
  projectRpcTrace,
  projectTraceStatus,
} from './trace-projection.js';

export interface TraceLimits {
  readonly recordBytes: number;
  readonly bufferBytes: number;
  readonly bufferRecords: number;
  readonly fileBytes: number;
  readonly footerReserveBytes: number;
  readonly closeTimeoutMs: number;
}

export const TRACE_LIMITS: Readonly<TraceLimits> = Object.freeze({
  recordBytes: 256 * 1024,
  bufferBytes: 2 * 1024 * 1024,
  bufferRecords: 4096,
  fileBytes: 256 * 1024 * 1024,
  footerReserveBytes: 4096,
  closeTimeoutMs: 5000,
});

export type TraceFailure =
  | 'invalid-event'
  | 'buffer-limit'
  | 'file-limit'
  | 'write-failed'
  | 'close-failed'
  | 'close-timeout'
  | 'rpc-in-flight';

export interface TraceWriter {
  write(bytes: Buffer): Promise<void>;

  close(): Promise<void>;
}

export interface DiagnosticTrace {
  start(snapshot: RpcMetricsSnapshot): void;

  rpc(event: RpcTraceEvent): void;

  cycle(
    cycle: number,
    status: unknown,
    outcome: 'success' | 'incomplete',
  ): void;

  close(snapshot: RpcMetricsSnapshot): Promise<void>;

  health(): Readonly<{
    valid: boolean;
    failure: TraceFailure | null;
    droppedEvents: number;
    bufferedBytes: number;
    highWaterBytes: number;
    acceptedBytes: number;
    writtenBytes: number;
  }>;
}

export interface DiagnosticTraceOptions {
  readonly writer: TraceWriter;
  readonly identity: JournalIdentity;
  readonly runId: string;
  readonly onFailure: (reason: TraceFailure) => void;
  /** Internal test seam, not operator configuration. */
  readonly limits?: Readonly<TraceLimits>;
}

export function createDiagnosticTrace(
  options: DiagnosticTraceOptions,
): DiagnosticTrace {
  const runId = options.runId;

  const writer = options.writer;

  const onFailure = options.onFailure;

  if (!isUuidV4(runId)) {
    throw new TypeError('Invalid diagnostic trace identity.');
  }

  const identity = captureJournalIdentity(options.identity);

  const limits = Object.freeze({ ...(options.limits ?? TRACE_LIMITS) });

  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Invalid diagnostic trace limits.');
    }
  }

  if (limits.fileBytes <= limits.footerReserveBytes) {
    throw new TypeError('Invalid diagnostic trace limits.');
  }

  const queue: Buffer[] = [];

  let sequence = 0;

  let collectorId: string | undefined;

  let failure: TraceFailure | null = null;

  let droppedEvents = 0;

  let bufferedBytes = 0;

  let highWaterBytes = 0;

  let acceptedBytes = 0;

  let writtenBytes = 0;

  let draining: Promise<void> | undefined;

  let closing: Promise<void> | undefined;

  let accepting = true;

  let writeFailed = false;

  function fail(
    reason: TraceFailure,
  ): void {
    if (failure !== null) {
      return;
    }

    failure = reason;

    try {
      onFailure(reason);
    } catch {
      // No diagnostic callback can stop recovery or replace its outcome.
    }
  }

  function health() {
    return Object.freeze({
      valid: failure === null,
      failure,
      droppedEvents,
      bufferedBytes,
      highWaterBytes,
      acceptedBytes,
      writtenBytes,
    });
  }

  async function pump(): Promise<void> {
    while (queue.length > 0) {
      const bytes = queue[0]!;

      try {
        await writer.write(bytes);

        writtenBytes += bytes.length;
      } catch {
        writeFailed = true;

        droppedEvents += queue.length;

        queue.length = 0;

        bufferedBytes = 0;

        fail('write-failed');
        return;
      }

      queue.shift();

      bufferedBytes -= bytes.length;
    }
  }

  function schedule(): void {
    if (draining !== undefined) {
      return;
    }
    // No file write starts on the producer's stack.
    draining = new Promise<void>((resolve) => setImmediate(resolve))
      .then(pump)
      .finally(() => {
        draining = undefined;

        if (queue.length > 0) {
          schedule();
        }
      });
  }

  function record(
    kind: string,
    payload: object,
  ): void {
    const event = {
      version: 1,
      runId,
      sequence: ++sequence,
      monotonicMs: performance.now(),
      kind,
      ...payload,
    };

    const bytes = Buffer.from(JSON.stringify(event) + '\n');

    if (bytes.length > limits.recordBytes) {
      throw new TypeError('Invalid diagnostic trace record.');
    }

    if (
      acceptedBytes + bytes.length >
      limits.fileBytes - limits.footerReserveBytes
    ) {
      fail('file-limit');

      droppedEvents += 1;
      return;
    }

    if (
      queue.length >= limits.bufferRecords ||
      bufferedBytes + bytes.length > limits.bufferBytes
    ) {
      fail('buffer-limit');

      droppedEvents += 1;
      return;
    }

    acceptedBytes += bytes.length;

    bufferedBytes += bytes.length;

    highWaterBytes = Math.max(highWaterBytes, bufferedBytes);

    queue.push(bytes);

    schedule();
  }

  function observe(
    action: () => void,
  ): void {
    if (!accepting || failure !== null) {
      if (!accepting) {
        fail('invalid-event');
      }

      droppedEvents += 1;
      return;
    }

    try {
      action();
    } catch {
      droppedEvents += 1;

      fail('invalid-event');
    }
  }

  async function finish(
    snapshot: RpcMetricsSnapshot,
  ): Promise<void> {
    observe(() => {
      if (snapshot.collectorId !== collectorId) {
        throw new TypeError('Invalid diagnostic collector.');
      }

      record('final_counters', {
        counters: createRpcUsageSnapshot(snapshot, new Date().toISOString()),
      });
    });

    if (
      snapshot.logical.some((row) => row.inFlight !== 0) ||
      snapshot.http.some((row) => row.inFlight !== 0)
    ) {
      fail('rpc-in-flight');
    }

    accepting = false;

    const work = (async () => {
      try {
        while (draining !== undefined) {
          await draining;
        }

        if (!writeFailed) {
          const footer = Buffer.from(
            JSON.stringify({
              version: 1,
              runId,
              sequence: ++sequence,
              monotonicMs: performance.now(),
              kind: 'trace_closed',
              health: health(),
            }) + '\n',
          );

          if (footer.length > limits.footerReserveBytes) {
            throw new Error('Diagnostic footer exceeds reserve.');
          }

          await writer.write(footer);

          writtenBytes += footer.length;
        }
      } catch {
        fail('write-failed');
      } finally {
        try {
          await writer.close();
        } catch {
          fail('close-failed');
        }
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            fail('close-timeout');

            resolve();
          }, limits.closeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    start(snapshot: RpcMetricsSnapshot): void {
      observe(() => {
        if (collectorId !== undefined) {
          throw new TypeError('Diagnostic trace already started.');
        }

        const observedAt = new Date().toISOString();

        const counters = createRpcUsageSnapshot(snapshot, observedAt);

        collectorId = counters.collectorId;

        record('trace_started', {
          observedAt,
          monotonicTimeOriginMs: performance.timeOrigin,
          scheduler: 'current',
          identity,
          limits,
          counters,
        });
      });
    },
    rpc(input: RpcTraceEvent): void {
      observe(() => {
        const rpc = projectRpcTrace(input);

        if (rpc.collectorId !== collectorId) {
          throw new TypeError('Invalid diagnostic collector.');
        }

        record('rpc', { rpc, operationId: null });
      });
    },
    cycle(
      cycle: number,
      input: unknown,
      outcome: 'success' | 'incomplete',
    ): void {
      observe(() => {
        const status = projectTraceStatus(input, identity);

        if (
          status.runId !== runId ||
          !Number.isSafeInteger(cycle) ||
          cycle < 1 ||
          status.lastCompletedCycle?.cycle !== cycle ||
          status.rpcUsage?.collectorId !== collectorId ||
          !['success', 'incomplete'].includes(outcome)
        ) {
          throw new TypeError('Invalid diagnostic cycle.');
        }

        record('cycle_completed_snapshot', {
          cycle,
          outcome,
          workClass: 'current-cycle',
          status,
        });
      });
    },
    close(snapshot: RpcMetricsSnapshot): Promise<void> {
      closing ??= finish(snapshot);

      return closing;
    },
    health,
  });
}
