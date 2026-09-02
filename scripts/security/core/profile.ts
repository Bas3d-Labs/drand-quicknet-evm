import {
  readFile,
} from 'node:fs/promises';

import {
  dirname,
  isAbsolute,
  resolve,
} from 'node:path';

import {
  parse as parseYaml,
} from 'yaml';

import {
  type ArbitrumNitroConfig,
  validateArbitrumNitroConfig,
} from '../adapters/arbitrum-nitro/profile.js';

import {
  type DeploymentManifest,
  loadDeploymentManifest,
} from './manifest.js';

import {
  assertOnlyKeys,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from './validation.js';

export type OnboardingTier =
  | 1
  | 2
  | 3;

export type TimestampAuthority =
  | 'sequencer'
  | 'parent-chain-consensus';

export type HistoryIntegrityAssumption =
  | 'trusted-sequencer'
  | 'parent-chain-precommitted';

export type ChainAdapterConfig =
  | {
      type: 'arbitrum-nitro';
      config: ArbitrumNitroConfig;
    };

export interface TimestampSkewMonitoring {
  warning: number;
  critical: number;
}

export interface ChainProfile {
  profileVersion: 1;
  network: string;
  chainId: number;
  onboardingTier: OnboardingTier;

  randomness: {
    beacon: 'drand-quicknet';
    periodSeconds: number;
  };

  timing: {
    minimumLeadRounds: number;
    timestampFreshnessReserveSeconds: number;
  };

  securityModel: {
    timestampAuthority: TimestampAuthority;
    historyIntegrityAssumption: HistoryIntegrityAssumption;
    assumptionsSection: string;
  };

  monitoring: {
    timestampSkewSeconds?: TimestampSkewMonitoring;
  };

  chainAdapter: ChainAdapterConfig;

  deploymentManifest: string;
}

export interface DerivedTiming {
  minimumChainClockLeadSeconds: number;
  timestampSkewViolationSeconds: number;
}

export interface ParsedChainProfile {
  profile: ChainProfile;
  markdownBody: string;
  anchors: ReadonlySet<string>;
  derivedTiming: DerivedTiming;
}

export interface LoadedChainProfile
  extends ParsedChainProfile {
  profilePath: string;
  manifestPath: string;
  manifest: DeploymentManifest;
}

interface ParsedMarkdown {
  frontMatter: unknown;
  body: string;
}

const TIMESTAMP_AUTHORITIES =
  new Set<TimestampAuthority>([
    'sequencer',
    'parent-chain-consensus',
  ]);

const HISTORY_INTEGRITY_ASSUMPTIONS =
  new Set<HistoryIntegrityAssumption>([
    'trusted-sequencer',
    'parent-chain-precommitted',
  ]);

function requireOnboardingTier(
  value: unknown,
): OnboardingTier {
  if (
    value === 1 ||
    value === 2 ||
    value === 3
  ) {
    return value;
  }

  throw new Error(
    'onboardingTier must be one of 1, 2, or 3.',
  );
}

function requireTimestampAuthority(
  value: unknown,
): TimestampAuthority {
  const authority = requireString(
    value,
    'securityModel.timestampAuthority',
  ) as TimestampAuthority;

  if (!TIMESTAMP_AUTHORITIES.has(authority)) {
    throw new Error(
      'securityModel.timestampAuthority must be one of: '
      + [...TIMESTAMP_AUTHORITIES].join(', ')
      + '.',
    );
  }

  return authority;
}

function requireHistoryIntegrityAssumption(
  value: unknown,
): HistoryIntegrityAssumption {
  const assumption = requireString(
    value,
    'securityModel.historyIntegrityAssumption',
  ) as HistoryIntegrityAssumption;

  if (!HISTORY_INTEGRITY_ASSUMPTIONS.has(assumption)) {
    throw new Error(
      'securityModel.historyIntegrityAssumption '
      + 'must be one of: '
      + [...HISTORY_INTEGRITY_ASSUMPTIONS].join(', ')
      + '.',
    );
  }

  return assumption;
}

function isAnchorCharacter(
  character: string,
): boolean {
  if (
    character >= 'a' &&
    character <= 'z'
  ) {
    return true;
  }

  if (
    character >= '0' &&
    character <= '9'
  ) {
    return true;
  }

  return character === '-';
}

function requireAnchorId(
  value: unknown,
  path: string,
): string {
  const anchor = requireString(value, path);
  for (const character of anchor) {
    if (!isAnchorCharacter(character)) {
      throw new Error(
        `${path} must contain only lowercase `
        + 'letters, digits, and hyphens.',
      );
    }
  }

  return anchor;
}

function requireRelativePath(
  value: unknown,
  path: string,
): string {
  const filePath = requireString(value, path);
  if (isAbsolute(filePath)) {
    throw new Error(
      `${path} must be a relative path.`,
    );
  }

  return filePath;
}

function parseMarkdown(
  markdown: string,
): ParsedMarkdown {
  const normalized = markdown.replaceAll(
    '\r\n',
    '\n',
  );

  if (!normalized.startsWith('---\n')) {
    throw new Error(
      'profile must begin with YAML front matter.',
    );
  }

  const end = normalized.indexOf(
    '\n---\n',
    4,
  );

  if (end === -1) {
    throw new Error(
      'profile YAML front matter is not terminated.',
    );
  }

  const yaml = normalized.slice(
    4,
    end,
  );

  let frontMatter: unknown;

  try {
    frontMatter = parseYaml(yaml);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        'profile contains invalid YAML: '
        + error.message,
      );
    }

    throw error;
  }

  return {
    frontMatter,
    body: normalized.slice(end + 5),
  };
}

