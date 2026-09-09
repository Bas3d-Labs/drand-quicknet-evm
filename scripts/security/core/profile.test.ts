import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
  resolve,
} from 'node:path';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  loadChainProfile,
  parseChainProfileYaml,
  parseProfileDocumentation,
} from './profile.js';

const NETWORK = 'example-network';
const CHAIN_ID = 12345;

const ROLLUP =
  '0x1234567890abcdef1234567890abcdef12345678';

const SEQUENCER_INBOX =
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const REGISTRY =
  '0x1111111111111111111111111111111111111111';

const VERIFIER =
  '0x2222222222222222222222222222222222222222';

const REGISTRY_CODEHASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_CODEHASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  + 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const REGISTRY_DEPLOYMENT_TX =
  '0xcccccccccccccccccccccccccccccccc'
  + 'cccccccccccccccccccccccccccccccc';

const VERIFIER_DEPLOYMENT_TX =
  '0xdddddddddddddddddddddddddddddddd'
  + 'dddddddddddddddddddddddddddddddd';

const WASM_ROOT =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  + 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const temporaryDirectories: string[] = [];

interface ProfileFixtureOptions {
  profileVersion?: number;
  network?: string;
  chainId?: number;
  onboardingTier?: number;
  documentation?: string;
  timestampAuthority?: string;
  historyIntegrityAssumption?: string;
  assumptionsSection?: string;
  monitoring?: string;
  minimumLeadRounds?: number;
  timestampFreshnessReserveSeconds?: number;
  deploymentManifest?: string;
  adapterType?: string;
  extraRoot?: string;
  extraRandomness?: string;
}

interface ManifestFixtureOptions {
  network?: string;
  chainId?: number;
}

interface FileFixtureOptions {
  profile?: ProfileFixtureOptions;
  documentation?: string;
  manifest?: ManifestFixtureOptions;
  documentationMode?:
    | 'file'
    | 'missing'
    | 'directory';
  manifestMode?:
    | 'file'
    | 'missing'
    | 'directory'
    | 'malformed-json';
}

interface FileFixture {
  root: string;
  profilePath: string;
  documentationPath: string;
  manifestPath: string;
}

function profileYamlFixture(
  options: ProfileFixtureOptions = {},
): string {
  const profileVersion =
    options.profileVersion ?? 1;

  const network =
    options.network ?? NETWORK;

  const chainId =
    options.chainId ?? CHAIN_ID;

  const onboardingTier =
    options.onboardingTier ?? 1;

  const documentation =
    options.documentation
    ?? './example-network.md';

  const timestampAuthority =
    options.timestampAuthority
    ?? 'sequencer';

  const historyIntegrityAssumption =
    options.historyIntegrityAssumption
    ?? 'trusted-sequencer';

  const assumptionsSection =
    options.assumptionsSection
    ?? 'security-assumptions';

  const monitoring =
    options.monitoring
    ?? `monitoring:
  timestampSkewSeconds:
    warning: 5
    critical: 8`;

  const minimumLeadRounds =
    options.minimumLeadRounds ?? 5;

  const timestampFreshnessReserveSeconds =
    options.timestampFreshnessReserveSeconds ?? 3;

  const deploymentManifest =
    options.deploymentManifest
    ?? '../../../deployments/example-network.json';

  const adapterType =
    options.adapterType ?? 'arbitrum-nitro';

  const extraRoot =
    options.extraRoot ?? '';

  const extraRandomness =
    options.extraRandomness ?? '';

  return `profileVersion: ${profileVersion}

network: ${network}
chainId: ${chainId}
onboardingTier: ${onboardingTier}

documentation: '${documentation}'

${extraRoot}randomness:
  beacon: drand-quicknet
  periodSeconds: 3
${extraRandomness}
timing:
  minimumLeadRounds: ${minimumLeadRounds}
  timestampFreshnessReserveSeconds: ${timestampFreshnessReserveSeconds}

securityModel:
  timestampAuthority: ${timestampAuthority}
  historyIntegrityAssumption: ${historyIntegrityAssumption}
  assumptionsSection: ${assumptionsSection}

${monitoring}

chainAdapter:
  type: ${adapterType}
  config:
    parentChain:
      name: example-parent
      chainId: 54321
      slotSeconds: 12
      requireTimeVariationSlotParity: true

    rollup: '${ROLLUP}'
    expectedSequencerInbox: '${SEQUENCER_INBOX}'

    expectedMaxTimeVariation:
      delayBlocks: 100
      futureBlocks: 10
      delaySeconds: 1200
      futureSeconds: 120

    approvedWasmModuleRoots:
      - consensusRelease: example-release
        root: '${WASM_ROOT}'

deploymentManifest: '${deploymentManifest}'
`;
}

