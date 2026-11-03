import {
  readdir,
  readFile,
} from 'node:fs/promises';

import {
  fileURLToPath,
} from 'node:url';

import {
  join,
  relative,
} from 'node:path';

import {
  expect,
  it,
} from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

const forbiddenModules = [
  '/signer-coordinator.js',
  '/signer-gate.js',
  '/signer-recovery-cycle.js',
  '/recover-signer-at-heads.js',
  '/inspect-signer-bootstrap.js',
  '/inspect-signer-recovery.js',
  '/inspect-signer-inclusions.js',
  '/submit-transaction.js',
];

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

it('keeps transaction internals out of production callers', async () => {
  const violations: string[] = [];

  for (const directory of ['cli', 'daemon', 'rounds', 'consumers']) {
    for (const path of await sourceFiles(join(sourceRoot, directory))) {
      const source = await readFile(path, 'utf8');

      for (const module of forbiddenModules) {
        if (source.includes(module)) {
          violations.push(
            relative(sourceRoot, path) + ': ' + module,
          );
        }
      }
    }
  }

  expect(violations).toEqual([]);
});