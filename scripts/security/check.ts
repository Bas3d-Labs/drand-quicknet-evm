import { execFile } from 'node:child_process';
import {
  mkdir,
  writeFile,
} from 'node:fs/promises';

import {
  dirname,
  resolve,
} from 'node:path';

import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';

import { promisify } from 'node:util';

import {
  checkConsensusRootAtSnapshot,
} from './adapters/arbitrum-nitro/consensus-root.js';

import {
  checkTimestampEnvelopeAtSnapshot,
} from './adapters/arbitrum-nitro/timestamp-envelope.js';

import {
  createSecurityPublicClient,
  pinChainSnapshot,
  verifyRpcChainId,
} from './core/client.js';

import {
  type CheckResult,
} from './core/check.js';

import {
  checkDeployment,
} from './core/deployment.js';

import {
  loadChainProfile,
} from './core/profile.js';

import {
  createVerificationReport,
  serializeVerificationReport,
  type ReportValue,
  type VerificationCheck,
  type VerificationObservation,
  type VerificationReport,
} from './core/report.js';

const execFileAsync = promisify(execFile);

const SCRIPT_DIRECTORY = dirname(
  fileURLToPath(import.meta.url),
);

const REPOSITORY_ROOT = resolve(
  SCRIPT_DIRECTORY,
  '../..',
);

const PROFILE_DIRECTORY = resolve(
  REPOSITORY_ROOT,
  'docs/security/chain-profiles',
);

interface CliArguments {
  network: string;
  rpcUrl: string;
  parentRpcUrl: string | undefined;
  reportPath: string | undefined;
}

interface RepositoryState {
  revision: string;
  dirty: boolean;
}

type DeploymentResult =
  Awaited<ReturnType<typeof checkDeployment>>;

type TimestampEnvelopeResult =
  Awaited<ReturnType<typeof checkTimestampEnvelopeAtSnapshot>>;

type ConsensusRootResult =
  Awaited<ReturnType<typeof checkConsensusRootAtSnapshot>>;

function errorMessage(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function requireArgumentValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];

  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.startsWith('--')
  ) {
    throw new Error(
      `${option} requires a value.`,
    );
  }

  return value;
}

