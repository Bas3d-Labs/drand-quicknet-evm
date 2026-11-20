import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  link,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRpcMetrics,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  openDiagnosticTrace,
} from '../../../src/diagnostics/trace/open-diagnostic-trace.js';

import {
  IDENTITY,
  RUN_ID,
} from './trace-fixtures.js';

let directory: string;

const options = { identity: IDENTITY, runId: RUN_ID, onFailure: vi.fn() };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'quicknet-trace-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('trace file ownership', () => {
  it('creates a new 0600 file, flushes on close and never overwrites it', async () => {
    const path = join(directory, 'trace.jsonl');

    const trace = await openDiagnosticTrace(path, options);

    const metrics = createRpcMetrics({ onTrace: trace.rpc });

    trace.start(metrics.snapshot());

    await metrics.logical('public', 'eth_call', async () => 1);

    await trace.close(metrics.snapshot());

    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const content = await readFile(path, 'utf8');

    expect(content.split('\n').filter(Boolean)).toHaveLength(5);

    await expect(openDiagnosticTrace(path, options)).rejects.toThrow(
      'Cannot open diagnostic trace file.',
    );

    expect(await readFile(path, 'utf8')).toBe(content);
  });

  it('rejects symlinks, hard links and existing directories without modifying targets', async () => {
    const target = join(directory, 'target');

    await writeFile(target, 'preserve');

    const indirect = join(directory, 'link');

    const hard = join(directory, 'hard');

    await symlink(target, indirect);

    await link(target, hard);

    for (const path of [indirect, hard, directory]) {
      await expect(openDiagnosticTrace(path, options)).rejects.toThrow(
        'Cannot open diagnostic trace file.',
      );
    }

    expect(await readFile(target, 'utf8')).toBe('preserve');
  });

  it('rejects relative, missing and symlinked parents with sanitized errors', async () => {
    const alias = join(directory, 'alias');

    await symlink(directory, alias);

    for (const path of [
      'relative-secret',
      join(directory, 'secret', 'file'),
      join(alias, 'file'),
    ]) {
      try {
        await openDiagnosticTrace(path, options);

        expect.fail('Expected open failure');
      } catch (error) {
        expect((error as Error).message).toBe(
          'Cannot open diagnostic trace file.',
        );

        expect((error as Error).message).not.toContain(path);
      }
    }
  });
});