function stripInlineCode(
  line: string,
): string {
  let output = '';
  let index = 0;

  while (index < line.length) {
    if (line[index] !== '`') {
      output += line[index];
      index += 1;
      continue;
    }

    let delimiterEnd = index;

    while (
      delimiterEnd < line.length &&
      line[delimiterEnd] === '`'
    ) {
      delimiterEnd += 1;
    }

    const delimiter = line.slice(
      index,
      delimiterEnd,
    );

    const closingIndex = line.indexOf(
      delimiter,
      delimiterEnd,
    );

    if (closingIndex === -1) {
      output += delimiter;
      index = delimiterEnd;
      continue;
    }

    const removedLength =
      closingIndex + delimiter.length - index;

    output += ' '.repeat(
      removedLength,
    );

    index = closingIndex + delimiter.length;
  }

  return output;
}

function fencePrefixLength(
  line: string,
  character: '`' | '~',
): number {
  let length = 0;

  while (
    length < line.length &&
    line[length] === character
  ) {
    length += 1;
  }

  return length;
}

function isWhitespaceOnly(
  value: string,
): boolean {
  for (const character of value) {
    if (
      character !== ' ' &&
      character !== '\t'
    ) {
      return false;
    }
  }

  return true;
}

function isClosingFence(
  line: string,
  character: '`' | '~',
  minimumLength: number,
): boolean {
  const length = fencePrefixLength(
    line,
    character,
  );

  if (length < minimumLength) {
    return false;
  }

  return isWhitespaceOnly(
    line.slice(length),
  );
}

function stripMarkdownCode(
  body: string,
): string {
  const output: string[] = [];

  let fenceCharacter:
    | '`'
    | '~'
    | undefined;

  let fenceLength = 0;

  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();

    if (fenceCharacter !== undefined) {
      if (
        isClosingFence(
          trimmed,
          fenceCharacter,
          fenceLength,
        )
      ) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }

      output.push('');
      continue;
    }

    const backtickLength =
      fencePrefixLength(
        trimmed,
        '`',
      );

    if (backtickLength >= 3) {
      fenceCharacter = '`';
      fenceLength = backtickLength;
      output.push('');
      continue;
    }

    const tildeLength =
      fencePrefixLength(
        trimmed,
        '~',
      );

    if (tildeLength >= 3) {
      fenceCharacter = '~';
      fenceLength = tildeLength;
      output.push('');
      continue;
    }

    output.push(
      stripInlineCode(line),
    );
  }

  return output.join('\n');
}

