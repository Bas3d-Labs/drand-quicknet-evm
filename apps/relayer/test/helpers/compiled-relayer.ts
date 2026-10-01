import {
  execFileSync,
} from 'node:child_process';

import {
  copyFileSync,
  mkdirSync,
} from 'node:fs';

import {
  join,
} from 'node:path';

export function compileRelayerFixture(
  applicationDirectory: string,
  fixtureDirectory: string,
): string {
  const compiledApplication = join(
    fixtureDirectory,
    'compiled-app',
  );

  const scriptsDirectory = join(
    compiledApplication,
    'scripts',
  );

  mkdirSync(scriptsDirectory, {
    recursive: true,
  });

  // Preserve the package's module interpretation.
  copyFileSync(
    join(applicationDirectory, 'package.json'),
    join(compiledApplication, 'package.json'),
  );

  // Preserve the launcher's scripts/../dist layout.
  copyFileSync(
    join(applicationDirectory, 'scripts', 'relayer.sh'),
    join(scriptsDirectory, 'relayer.sh'),
  );

  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '-p',
      'tsconfig.json',
      '--outDir',
      join(compiledApplication, 'dist'),
    ],
    {
      cwd: applicationDirectory,
      stdio: 'pipe',
      timeout: 30_000,
    },
  );

  return compiledApplication;
}