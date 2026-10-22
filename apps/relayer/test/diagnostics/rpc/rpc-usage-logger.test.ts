import {
  writeSync,
} from 'node:fs';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRelayerLog,
} from '../../../src/diagnostics/relayer-log.js';

import type {
  RpcUsageLogContext,
} from '../../../src/diagnostics/rpc/rpc-usage-log.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeSync: vi.fn(),
}));

function context(): RpcUsageLogContext {
  return {
    observedAt: '2026-10-22T12:00:00.000Z',
    report: {
      collectorId: '11111111-1111-4111-8111-111111111111',
      startedAt: '2026-10-22T11:00:00.000Z',
      cumulative: {
        logical: [],
        http: [],
      },
      interval: {
        available: false,
        reason: 'no-baseline',
      },
    },
  };
}

function fixture(level = 'info') {
  const lines: string[] = [];

  const write = vi.fn((line: string) => {
    lines.push(line);
  });

  const logger = createRelayerLog({
    chainId: 4663,
    runId: '22222222-2222-4222-8222-222222222222',
    level,
    destination: { write },
  });

  return { logger, lines, write };
}

function fallbackRecord() {
  expect(writeSync).toHaveBeenCalledOnce();

  const call = vi.mocked(writeSync).mock.calls[0]!;

  expect(call[0]).toBe(2);
  return JSON.parse(String(call[1]));
}

describe('RPC usage logger', () => {
  beforeEach(() => {
    vi.mocked(writeSync).mockReset();
  });

  it('emits cumulative-only usage without inventing an interval', () => {
    const t = fixture();
    const input = context();

    t.logger.rpcUsage(input);

    expect(t.lines).toHaveLength(1);
    expect(JSON.parse(t.lines[0]!)).toMatchObject({
      level: 30,
      event: 'rpc_usage',
      msg: 'Relayer RPC usage',
      observedAt: input.observedAt,
      report: input.report,
    });
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each(['warn', 'silent'])(
    'suppresses RPC usage at level %s',
    (level) => {
      const t = fixture(level);

      t.logger.rpcUsage(context());

      expect(t.write).not.toHaveBeenCalled();
      expect(writeSync).not.toHaveBeenCalled();
    },
  );

  it('rejects an accessor without invoking it or poisoning later output', () => {
    const t = fixture();
    const input = context();
    const getter = vi.fn(() => {
      throw new Error('rpc-getter-secret');
    });

    Object.defineProperty(input, 'report', {
      get: getter,
    });

    expect(() => t.logger.rpcUsage(input)).not.toThrow();

    expect(t.lines).toHaveLength(0);
    expect(getter).not.toHaveBeenCalled();
    expect(fallbackRecord()).toMatchObject({
      event: 'logging_failed',
      code: 'LOG_RECORD_REJECTED',
      rejected: 'rpc_usage',
    });

    t.logger.rpcUsage(context());

    expect(t.lines).toHaveLength(1);
    expect(JSON.parse(t.lines[0]!).event).toBe('rpc_usage');
  });

  it('excludes undeclared fields and serialization hooks', () => {
    const t = fixture();
    const input = context();
    const secret = 'rpc-logger-secret';
    const toJSON = vi.fn(() => secret);
    const getter = vi.fn(() => secret);

    Object.assign(input, {
      secret,
      toJSON,
    });
    Object.assign(input.report, {
      secret,
      observedAtMs: 123,
      toJSON,
    });
    Object.defineProperty(input.report, 'extra', {
      get: getter,
    });

    t.logger.rpcUsage(input);

    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).not.toContain(secret);
    expect(t.lines[0]).not.toContain('observedAtMs');
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('contains destination failure and attempts later output', () => {
    const t = fixture();

    t.write.mockImplementationOnce(() => {
      throw new Error('rpc-destination-secret');
    });

    expect(() => t.logger.rpcUsage(context())).not.toThrow();

    expect(t.lines).toHaveLength(0);
    expect(fallbackRecord()).toMatchObject({
      event: 'logging_failed',
      code: 'LOG_OUTPUT_FAILED',
      rejected: 'rpc_usage',
    });

    t.logger.rpcUsage(context());

    expect(t.write).toHaveBeenCalledTimes(2);
    expect(t.lines).toHaveLength(1);
    expect(JSON.parse(t.lines[0]!).event).toBe('rpc_usage');
    expect(String(vi.mocked(writeSync).mock.calls[0]![1]))
      .not.toContain('rpc-destination-secret');
  });
});