function documentationFixture(): string {
  return `# Example Network Security Profile

<a id="security-assumptions"></a>
## Security assumptions

Example security assumptions.
`;
}

function manifestFixture(
  options: ManifestFixtureOptions = {},
) {
  return {
    manifestVersion: 1,
    network: options.network ?? NETWORK,
    chainId: options.chainId ?? CHAIN_ID,

    registry: {
      address: REGISTRY,
      runtimeCodehash: REGISTRY_CODEHASH,
      deployment: {
        transactionHash: REGISTRY_DEPLOYMENT_TX,
        blockNumber: 900,
      },
    },

    verifier: {
      address: VERIFIER,
      runtimeCodehash: VERIFIER_CODEHASH,
      deployment: {
        transactionHash: VERIFIER_DEPLOYMENT_TX,
        blockNumber: 800,
      },
    },
  };
}

function parsedProfile(
  options: ProfileFixtureOptions = {},
) {
  return parseChainProfileYaml(
    profileYamlFixture(options),
  ).profile;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'drand-quicknet-profile-'),
  );

  temporaryDirectories.push(directory);

  return directory;
}

async function writeFileFixture(
  options: FileFixtureOptions = {},
): Promise<FileFixture> {
  const root =
    await createTemporaryDirectory();

  const profileDirectory = join(
    root,
    'docs',
    'security',
    'chain-profiles',
  );

  const deploymentDirectory = join(
    root,
    'deployments',
  );

  await mkdir(
    profileDirectory,
    {
      recursive: true,
    },
  );

  await mkdir(
    deploymentDirectory,
    {
      recursive: true,
    },
  );

  const profilePath = join(
    profileDirectory,
    'example-network.yaml',
  );

  const documentationPath = join(
    profileDirectory,
    'example-network.md',
  );

  const manifestPath = join(
    deploymentDirectory,
    'example-network.json',
  );

  await writeFile(
    profilePath,
    profileYamlFixture(
      options.profile,
    ),
    'utf8',
  );

  const documentationMode =
    options.documentationMode ?? 'file';

  if (documentationMode === 'file') {
    await writeFile(
      documentationPath,
      options.documentation
      ?? documentationFixture(),
      'utf8',
    );
  } else if (documentationMode === 'directory') {
    await mkdir(
      documentationPath,
      {
        recursive: true,
      },
    );
  }

  const manifestMode =
    options.manifestMode ?? 'file';

  if (manifestMode === 'file') {
    await writeFile(
      manifestPath,
      JSON.stringify(
        manifestFixture(
          options.manifest,
        ),
        null,
        2,
      ),
      'utf8',
    );
  } else if (manifestMode === 'directory') {
    await mkdir(
      manifestPath,
      {
        recursive: true,
      },
    );
  } else if (
    manifestMode === 'malformed-json'
  ) {
    await writeFile(
      manifestPath,
      '{"manifestVersion":',
      'utf8',
    );
  }

  return {
    root,
    profilePath,
    documentationPath,
    manifestPath,
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      },
    );
  }

  temporaryDirectories.length = 0;
});

