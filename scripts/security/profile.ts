import {
  readdir,
} from 'node:fs/promises';

import {
  basename,
  resolve,
} from 'node:path';

import {
  loadChainProfile,
  type LoadedChainProfile,
} from './core/profile.js';

interface CliOptions {
  network?: string;
}

interface ProfileResult {
  profilePath: string;
  network: string;
  loaded?: LoadedChainProfile;
  error?: Error;
}

const CHAIN_PROFILES_DIRECTORY = resolve(
  'docs',
  'security',
  'chain-profiles',
);

function parseArguments(
  args: string[],
): CliOptions {
  const options: CliOptions = {};

  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === '--network') {
      const network = args[index + 1];
      if (network === undefined || network.length === 0) {
        throw new Error('--network requires a value.');
      }

      options.network = network;
      index += 2;
      continue;
    }

    throw new Error(`unsupported argument: ${argument}`);
  }

  return options;
}

function profileNetworkFromFilename(
  filename: string,
): string {
  const suffix = '.yaml';
  if (!filename.endsWith(suffix)) {
    throw new Error(`profile filename must end with ${suffix}: ${filename}.`)
  }

  return filename.slice(0, filename.length - suffix.length);
}

async function discoverProfilePaths(): Promise<string[]> {
  const entries = await readdir(
    CHAIN_PROFILES_DIRECTORY,
    { withFileTypes: true },
  );

  const profilePaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.yaml')) {
      continue;
    }

    profilePaths.push(
      resolve(CHAIN_PROFILES_DIRECTORY, entry.name),
    );
  }

  profilePaths.sort();

  return profilePaths;
}

function selectProfilePaths(
  profilePaths: string[],
  network: string | undefined,
): string[] {
  if (network === undefined) {
    return profilePaths;
  }

  for (const profilePath of profilePaths) {
    const filename = basename(profilePath);
    if (profileNetworkFromFilename(filename) === network) {
      return [profilePath];
    }
  }

  throw new Error(`no committed chain profile found for network: ${network}.`);
}

async function validateProfile(
  profilePath: string,
): Promise<ProfileResult> {
  const filename = basename(profilePath);
  const network = profileNetworkFromFilename(filename);

  try {
    const loaded = await loadChainProfile(profilePath);

    return {
      profilePath,
      network,
      loaded,
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        profilePath,
        network,
        error,
      };
    }

    return {
      profilePath,
      network,
      error: new Error(
        'profile validation failed with an unknown error.'
      ),
    };
  }
}

function printValidProfile(
  result: ProfileResult,
): void {
  if (result.loaded === undefined) {
    throw new Error(
      'cannot print a valid profile without loaded profile data.'
    );
  }

  const loaded = result.loaded;

  console.log(`VALID ${result.network}`);
  console.log(`  chainId: ${loaded.profile.chainId}`);
  console.log(
    `  onboardingTier: ${loaded.profile.onboardingTier}`,
  );
  console.log(
    '  minimumChainClockLeadSeconds: '
    + loaded.derivedTiming.minimumChainClockLeadSeconds,
  );
  console.log(
    '  timestampSkewViolationSeconds: '
    + loaded.derivedTiming.timestampSkewViolationSeconds,
  );
  console.log(
    `  manifest: ${loaded.manifestPath}`,
  );
}

function printInvalidProfile(
  result: ProfileResult,
): void {
  console.error(`ERROR ${result.network}`);

  if (result.error !== undefined) {
    console.error(`  ${result.error.message}`);
  }
}

async function main(): Promise<void> {
  const options = parseArguments(
    process.argv.slice(2)
  );

  const discovered = await discoverProfilePaths();
  if (discovered.length === 0) {
    throw new Error('no commited chain profiles found.');
  }

  const selected = selectProfilePaths(
    discovered,
    options.network,
  );

  const results: ProfileResult[] = [];

  for (const profilePath of selected) {
    results.push(await validateProfile(profilePath));
  }

  let hasError = false;

  for (const result of results) {
    if (result.error !== undefined) {
      hasError = true;
      printInvalidProfile(result);
      continue;
    }

    printValidProfile(result);
  }

  console.log('');

  if (hasError) {
    console.error(`ERROR ${results.length} profile(s) checked.`);
    process.exitCode = 1;
    return;
  }

  console.log(`VALID ${results.length} profile(s) checked.`);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`ERROR ${error.message}`);
  } else {
    console.error('ERROR security profile validation failed.');
  }

  process.exitCode = 1;
});