function findExplicitAnchorIds(
  body: string,
): string[] {
  const anchors: string[] = [];
  const searchableBody = stripMarkdownCode(body);
  const prefix = '<a id="';
  const suffix = '"></a>';

  let searchIndex = 0;

  while (searchIndex < searchableBody.length) {
    const start = searchableBody.indexOf(
      prefix,
      searchIndex,
    );

    if (start === -1) {
      break;
    }

    const idStart = start + prefix.length;

    const end = searchableBody.indexOf(
      suffix,
      idStart,
    );

    if (end === -1) {
      searchIndex = idStart;
      continue;
    }

    const anchor =
      searchableBody.slice(
        idStart,
        end,
      );

    anchors.push(anchor);

    searchIndex = end + suffix.length;
  }

  return anchors;
}

function collectExplicitAnchors(
  body: string,
): ReadonlySet<string> {
  const anchors = new Set<string>();

  for (
    const anchor of findExplicitAnchorIds(body)
  ) {
    if (anchor.length === 0) {
      throw new Error(
        'explicit profile anchor ID cannot be empty.',
      );
    }

    for (const character of anchor) {
      if (!isAnchorCharacter(character)) {
        throw new Error(
          `invalid explicit profile anchor: ${anchor}`,
        );
      }
    }

    if (anchors.has(anchor)) {
      throw new Error(
        `duplicate explicit profile anchor: ${anchor}`,
      );
    }

    anchors.add(anchor);
  }

  return anchors;
}

function validateTimestampSkewMonitoring(
  value: unknown,
): TimestampSkewMonitoring {
  const path = 'monitoring.timestampSkewSeconds';
  const monitoring = requireRecord(value, path);

  assertOnlyKeys(
    monitoring,
    [
      'warning',
      'critical',
    ],
    path,
  );

  return {
    warning: requireNonNegativeInteger(
      monitoring.warning,
      `${path}.warning`,
    ),
    critical: requireNonNegativeInteger(
      monitoring.critical,
      `${path}.critical`,
    ),
  };
}