describe('parseChainProfileYaml', () => {
  it('accepts a valid chain profile', () => {
    expect(
      () => parseChainProfileYaml(
        profileYamlFixture(),
      ),
    ).not.toThrow();
  });

  it('returns the validated profile', () => {
    const parsed =
      parseChainProfileYaml(
        profileYamlFixture(),
      );

    expect(parsed.profile.network).toBe(
      NETWORK,
    );

    expect(parsed.profile.chainId).toBe(
      CHAIN_ID,
    );

    expect(
      parsed.profile.onboardingTier,
    ).toBe(1);

    expect(
      parsed.profile.documentation,
    ).toBe('./example-network.md');

    expect(
      parsed.profile.deploymentManifest,
    ).toBe(
      '../../../deployments/example-network.json',
    );

    expect(
      parsed.profile.chainAdapter.type,
    ).toBe('arbitrum-nitro');
  });

  it('derives the minimum chain-clock lead', () => {
    const parsed =
      parseChainProfileYaml(
        profileYamlFixture(),
      );

    expect(
      parsed.derivedTiming
        .minimumChainClockLeadSeconds,
    ).toBe(13);
  });

  it('derives the timestamp-skew violation boundary', () => {
    const parsed =
      parseChainProfileYaml(
        profileYamlFixture(),
      );

    expect(
      parsed.derivedTiming
        .timestampSkewViolationSeconds,
    ).toBe(10);
  });

  it('rejects invalid YAML', () => {
    expect(
      () => parseChainProfileYaml(
        'profileVersion: [',
      ),
    ).toThrow(
      'profile contains invalid YAML:'
    );
  });

  it('rejects an unsupported profile version', () => {
    const yaml = profileYamlFixture({
      profileVersion: 2,
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'profileVersion must be 1.'
    );
  });

  it('rejects an unknown root key', () => {
    const yaml = profileYamlFixture({
      extraRoot: 'unexpected: true\n\n',
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'profile.unexpected is not supported.'
    );
  });

  it('rejects the freshness reserve under randomness', () => {
    const yaml = profileYamlFixture({
      extraRandomness:
        '  timestampFreshnessReserveSeconds: 3\n',
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'randomness.timestampFreshnessReserveSeconds '
      + 'is not supported.'
    );
  });

  it('rejects an unsupported onboarding tier', () => {
    const yaml = profileYamlFixture({
      onboardingTier: 4,
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'onboardingTier must be one of 1, 2, or 3.'
    );
  });

  it('rejects an unsupported chain adapter', () => {
    const yaml = profileYamlFixture({
      adapterType: 'example-adapter',
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'unsupported chainAdapter.type: example-adapter.'
    );
  });

  it('rejects an absolute documentation path', () => {
    const yaml = profileYamlFixture({
      documentation: resolve(
        'example-network.md',
      ),
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'documentation must be a relative path.'
    );
  });

  it('rejects an absolute deployment manifest path', () => {
    const yaml = profileYamlFixture({
      deploymentManifest: resolve(
        'example-network.json',
      ),
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'deploymentManifest must be a relative path.'
    );
  });

  it('requires skew monitoring for sequencer timestamp authority', () => {
    const yaml = profileYamlFixture({
      monitoring: 'monitoring: {}',
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'monitoring.timestampSkewSeconds is required '
      + 'when timestampAuthority is sequencer.'
    );
  });

  it('accepts the parent-chain security model without skew monitoring', () => {
    const yaml = profileYamlFixture({
      timestampAuthority:
        'parent-chain-consensus',
      historyIntegrityAssumption:
        'parent-chain-precommitted',
      monitoring: 'monitoring: {}',
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).not.toThrow();
  });

  it('rejects parent-chain precommitment with sequencer timestamps', () => {
    const yaml = profileYamlFixture({
      timestampAuthority: 'sequencer',
      historyIntegrityAssumption:
        'parent-chain-precommitted',
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'securityModel.historyIntegrityAssumption '
      + 'must be trusted-sequencer when '
      + 'timestampAuthority is sequencer.'
    );
  });

  it('rejects trusted sequencer history with parent-chain timestamps', () => {
    const yaml = profileYamlFixture({
      timestampAuthority:
        'parent-chain-consensus',
      historyIntegrityAssumption:
        'trusted-sequencer',
      monitoring: 'monitoring: {}',
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'securityModel.historyIntegrityAssumption '
      + 'must be parent-chain-precommitted when '
      + 'timestampAuthority is parent-chain-consensus.'
    );
  });

  it('rejects timestamp skew warning at or above critical', () => {
    const yaml = profileYamlFixture({
      monitoring: `monitoring:
  timestampSkewSeconds:
    warning: 8
    critical: 8`,
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'timestamp skew warning must be below critical.'
    );
  });

  it('rejects critical skew at the derived violation boundary', () => {
    const yaml = profileYamlFixture({
      monitoring: `monitoring:
  timestampSkewSeconds:
    warning: 5
    critical: 10`,
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'timestamp skew critical must be below '
      + 'derived violation threshold (10s).'
    );
  });

  it('rejects a freshness reserve that consumes the entire lead', () => {
    const yaml = profileYamlFixture({
      timestampFreshnessReserveSeconds: 13,
    });

    expect(
      () => parseChainProfileYaml(yaml),
    ).toThrow(
      'timing.timestampFreshnessReserveSeconds '
      + 'must be smaller than the minimum '
      + 'chain-clock lead.'
    );
  });
});

describe('parseProfileDocumentation', () => {
  it('accepts documentation containing the assumptions anchor', () => {
    const profile = parsedProfile();

    expect(
      () => parseProfileDocumentation(
        profile,
        documentationFixture(),
      ),
    ).not.toThrow();
  });

  it('returns the documentation and explicit anchors', () => {
    const profile = parsedProfile();

    const parsed =
      parseProfileDocumentation(
        profile,
        documentationFixture(),
      );

    expect(
      parsed.markdownBody,
    ).toContain(
      '# Example Network Security Profile',
    );

    expect(
      parsed.anchors.has(
        'security-assumptions',
      ),
    ).toBe(true);
  });

  it('normalizes CRLF line endings', () => {
    const profile = parsedProfile();

    const markdown = documentationFixture()
      .replaceAll(
        '\n',
        '\r\n',
      );

    const parsed =
      parseProfileDocumentation(
        profile,
        markdown,
      );

    expect(
      parsed.markdownBody.includes('\r\n'),
    ).toBe(false);
  });

  it('rejects a dangling assumptions section', () => {
    const profile = parsedProfile({
      assumptionsSection:
        'missing-assumptions',
    });

    expect(
      () => parseProfileDocumentation(
        profile,
        documentationFixture(),
      ),
    ).toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: missing-assumptions'
    );
  });

  it('rejects duplicate explicit anchors', () => {
    const profile = parsedProfile();

    const markdown = `# Example

<a id="security-assumptions"></a>

<a id="security-assumptions"></a>
`;

    expect(
      () => parseProfileDocumentation(
        profile,
        markdown,
      ),
    ).toThrow(
      'duplicate explicit profile anchor: '
      + 'security-assumptions'
    );
  });

  it('rejects invalid explicit anchor IDs', () => {
    const profile = parsedProfile();

    const markdown =
      '<a id="Security-Assumptions"></a>';

    expect(
      () => parseProfileDocumentation(
        profile,
        markdown,
      ),
    ).toThrow(
      'invalid explicit profile anchor: '
      + 'Security-Assumptions'
    );
  });

  it('does not resolve an anchor inside a fenced code block', () => {
    const profile = parsedProfile();
    const fence = '```';

    const markdown = `# Example

${fence}html
<a id="security-assumptions"></a>
${fence}
`;

    expect(
      () => parseProfileDocumentation(
        profile,
        markdown,
      ),
    ).toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: security-assumptions'
    );
  });

  it('does not resolve an anchor inside a tilde-fenced code block', () => {
    const profile = parsedProfile();
    const fence = '~~~';

    const markdown = `# Example

${fence}html
<a id="security-assumptions"></a>
${fence}
`;

    expect(
      () => parseProfileDocumentation(
        profile,
        markdown,
      ),
    ).toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: security-assumptions'
    );
  });

  it('does not treat a fenced anchor as a duplicate', () => {
    const profile = parsedProfile();
    const fence = '```';

    const markdown = `# Example

<a id="security-assumptions"></a>

${fence}html
<a id="security-assumptions"></a>
${fence}
`;

    expect(
      () => parseProfileDocumentation(
        profile,
        markdown,
      ),
    ).not.toThrow();
  });

  it('does not resolve an anchor inside inline code', () => {
    const profile = parsedProfile();

    const markdown =
      '`<a id="security-assumptions"></a>`';

    expect(
      () => parseProfileDocumentation(
        profile,
        markdown,
      ),
    ).toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: security-assumptions'
    );
  });
});

describe('loadChainProfile', () => {
  it('loads the profile, documentation, and deployment manifest', async () => {
    const fixture =
      await writeFileFixture();

    const loaded =
      await loadChainProfile(
        fixture.profilePath,
      );

    expect(loaded.profilePath).toBe(
      resolve(fixture.profilePath),
    );

    expect(
      loaded.documentationPath,
    ).toBe(
      resolve(fixture.documentationPath),
    );

    expect(loaded.manifestPath).toBe(
      resolve(fixture.manifestPath),
    );

    expect(loaded.profile.network).toBe(
      NETWORK,
    );

    expect(loaded.profile.chainId).toBe(
      CHAIN_ID,
    );

    expect(loaded.manifest.network).toBe(
      NETWORK,
    );

    expect(loaded.manifest.chainId).toBe(
      CHAIN_ID,
    );

    expect(
      loaded.anchors.has(
        'security-assumptions',
      ),
    ).toBe(true);

    expect(
      loaded.derivedTiming
        .minimumChainClockLeadSeconds,
    ).toBe(13);

    expect(
      loaded.derivedTiming
        .timestampSkewViolationSeconds,
    ).toBe(10);
  });

  it('rejects missing documentation', async () => {
    const fixture =
      await writeFileFixture({
        documentationMode: 'missing',
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      `documentation does not exist: ${fixture.documentationPath}`
    );
  });

  it('rejects a documentation path that is not a file', async () => {
    const fixture =
      await writeFileFixture({
        documentationMode: 'directory',
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      `documentation is not a file: ${fixture.documentationPath}`
    );
  });

  it('rejects documentation without the required assumptions anchor', async () => {
    const fixture =
      await writeFileFixture({
        documentation: `# Example

No explicit assumptions anchor.
`,
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: security-assumptions'
    );
  });

  it('rejects a missing deployment manifest', async () => {
    const fixture =
      await writeFileFixture({
        manifestMode: 'missing',
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      `deploymentManifest does not exist: ${fixture.manifestPath}`
    );
  });

  it('rejects a deployment manifest path that is not a file', async () => {
    const fixture =
      await writeFileFixture({
        manifestMode: 'directory',
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      `deploymentManifest is not a file: ${fixture.manifestPath}`
    );
  });

  it('rejects malformed deployment manifest JSON', async () => {
    const fixture =
      await writeFileFixture({
        manifestMode: 'malformed-json',
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      'deploymentManifest contains invalid JSON: '
      + fixture.manifestPath
    );
  });

  it('rejects a deployment manifest with an unknown key', async () => {
    const fixture =
      await writeFileFixture();

    const invalidManifest = {
      ...manifestFixture(),
      unexpected: true,
    };

    await writeFile(
      fixture.manifestPath,
      JSON.stringify(
        invalidManifest,
        null,
        2,
      ),
      'utf8',
    );

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      'manifest.unexpected is not supported.'
    );
  });

  it('rejects a deployment manifest network mismatch', async () => {
    const fixture =
      await writeFileFixture({
        manifest: {
          network: 'different-network',
        },
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      'deployment manifest network mismatch: '
      + `profile=${NETWORK} `
      + 'manifest=different-network.'
    );
  });

  it('rejects a deployment manifest chain ID mismatch', async () => {
    const fixture =
      await writeFileFixture({
        manifest: {
          chainId: CHAIN_ID + 1,
        },
      });

    await expect(
      loadChainProfile(
        fixture.profilePath,
      ),
    ).rejects.toThrow(
      'deployment manifest chainId mismatch: '
      + `profile=${CHAIN_ID} `
      + `manifest=${CHAIN_ID + 1}.`
    );
  });
});