function parseArguments(
  args: readonly string[],
): CliArguments {
  let network: string | undefined;
  let rpcUrl: string | undefined;
  let parentRpcUrl: string | undefined;
  let reportPath: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];

    if (argument === '--network') {
      if (network !== undefined) {
        throw new Error(
          '--network may only be provided once.',
        );
      }

      network = requireArgumentValue(args, i, '--network');

      i += 1;
      continue;
    }

    if (argument === '--rpc-url') {
      if (rpcUrl !== undefined) {
        throw new Error('--rpc-url may only be provided once.');
      }

      rpcUrl = requireArgumentValue(args, i, '--rpc-url');

      i += 1;
      continue;
    }

    if (argument === '--parent-rpc-url') {
      if (parentRpcUrl !== undefined) {
        throw new Error('--parent-rpc-url may only be provided once.');
      }

      parentRpcUrl = requireArgumentValue(args, i, '--parent-rpc-url');

      i += 1;
      continue;
    }

    if (argument === '--report') {
      if (reportPath !== undefined) {
        throw new Error('--report may only be provided once.');
      }

      reportPath = requireArgumentValue(args, i, '--report');

      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument ?? '<missing>'}.`);
  }

  if (network === undefined) {
    throw new Error('--network is required.');
  }

  if (rpcUrl === undefined) {
    throw new Error('--rpc-url is required.');
  }

  return {
    network,
    rpcUrl,
    parentRpcUrl,
    reportPath,
  };
}

function resolveProfilePath(
  network: string,
): string {
  const profilePath = resolve(
    PROFILE_DIRECTORY,
    `${network}.yaml`,
  );

  if (dirname(profilePath) !== PROFILE_DIRECTORY) {
    throw new Error(`Invalid network name: ${network}.`);
  }

  return profilePath;
}

async function readRepositoryState(): Promise<RepositoryState> {
  const revisionResult =
    await execFileAsync(
      'git',
      [
        'rev-parse',
        'HEAD',
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
      },
    );

  const revision =
    revisionResult.stdout.trim();

  if (revision.length === 0) {
    throw new Error(
      'Git returned an empty repository revision.',
    );
  }

  const statusResult =
    await execFileAsync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
      },
    );

  return {
    revision,
    dirty: statusResult.stdout.trim().length > 0,
  };
}

function stringValue(
  value: string,
): ReportValue {
  return value;
}

function nullableStringValue(
  value: string | null | undefined,
): ReportValue {
  if (value === undefined) {
    return null;
  }

  return value;
}

function integerValue(
  value: number | bigint,
): ReportValue {
  return value;
}

function timeVariationValue(
  value: {
    delayBlocks: number | bigint;
    futureBlocks: number | bigint;
    delaySeconds: number | bigint;
    futureSeconds: number | bigint;
  },
): ReportValue {
  return {
    delayBlocks: value.delayBlocks,
    futureBlocks: value.futureBlocks,
    delaySeconds: value.delaySeconds,
    futureSeconds: value.futureSeconds,
  };
}

function approvedRootsValue(
  value: readonly {
    consensusRelease: string;
    root: string;
  }[],
): ReportValue {
  return value.map(
    approved => ({
      consensusRelease:
        approved.consensusRelease,
      root: approved.root,
    }),
  );
}

function toVerificationCheck<
  TExpected,
  TObserved,
>(
  id: string,
  observationIds: readonly string[],
  check: CheckResult<TExpected, TObserved>,
  expectedValue: (value: TExpected) => ReportValue,
  observedValue: (value: TObserved) => ReportValue,
  details?: ReportValue,
): VerificationCheck {
  if (check.status === 'MATCH') {
    const result: VerificationCheck = {
      id,
      observationIds,
      status: 'MATCH',
      expected: expectedValue(check.expected),
      observed: observedValue(check.observed),
    };

    if (details !== undefined) {
      result.details = details;
    }

    return result;
  }

  if (check.status === 'DRIFT') {
    const result: VerificationCheck = {
      id,
      observationIds,
      status: 'DRIFT',
      expected: expectedValue(check.expected),
      observed: observedValue(check.observed),
      reason: check.reason,
    };

    if (details !== undefined) {
      result.details = details;
    }

    return result;
  }

  if (check.status === 'ERROR') {
    const result: VerificationCheck = {
      id,
      observationIds,
      status: 'ERROR',
      expected: expectedValue(check.expected),
      error: check.error,
    };

    if (details !== undefined) {
      result.details = details;
    }

    return result;
  }

  const result: VerificationCheck = {
    id,
    observationIds,
    status: 'SKIPPED',
    expected: expectedValue(check.expected),
    reason: check.reason,
  };

  if (details !== undefined) {
    result.details = details;
  }

  return result;
}

function executionErrorCheck(
  id: string,
  observationIds: readonly string[],
  expected: ReportValue,
  error: unknown,
): VerificationCheck {
  return {
    id,
    observationIds,
    status: 'ERROR',
    expected,
    error: errorMessage(error),
  };
}

function deploymentChecksToReportChecks(
  result: DeploymentResult,
): VerificationCheck[] {
  return [
    toVerificationCheck(
      'deployment.registry-runtime-codehash',
      [
        'l2',
      ],
      result.checks.registryRuntimeCodehash,
      stringValue,
      nullableStringValue,
    ),
    toVerificationCheck(
      'deployment.verifier-runtime-codehash',
      [
        'l2',
      ],
      result.checks.verifierRuntimeCodehash,
      stringValue,
      nullableStringValue,
    ),
    toVerificationCheck(
      'deployment.registry-minimum-lead-rounds',
      [
        'l2',
      ],
      result.checks.registryMinimumLeadRounds,
      integerValue,
      integerValue,
    ),
  ];
}

function timestampEnvelopeChecksToReportChecks(
  result: TimestampEnvelopeResult,
): VerificationCheck[] {
  return [
    toVerificationCheck(
      'arbitrum-nitro.sequencer-inbox',
      [
        'parent',
      ],
      result.checks.sequencerInbox,
      stringValue,
      stringValue,
    ),
    toVerificationCheck(
      'arbitrum-nitro.max-time-variation',
      [
        'parent',
      ],
      result.checks.maxTimeVariation,
      timeVariationValue,
      timeVariationValue,
    ),
  ];
}

function consensusRootCheckToReportCheck(
  result: ConsensusRootResult,
): VerificationCheck {
  let details: ReportValue | undefined;

  if (result.check.status === 'MATCH') {
    details = {
      matchedApprovedRoot: {
        consensusRelease: result.check.matched.consensusRelease,
        root: result.check.matched.root,
      },
    };
  }

  return toVerificationCheck(
    'arbitrum-nitro.wasm-module-root',
    [
      'parent',
    ],
    result.check,
    approvedRootsValue,
    stringValue,
    details,
  );
}

function l2Observation(
  result: DeploymentResult,
): VerificationObservation {
  return {
    id: 'l2',
    chainId: result.observedChainId,
    blockNumber: result.snapshot.blockNumber,
    blockTimestamp: result.snapshot.blockTimestamp,
  };
}

function parentObservation(
  chainId: number,
  blockNumber: bigint,
  blockTimestamp: bigint,
): VerificationObservation {
  return {
    id: 'parent',
    chainId,
    blockNumber,
    blockTimestamp,
  };
}

function aggregateExitCode(
  report: VerificationReport,
): number {
  if (report.aggregateStatus === 'MATCH') {
    return 0;
  }

  if (report.aggregateStatus === 'DRIFT') {
    return 2;
  }

  return 1;
}

function printReportSummary(
  report: VerificationReport,
  reportPath: string | undefined,
): void {
  console.log(`${report.aggregateStatus} ${report.network}`);
  console.log(`  chainId: ${report.chainId}`);
  console.log(`  repository: ${report.repositoryRevision}`);
  console.log(`  repositoryDirty: ${report.repositoryDirty}`);

  for (const observation of report.observations) {
    console.log(
      `  observation ${observation.id}: ` +
      `chainId=${observation.chainId} ` +
      `block=${observation.blockNumber}`,
    );
  }

  for (const check of report.checks) {
    console.log(`  ${check.status} ${check.id}`);

    if (check.status === 'DRIFT' || check.status === 'SKIPPED') {
      console.log(`    ${check.reason}`);
    }

    if (check.status === 'ERROR') {
      console.log(`    ${check.error}`);
    }
  }

  if (reportPath !== undefined) {
    console.log(`  report: ${reportPath}`);
  }
}

async function writeReport(
  path: string,
  report: VerificationReport,
): Promise<void> {
  const resolvedPath = resolve(REPOSITORY_ROOT, path);

  await mkdir(
    dirname(resolvedPath),
    {
      recursive: true,
    },
  );

  await writeFile(
    resolvedPath,
    serializeVerificationReport(report),
    'utf8',
  );
}

export async function runSecurityCheck(
  args: CliArguments,
): Promise<VerificationReport> {
  const profilePath = resolveProfilePath(args.network);

  // All normative local validation happens before RPC access.
  const loaded = await loadChainProfile(profilePath);
  if (loaded.profile.network !== args.network) {
    throw new Error(
      `Profile network mismatch: expected ${args.network}, ` +
      `found ${loaded.profile.network}.`,
    );
  }

  if (
    loaded.profile.chainAdapter.type === 'arbitrum-nitro' &&
    args.parentRpcUrl === undefined
  ) {
    throw new Error('--parent-rpc-url is required for arbitrum-nitro profiles.');
  }

  const repositoryBefore = await readRepositoryState();

  const verificationTime = new Date();

  const observations: VerificationObservation[] = [];
  const checks: VerificationCheck[] = [];

  try {
    const deployment = await checkDeployment({
      rpcUrl: args.rpcUrl,
      profile: loaded.profile,
      manifest: loaded.manifest,
    });

    observations.push(l2Observation(deployment));

    checks.push(
      ...deploymentChecksToReportChecks(deployment),
    );
  } catch (error) {
    checks.push(
      executionErrorCheck(
        'deployment.rpc-context',
        [],
        {
          chainId: loaded.profile.chainId,
        },
        error,
      ),
    );
  }

  if (loaded.profile.chainAdapter.type === 'arbitrum-nitro') {
    const config = loaded.profile.chainAdapter.config;

    const parentRpcUrl = args.parentRpcUrl;
    if (parentRpcUrl === undefined) {
      throw new Error(
        '--parent-rpc-url is required for arbitrum-nitro profiles.',
      );
    }

    const parentClient = createSecurityPublicClient(parentRpcUrl);

    let observedParentChainId: number;
    let parentSnapshot;

    try {
      observedParentChainId = await verifyRpcChainId(
        parentClient,
        config.parentChain.chainId,
      );

      parentSnapshot = await pinChainSnapshot(parentClient);

      observations.push(
        parentObservation(
          observedParentChainId,
          parentSnapshot.blockNumber,
          parentSnapshot.blockTimestamp,
        ),
      );
    } catch (error) {
      checks.push(
        executionErrorCheck(
          'arbitrum-nitro.parent-rpc-context',
          [],
          {
            chainId:
              config.parentChain.chainId,
          },
          error,
        ),
      );

      observedParentChainId = 0;
      parentSnapshot = undefined;
    }

    if (parentSnapshot !== undefined) {
      try {
        const timestampEnvelope =
          await checkTimestampEnvelopeAtSnapshot({
            client: parentClient,
            observedChainId: observedParentChainId,
            snapshot: parentSnapshot,
            config,
          });

        checks.push(
          ...timestampEnvelopeChecksToReportChecks(timestampEnvelope),
        );
      } catch (error) {
        checks.push(
          executionErrorCheck(
            'arbitrum-nitro.timestamp-envelope-execution',
            [
              'parent',
            ],
            {
              expectedSequencerInbox: config.expectedSequencerInbox,
              expectedMaxTimeVariation:
                timeVariationValue(config.expectedMaxTimeVariation),
            },
            error,
          ),
        );
      }

      try {
        const consensusRoot =
          await checkConsensusRootAtSnapshot({
            client: parentClient,
            observedChainId: observedParentChainId,
            snapshot: parentSnapshot,
            config,
          });

        checks.push(
          consensusRootCheckToReportCheck(consensusRoot),
        );
      } catch (error) {
        checks.push(
          executionErrorCheck(
            'arbitrum-nitro.consensus-root-execution',
            [
              'parent',
            ],
            approvedRootsValue(config.approvedWasmModuleRoots),
            error,
          ),
        );
      }
    }
  }

  const repositoryAfter = await readRepositoryState();

  if (repositoryBefore.revision !== repositoryAfter.revision) {
    throw new Error(
      'Repository revision changed during verification.',
    );
  }

  return createVerificationReport({
    network: loaded.profile.network,
    chainId: loaded.profile.chainId,
    verificationTime,
    repositoryRevision: repositoryBefore.revision,
    repositoryDirty: repositoryBefore.dirty || repositoryAfter.dirty,
    observations,
    checks,
  });
}

export async function main(
  argv: readonly string[] =
    process.argv.slice(2),
): Promise<number> {
  const args = parseArguments(argv);
  const report = await runSecurityCheck(args);

  if (args.reportPath !== undefined) {
    await writeReport(args.reportPath, report);
  }

  printReportSummary(report, args.reportPath);

  return aggregateExitCode(report);
}

async function runCli(): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`ERROR ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  void runCli();
}