function toSafeInteger(
  value: bigint,
  path: string,
): number {
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);

  if (
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${path} exceeds the safe integer range.`,
    );
  }

  return Number(value);
}

export function deriveTiming(
  profile: Pick<
    ChainProfile,
    'randomness' | 'timing'
  >,
): DerivedTiming {
  const periodSeconds = BigInt(
    profile.randomness.periodSeconds,
  );

  const minimumLeadRounds = BigInt(
    profile.timing.minimumLeadRounds,
  );

  const reserveSeconds = BigInt(
    profile.timing.timestampFreshnessReserveSeconds,
  );

  const minimumChainClockLeadSeconds =
    periodSeconds * minimumLeadRounds
    - (periodSeconds - 1n);

  const timestampSkewViolationSeconds =
    minimumChainClockLeadSeconds
    - reserveSeconds;

  return {
    minimumChainClockLeadSeconds: toSafeInteger(
      minimumChainClockLeadSeconds,
      'minimumChainClockLeadSeconds',
    ),

    timestampSkewViolationSeconds: toSafeInteger(
      timestampSkewViolationSeconds,
      'timestampSkewViolationSeconds',
    ),
  };
}

function validateSecurityModelRelationships(
  profile: ChainProfile,
): void {
  const authority = profile.securityModel.timestampAuthority;
  const history = profile.securityModel.historyIntegrityAssumption;

  if (
    authority === 'sequencer' &&
    history !== 'trusted-sequencer'
  ) {
    throw new Error(
      'securityModel.historyIntegrityAssumption '
      + 'must be trusted-sequencer when '
      + 'timestampAuthority is sequencer.',
    );
  }

  if (
    authority === 'parent-chain-consensus' &&
    history !== 'parent-chain-precommitted'
  ) {
    throw new Error(
      'securityModel.historyIntegrityAssumption '
      + 'must be parent-chain-precommitted when '
      + 'timestampAuthority is parent-chain-consensus.',
    );
  }
}

function validateGenericRelationships(
  profile: ChainProfile,
  anchors: ReadonlySet<string>,
): DerivedTiming {

  validateSecurityModelRelationships(profile);

  const assumptionsSection = profile.securityModel.assumptionsSection;

  if (!anchors.has(assumptionsSection)) {
    throw new Error(
      'securityModel.assumptionsSection '
      + 'does not resolve: '
      + assumptionsSection,
    );
  }

  const derivedTiming = deriveTiming(profile);
  if (
    derivedTiming.timestampSkewViolationSeconds <= 0
  ) {
    throw new Error(
      'timing.timestampFreshnessReserveSeconds '
      + 'must be smaller than the minimum '
      + 'chain-clock lead.',
    );
  }

  const skew = profile.monitoring.timestampSkewSeconds;
  if (
    profile.securityModel.timestampAuthority === 'sequencer' &&
    skew === undefined
  ) {
    throw new Error(
      'monitoring.timestampSkewSeconds is required '
      + 'when timestampAuthority is sequencer.',
    );
  }

  if (skew !== undefined) {
    if (skew.warning >= skew.critical) {
      throw new Error(
        'timestamp skew warning must be below critical.',
      );
    }

    if (
      skew.critical >=
      derivedTiming.timestampSkewViolationSeconds
    ) {
      throw new Error(
        'timestamp skew critical must be below '
        + 'derived violation threshold '
        + `(${derivedTiming.timestampSkewViolationSeconds}s).`,
      );
    }
  }

  return derivedTiming;
}

function validateChainAdapter(
  value: unknown,
): ChainAdapterConfig {
  const path = 'chainAdapter';

  const chainAdapter = requireRecord(value, path);

  assertOnlyKeys(
    chainAdapter,
    [
      'type',
      'config',
    ],
    path,
  );

  if (chainAdapter.type === 'arbitrum-nitro') {
    return {
      type: 'arbitrum-nitro',
      config: validateArbitrumNitroConfig(
        chainAdapter.config,
      ),
    };
  }

  throw new Error(
    `unsupported chainAdapter.type: ${String(chainAdapter.type)}.`,
  );
}

function validateFrontMatter(
  value: unknown,
  anchors: ReadonlySet<string>,
): {
  profile: ChainProfile;
  derivedTiming: DerivedTiming;
} {
  const root = requireRecord(value, 'profile');

  assertOnlyKeys(
    root,
    [
      'profileVersion',
      'network',
      'chainId',
      'onboardingTier',
      'randomness',
      'timing',
      'securityModel',
      'monitoring',
      'chainAdapter',
      'deploymentManifest',
    ],
    'profile',
  );

  if (root.profileVersion !== 1) {
    throw new Error(
      'profileVersion must be 1.',
    );
  }

  const randomness = requireRecord(
    root.randomness,
    'randomness',
  );

  assertOnlyKeys(
    randomness,
    [
      'beacon',
      'periodSeconds',
    ],
    'randomness',
  );

  if (randomness.beacon !== 'drand-quicknet') {
    throw new Error(
      'randomness.beacon must be drand-quicknet.',
    );
  }

  const timing = requireRecord(
    root.timing,
    'timing',
  );

  assertOnlyKeys(
    timing,
    [
      'minimumLeadRounds',
      'timestampFreshnessReserveSeconds',
    ],
    'timing',
  );

  const securityModel = requireRecord(
    root.securityModel,
    'securityModel',
  );

  assertOnlyKeys(
    securityModel,
    [
      'timestampAuthority',
      'historyIntegrityAssumption',
      'assumptionsSection',
    ],
    'securityModel',
  );

  const monitoring = requireRecord(
    root.monitoring,
    'monitoring',
  );

  assertOnlyKeys(
    monitoring,
    [
      'timestampSkewSeconds',
    ],
    'monitoring',
  );

  const validatedMonitoring: ChainProfile['monitoring'] = {};
  if (
    monitoring.timestampSkewSeconds !== undefined
  ) {
    validatedMonitoring.timestampSkewSeconds =
      validateTimestampSkewMonitoring(
        monitoring.timestampSkewSeconds,
      );
  }

  const profile: ChainProfile = {
    profileVersion: 1,

    network: requireString(
      root.network,
      'network',
    ),

    chainId: requirePositiveInteger(
      root.chainId,
      'chainId',
    ),

    onboardingTier: requireOnboardingTier(
      root.onboardingTier,
    ),

    randomness: {
      beacon: 'drand-quicknet',

      periodSeconds: requirePositiveInteger(
        randomness.periodSeconds,
        'randomness.periodSeconds',
      ),
    },

    timing: {
      minimumLeadRounds: requirePositiveInteger(
        timing.minimumLeadRounds,
        'timing.minimumLeadRounds',
      ),

      timestampFreshnessReserveSeconds: requireNonNegativeInteger(
        timing.timestampFreshnessReserveSeconds,
        'timing.timestampFreshnessReserveSeconds',
      ),
    },

    securityModel: {
      timestampAuthority: requireTimestampAuthority(
        securityModel.timestampAuthority,
      ),

      historyIntegrityAssumption: requireHistoryIntegrityAssumption(
        securityModel.historyIntegrityAssumption,
      ),

      assumptionsSection: requireAnchorId(
        securityModel.assumptionsSection,
        'securityModel.assumptionsSection',
      ),
    },

    monitoring: validatedMonitoring,

    chainAdapter: validateChainAdapter(
      root.chainAdapter,
    ),

    deploymentManifest: requireRelativePath(
      root.deploymentManifest,
      'deploymentManifest',
    ),
  };

  const derivedTiming = validateGenericRelationships(
    profile,
    anchors,
  );

  return {
    profile,
    derivedTiming,
  };
}

export function parseChainProfileMarkdown(
  markdown: string,
): ParsedChainProfile {
  const parsed = parseMarkdown(
    markdown,
  );

  const anchors = collectExplicitAnchors(
    parsed.body,
  );

  const validated = validateFrontMatter(
    parsed.frontMatter,
    anchors,
  );

  return {
    profile: validated.profile,
    markdownBody: parsed.body,
    anchors,
    derivedTiming:
      validated.derivedTiming,
  };
}

export async function loadChainProfile(
  profilePath: string,
): Promise<LoadedChainProfile> {
  const absoluteProfilePath = resolve(profilePath);
  const markdown = await readFile(
    absoluteProfilePath,
    'utf8',
  );

  const parsed = parseChainProfileMarkdown(
    markdown,
  );

  const manifestPath = resolve(
    dirname(absoluteProfilePath),
    parsed.profile.deploymentManifest,
  );

  const manifest = await loadDeploymentManifest(
    manifestPath,
  );

  if (
    manifest.network !== parsed.profile.network
  ) {
    throw new Error(
      'deployment manifest network mismatch: '
      + `profile=${parsed.profile.network} `
      + `manifest=${manifest.network}.`,
    );
  }

  if (
    manifest.chainId !== parsed.profile.chainId
  ) {
    throw new Error(
      'deployment manifest chainId mismatch: '
      + `profile=${parsed.profile.chainId} `
      + `manifest=${manifest.chainId}.`,
    );
  }

  return {
    profilePath: absoluteProfilePath,
    profile: parsed.profile,
    manifestPath,
    manifest,
    markdownBody: parsed.markdownBody,
    anchors: parsed.anchors,
    derivedTiming: parsed.derivedTiming,
  };
}