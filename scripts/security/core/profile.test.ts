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
  parseChainProfileMarkdown,
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
  timestampFreshnessReserveSeconds?: number;
  timestampAuthority?: string;
  historyIntegrityAssumption?: string;
  assumptionsSection?: string;
  monitoring?: string;
  deploymentManifest?: string;
  adapterType?: string;
  extraRoot?: string;
  extraRandomness?: string;
  body?: string;
}

interface ManifestFixtureOptions {
  network?: string;
  chainId?: number;
}

interface FileFixtureOptions {
  profile?: ProfileFixtureOptions;
  manifest?: ManifestFixtureOptions;
  manifestMode?: 'file' | 'missing' | 'directory' | 'malformed-json';
}

interface FileFixture {
  root: string;
  profilePath: string;
  manifestPath: string;
}

function defaultProfileBody(): string {
  return `<a id="security-assumptions"></a>

## Security assumptions

Example assumptions.
`;
}

function profileFixture(
  options: ProfileFixtureOptions = {},
): string {
  const profileVersion = options.profileVersion ?? 1;

  const network = options.network ?? NETWORK;
  const chainId = options.chainId ?? CHAIN_ID;

  const onboardingTier = options.onboardingTier ?? 2;

  const timestampFreshnessReserveSeconds =
    options.timestampFreshnessReserveSeconds ?? 3;

  const timestampAuthority = options.timestampAuthority ?? 'sequencer';

  const historyIntegrityAssumption =
    options.historyIntegrityAssumption ?? 'trusted-sequencer';

  const assumptionsSection =
    options.assumptionsSection ?? 'security-assumptions';

  const monitoring =
    options.monitoring
    ?? `monitoring:
  timestampSkewSeconds:
    warning: 5
    critical: 8`;

  const deploymentManifest =
    options.deploymentManifest
    ?? '../../../deployments/example-network.json';

  const adapterType = options.adapterType ?? 'arbitrum-nitro';

  const extraRoot =  options.extraRoot ?? '';

  const extraRandomness =  options.extraRandomness ?? '';

  const body = options.body ?? defaultProfileBody();

  return `---
profileVersion: ${profileVersion}
network: ${network}
chainId: ${chainId}
onboardingTier: ${onboardingTier}
${extraRoot}
randomness:
  beacon: drand-quicknet
  periodSeconds: 3
${extraRandomness}
timing:
  minimumLeadRounds: 5
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
---

# Example Network

${body}`;
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
  const root = await createTemporaryDirectory();

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
    'example-network.md',
  );

  const manifestPath = join(
    deploymentDirectory,
    'example-network.json',
  );

  await writeFile(
    profilePath,
    profileFixture(options.profile),
    'utf8',
  );

  const manifestMode =
    options.manifestMode ?? 'file';

  if (manifestMode === 'directory') {
    await mkdir(
      manifestPath,
      {
        recursive: true,
      },
    );
  } else if (manifestMode === 'malformed-json') {
    await writeFile(
      manifestPath,
      '{"manifestVersion":',
      'utf8',
    );
  } else if (manifestMode === 'file') {
    await writeFile(
      manifestPath,
      JSON.stringify(
        manifestFixture(options.manifest),
        null,
        2,
      ),
      'utf8',
    );
  }

  return {
    root,
    profilePath,
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

describe('parseChainProfileMarkdown', () => {
  it('accepts a valid chain profile', () => {
    expect(
      () => parseChainProfileMarkdown(
        profileFixture(),
      ),
    ).not.toThrow();
  });

  it('derives the minimum chain-clock lead', () => {
    const parsed =
      parseChainProfileMarkdown(
        profileFixture(),
      );

    expect(
      parsed.derivedTiming.minimumChainClockLeadSeconds,
    ).toBe(13);
  });

  it('derives the timestamp-skew violation boundary', () => {
    const parsed =
      parseChainProfileMarkdown(
        profileFixture(),
      );

    expect(
      parsed.derivedTiming.timestampSkewViolationSeconds,
    ).toBe(10);
  });

  it('rejects an unsupported profile version', () => {
    const markdown = profileFixture({
      profileVersion: 2,
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'profileVersion must be 1.',
    );
  });

  it('rejects an unknown root key', () => {
    const markdown = profileFixture({
      extraRoot: 'unexpected: true\n',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'profile.unexpected is not supported.',
    );
  });

  it('rejects the freshness reserve under randomness', () => {
    const markdown = profileFixture({
      extraRandomness:
        '  timestampFreshnessReserveSeconds: 3\n',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'randomness.timestampFreshnessReserveSeconds '
      + 'is not supported.',
    );
  });

  it('rejects an unsupported chain adapter', () => {
    const markdown = profileFixture({
      adapterType: 'example-adapter',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'unsupported chainAdapter.type: example-adapter.',
    );
  });

  it('rejects a dangling assumptions section', () => {
    const markdown = profileFixture({
      assumptionsSection: 'missing-assumptions',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: missing-assumptions',
    );
  });

  it('rejects duplicate explicit anchors', () => {
    const markdown = profileFixture({
      body: `<a id="security-assumptions"></a>

## Security assumptions

<a id="security-assumptions"></a>
`,
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'duplicate explicit profile anchor: '
      + 'security-assumptions',
    );
  });

  it('does not resolve an anchor inside a fenced code block', () => {
    const fence = '```';

    const markdown = profileFixture({
      body: `${fence}html
<a id="security-assumptions"></a>
${fence}
`,
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: security-assumptions',
    );
  });

  it('does not treat a fenced anchor as a duplicate', () => {
    const fence = '```';

    const markdown = profileFixture({
      body: `<a id="security-assumptions"></a>

## Security assumptions

${fence}html
<a id="security-assumptions"></a>
${fence}
`,
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).not.toThrow();
  });

  it('does not resolve an anchor inside inline code', () => {
    const markdown = profileFixture({
      body: '`<a id="security-assumptions"></a>`',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'securityModel.assumptionsSection '
      + 'does not resolve: security-assumptions',
    );
  });

  it('requires skew monitoring for sequencer timestamp authority', () => {
    const markdown = profileFixture({
      monitoring: 'monitoring: {}',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'monitoring.timestampSkewSeconds is required '
      + 'when timestampAuthority is sequencer.',
    );
  });

  it('accepts the parent-chain security model without skew monitoring', () => {
    const markdown = profileFixture({
      timestampAuthority:
        'parent-chain-consensus',
      historyIntegrityAssumption:
        'parent-chain-precommitted',
      monitoring: 'monitoring: {}',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).not.toThrow();
  });

  it('rejects parent-chain precommitment with sequencer timestamps', () => {
    const markdown = profileFixture({
      timestampAuthority: 'sequencer',
      historyIntegrityAssumption:
        'parent-chain-precommitted',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'securityModel.historyIntegrityAssumption '
      + 'must be trusted-sequencer when '
      + 'timestampAuthority is sequencer.',
    );
  });

  it('rejects trusted sequencer history with parent-chain timestamps', () => {
    const markdown = profileFixture({
      timestampAuthority:
        'parent-chain-consensus',
      historyIntegrityAssumption:
        'trusted-sequencer',
      monitoring: 'monitoring: {}',
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'securityModel.historyIntegrityAssumption '
      + 'must be parent-chain-precommitted when '
      + 'timestampAuthority is parent-chain-consensus.',
    );
  });

  it('rejects timestamp skew warning at or above critical', () => {
    const markdown = profileFixture({
      monitoring: `monitoring:
  timestampSkewSeconds:
    warning: 8
    critical: 8`,
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'timestamp skew warning must be below critical.',
    );
  });

  it('rejects critical skew at the derived violation boundary', () => {
    const markdown = profileFixture({
      monitoring: `monitoring:
  timestampSkewSeconds:
    warning: 5
    critical: 10`,
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'timestamp skew critical must be below '
      + 'derived violation threshold (10s).',
    );
  });

  it('rejects a freshness reserve that consumes the entire lead', () => {
    const markdown = profileFixture({
      timestampFreshnessReserveSeconds: 13,
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'timing.timestampFreshnessReserveSeconds '
      + 'must be smaller than the minimum '
      + 'chain-clock lead.',
    );
  });

  it('rejects an absolute deployment manifest path', () => {
    const markdown = profileFixture({
      deploymentManifest: resolve(
        'example-network.json',
      ),
    });

    expect(
      () => parseChainProfileMarkdown(markdown),
    ).toThrow(
      'deploymentManifest must be a relative path.',
    );
  });
});

describe('loadChainProfile', () => {
  it('loads the profile and its resolved deployment manifest', async () => {
    const fixture =
      await writeFileFixture();

    const loaded =
      await loadChainProfile(
        fixture.profilePath,
      );

    expect(loaded.profilePath).toBe(
      resolve(fixture.profilePath),
    );

    expect(loaded.manifestPath).toBe(
      resolve(fixture.manifestPath),
    );

    expect(loaded.profile.network).toBe(
      NETWORK,
    );

    expect(loaded.manifest.network).toBe(
      NETWORK,
    );

    expect(loaded.profile.chainId).toBe(
      CHAIN_ID,
    );

    expect(loaded.manifest.chainId).toBe(
      CHAIN_ID,
    );

    expect(
      loaded.derivedTiming.minimumChainClockLeadSeconds,
    ).toBe(13);

    expect(
      loaded.derivedTiming.timestampSkewViolationSeconds,
    ).toBe(10);
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
      `deploymentManifest does not exist: ${fixture.manifestPath}`,
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
      `deploymentManifest is not a file: ${fixture.manifestPath}`,
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
      + fixture.manifestPath,
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
      'manifest.unexpected is not supported.',
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
      + 'manifest=different-network.',
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
      + `manifest=${CHAIN_ID + 1}.`,
    );
  });
});