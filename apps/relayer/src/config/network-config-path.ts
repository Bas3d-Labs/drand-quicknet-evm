import {
  resolve,
} from 'node:path';

import process from 'node:process';

export interface ResolveNetworkConfigPathOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}

export function resolveNetworkConfigPath(
  value: string,
  options: ResolveNetworkConfigPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const initCwd = env.INIT_CWD?.trim();

  let baseDir = cwd;

  if (initCwd !== undefined && initCwd.length > 0) {
    baseDir = initCwd;
  }

  return resolve(baseDir, value);
}