import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileAsync: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  loadChainProfile: vi.fn(),
  checkDeployment: vi.fn(),
  createSecurityPublicClient: vi.fn(),
  verifyRpcChainId: vi.fn(),
  pinChainSnapshot: vi.fn(),
  checkTimestampEnvelopeAtSnapshot: vi.fn(),
  checkConsensusRootAtSnapshot: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

vi.mock('node:util', () => ({
  promisify: () => mocks.execFileAsync,
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));

vi.mock('./core/profile.js', () => ({
  loadChainProfile: mocks.loadChainProfile,
}));

vi.mock('./core/deployment.js', () => ({
  checkDeployment: mocks.checkDeployment,
}));

vi.mock('./core/client.js', () => ({
  createSecurityPublicClient:
    mocks.createSecurityPublicClient,
  verifyRpcChainId:
    mocks.verifyRpcChainId,
  pinChainSnapshot:
    mocks.pinChainSnapshot,
}));

vi.mock(
  './adapters/arbitrum-nitro/timestamp-envelope.js',
  () => ({
    checkTimestampEnvelopeAtSnapshot:
      mocks.checkTimestampEnvelopeAtSnapshot,
  }),
);

vi.mock(
  './adapters/arbitrum-nitro/consensus-root.js',
  () => ({
    checkConsensusRootAtSnapshot:
      mocks.checkConsensusRootAtSnapshot,
  }),
);

import {
  main,
  runSecurityCheck,
} from './check.js';

const NETWORK = 'test-network';
const CHAIN_ID = 12345;
const PARENT_CHAIN_ID = 54321;

const RPC_URL = 'http://l2.test';
const PARENT_RPC_URL = 'http://parent.test';

const REPOSITORY_REVISION = 'abc123';

const REGISTRY_CODEHASH =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const VERIFIER_CODEHASH =
  '0x2222222222222222222222222222222222222222222222222222222222222222';

const SEQUENCER_INBOX =
  '0x3333333333333333333333333333333333333333';

const WASM_MODULE_ROOT =
  '0x4444444444444444444444444444444444444444444444444444444444444444';

const APPROVED_WASM_MODULE_ROOT = {
  consensusRelease: 'test-release',
  root: WASM_MODULE_ROOT,
};

const EXPECTED_MAX_TIME_VARIATION = {
  delayBlocks: 100,
  futureBlocks: 20,
  delaySeconds: 300,
  futureSeconds: 30,
};

const OBSERVED_MAX_TIME_VARIATION = {
  delayBlocks: 100n,
  futureBlocks: 20n,
  delaySeconds: 300n,
  futureSeconds: 30n,
};

const L2_SNAPSHOT = {
  blockNumber: 123456n,
  blockTimestamp: 1700000000n,
};

const PARENT_SNAPSHOT = {
  blockNumber: 654321n,
  blockTimestamp: 1700000001n,
};

const PARENT_CLIENT = {
  kind: 'parent-client',
};

function createLoadedProfile() {
  return {
    profile: {
      network: NETWORK,
      chainId: CHAIN_ID,
      chainAdapter: {
        type: 'arbitrum-nitro',
        config: {
          parentChain: {
            name: 'test-parent',
            chainId: PARENT_CHAIN_ID,
            slotSeconds: 12,
            requireTimeVariationSlotParity: true,
          },
          rollup: '0x5555555555555555555555555555555555555555',
          expectedSequencerInbox: SEQUENCER_INBOX,
          expectedMaxTimeVariation: EXPECTED_MAX_TIME_VARIATION,
          approvedWasmModuleRoots: [
            APPROVED_WASM_MODULE_ROOT,
          ],
        },
      },
    },
    manifest: {
      kind: 'test-manifest',
    },
  };
}

function createDeploymentResult() {
  return {
    status: 'MATCH',
    observedChainId: CHAIN_ID,
    snapshot: L2_SNAPSHOT,
    checks: {
      registryRuntimeCodehash: {
        status: 'MATCH',
        expected: REGISTRY_CODEHASH,
        observed: REGISTRY_CODEHASH,
      },
      verifierRuntimeCodehash: {
        status: 'MATCH',
        expected: VERIFIER_CODEHASH,
        observed: VERIFIER_CODEHASH,
      },
      registryMinimumLeadRounds: {
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
    },
  };
}

function createTimestampEnvelopeResult() {
  return {
    status: 'MATCH',
    observedChainId: PARENT_CHAIN_ID,
    snapshot: PARENT_SNAPSHOT,
    checks: {
      sequencerInbox: {
        status: 'MATCH',
        expected: SEQUENCER_INBOX,
        observed: SEQUENCER_INBOX,
      },
      maxTimeVariation: {
        status: 'MATCH',
        expected:
          OBSERVED_MAX_TIME_VARIATION,
        observed:
          OBSERVED_MAX_TIME_VARIATION,
      },
    },
  };
}

function createConsensusRootResult() {
  return {
    status: 'MATCH',
    observedChainId: PARENT_CHAIN_ID,
    snapshot: PARENT_SNAPSHOT,
    check: {
      status: 'MATCH',
      expected: [
        APPROVED_WASM_MODULE_ROOT,
      ],
      observed: WASM_MODULE_ROOT,
      matched:
        APPROVED_WASM_MODULE_ROOT,
    },
  };
}

function createArguments() {
  return {
    network: NETWORK,
    rpcUrl: RPC_URL,
    parentRpcUrl: PARENT_RPC_URL,
    reportPath: undefined,
  };
}

function createCliArguments(): string[] {
  return [
    '--network',
    NETWORK,
    '--rpc-url',
    RPC_URL,
    '--parent-rpc-url',
    PARENT_RPC_URL,
  ];
}

function setRepositoryStates(
  before: {
    revision: string;
    dirty: boolean;
  },
  after: {
    revision: string;
    dirty: boolean;
  },
): void {
  mocks.execFileAsync.mockReset();

  mocks.execFileAsync
    .mockResolvedValueOnce({
      stdout: `${before.revision}\n`,
      stderr: '',
    })
    .mockResolvedValueOnce({
      stdout:
        before.dirty
          ? ' M test-file\n'
          : '',
      stderr: '',
    })
    .mockResolvedValueOnce({
      stdout: `${after.revision}\n`,
      stderr: '',
    })
    .mockResolvedValueOnce({
      stdout:
        after.dirty
          ? ' M test-file\n'
          : '',
      stderr: '',
    });
}

beforeEach(() => {
  vi.resetAllMocks();

  vi.spyOn(
    console,
    'log',
  ).mockImplementation(() => {});

  const loaded =
    createLoadedProfile();

  mocks.loadChainProfile.mockResolvedValue(
    loaded,
  );

  mocks.checkDeployment.mockResolvedValue(
    createDeploymentResult(),
  );

  mocks.createSecurityPublicClient.mockReturnValue(
    PARENT_CLIENT,
  );

  mocks.verifyRpcChainId.mockResolvedValue(
    PARENT_CHAIN_ID,
  );

  mocks.pinChainSnapshot.mockResolvedValue(
    PARENT_SNAPSHOT,
  );

  mocks.checkTimestampEnvelopeAtSnapshot
    .mockResolvedValue(
      createTimestampEnvelopeResult(),
    );

  mocks.checkConsensusRootAtSnapshot
    .mockResolvedValue(
      createConsensusRootResult(),
    );

  mocks.execFileAsync.mockImplementation(
    async (
      _file: string,
      args: readonly string[],
    ) => {
      if (args[0] === 'rev-parse') {
        return {
          stdout:
            `${REPOSITORY_REVISION}\n`,
          stderr: '',
        };
      }

      if (args[0] === 'status') {
        return {
          stdout: '',
          stderr: '',
        };
      }

      throw new Error(
        `Unexpected git command: ${args.join(' ')}`,
      );
    },
  );

  mocks.mkdir.mockResolvedValue(
    undefined,
  );

  mocks.writeFile.mockResolvedValue(
    undefined,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runSecurityCheck', () => {
  it('validates the profile before any RPC access', async () => {
    mocks.loadChainProfile.mockRejectedValue(
      new Error('Invalid profile.'),
    );

    await expect(
      runSecurityCheck(
        createArguments(),
      ),
    ).rejects.toThrow(
      'Invalid profile.'
    );

    expect(
      mocks.execFileAsync,
    ).not.toHaveBeenCalled();

    expect(
      mocks.checkDeployment,
    ).not.toHaveBeenCalled();

    expect(
      mocks.createSecurityPublicClient,
    ).not.toHaveBeenCalled();
  });

  it('requires a parent RPC URL for Nitro profiles before RPC access', async () => {
    await expect(
      runSecurityCheck({
        ...createArguments(),
        parentRpcUrl: undefined,
      }),
    ).rejects.toThrow(
      '--parent-rpc-url is required for arbitrum-nitro profiles.'
    );

    expect(
      mocks.execFileAsync,
    ).not.toHaveBeenCalled();

    expect(
      mocks.checkDeployment,
    ).not.toHaveBeenCalled();

    expect(
      mocks.createSecurityPublicClient,
    ).not.toHaveBeenCalled();
  });

  it('uses one shared parent snapshot and maps all successful checks into the report', async () => {
    const loaded =
      createLoadedProfile();

    mocks.loadChainProfile.mockResolvedValue(
      loaded,
    );

    const report =
      await runSecurityCheck(
        createArguments(),
      );

    expect(
      mocks.checkDeployment,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.checkDeployment,
    ).toHaveBeenCalledWith({
      rpcUrl: RPC_URL,
      profile: loaded.profile,
      manifest: loaded.manifest,
    });

    expect(
      mocks.createSecurityPublicClient,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.createSecurityPublicClient,
    ).toHaveBeenCalledWith(
      PARENT_RPC_URL,
    );

    expect(
      mocks.verifyRpcChainId,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.verifyRpcChainId,
    ).toHaveBeenCalledWith(
      PARENT_CLIENT,
      PARENT_CHAIN_ID,
    );

    expect(
      mocks.pinChainSnapshot,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.pinChainSnapshot,
    ).toHaveBeenCalledWith(
      PARENT_CLIENT,
    );

    expect(
      mocks.checkTimestampEnvelopeAtSnapshot,
    ).toHaveBeenCalledWith({
      client: PARENT_CLIENT,
      observedChainId: PARENT_CHAIN_ID,
      snapshot: PARENT_SNAPSHOT,
      config: loaded.profile.chainAdapter.config,
    });

    expect(
      mocks.checkConsensusRootAtSnapshot,
    ).toHaveBeenCalledWith({
      client: PARENT_CLIENT,
      observedChainId: PARENT_CHAIN_ID,
      snapshot: PARENT_SNAPSHOT,
      config: loaded.profile.chainAdapter.config,
    });

    expect(report.observations).toEqual([
      {
        id: 'l2',
        chainId: CHAIN_ID,
        blockNumber: L2_SNAPSHOT.blockNumber,
        blockTimestamp: L2_SNAPSHOT.blockTimestamp,
      },
      {
        id: 'parent',
        chainId: PARENT_CHAIN_ID,
        blockNumber: PARENT_SNAPSHOT.blockNumber,
        blockTimestamp: PARENT_SNAPSHOT.blockTimestamp,
      },
    ]);

    expect(report.checks).toEqual([
      {
        id: 'deployment.registry-runtime-codehash',
        observationIds: [
          'l2',
        ],
        status: 'MATCH',
        expected: REGISTRY_CODEHASH,
        observed: REGISTRY_CODEHASH,
      },
      {
        id:
          'deployment.verifier-runtime-codehash',
        observationIds: [
          'l2',
        ],
        status: 'MATCH',
        expected: VERIFIER_CODEHASH,
        observed: VERIFIER_CODEHASH,
      },
      {
        id:
          'deployment.registry-minimum-lead-rounds',
        observationIds: [
          'l2',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
      {
        id:
          'arbitrum-nitro.sequencer-inbox',
        observationIds: [
          'parent',
        ],
        status: 'MATCH',
        expected: SEQUENCER_INBOX,
        observed: SEQUENCER_INBOX,
      },
      {
        id:
          'arbitrum-nitro.max-time-variation',
        observationIds: [
          'parent',
        ],
        status: 'MATCH',
        expected: OBSERVED_MAX_TIME_VARIATION,
        observed: OBSERVED_MAX_TIME_VARIATION,
      },
      {
        id:
          'arbitrum-nitro.wasm-module-root',
        observationIds: [
          'parent',
        ],
        status: 'MATCH',
        expected: [
          APPROVED_WASM_MODULE_ROOT,
        ],
        observed: WASM_MODULE_ROOT,
        details: {
          matchedApprovedRoot: APPROVED_WASM_MODULE_ROOT,
        },
      },
    ]);

    expect(
      report.aggregateStatus,
    ).toBe(
      'MATCH',
    );

    expect(
      report.repositoryRevision,
    ).toBe(
      REPOSITORY_REVISION,
    );

    expect(
      report.repositoryDirty,
    ).toBe(false);
  });

  it('records a parent RPC context error without running parent checks', async () => {
    mocks.verifyRpcChainId.mockRejectedValue(
      new Error(
        'Parent chain ID mismatch.',
      ),
    );

    const report =
      await runSecurityCheck(
        createArguments(),
      );

    expect(
      mocks.pinChainSnapshot,
    ).not.toHaveBeenCalled();

    expect(
      mocks.checkTimestampEnvelopeAtSnapshot,
    ).not.toHaveBeenCalled();

    expect(
      mocks.checkConsensusRootAtSnapshot,
    ).not.toHaveBeenCalled();

    expect(report.observations).toEqual([
      {
        id: 'l2',
        chainId: CHAIN_ID,
        blockNumber: L2_SNAPSHOT.blockNumber,
        blockTimestamp: L2_SNAPSHOT.blockTimestamp,
      },
    ]);

    expect(
      report.checks,
    ).toContainEqual({
      id:
        'arbitrum-nitro.parent-rpc-context',
      observationIds: [],
      status: 'ERROR',
      expected: {
        chainId: PARENT_CHAIN_ID,
      },
      error: 'Parent chain ID mismatch.',
    });

    expect(
      report.aggregateStatus,
    ).toBe(
      'ERROR',
    );
  });

  it('continues parent checks after an L2 deployment context error', async () => {
    mocks.checkDeployment.mockRejectedValue(
      new Error(
        'L2 chain ID mismatch.',
      ),
    );

    const report = await runSecurityCheck(createArguments());

    expect(
      mocks.checkTimestampEnvelopeAtSnapshot,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.checkConsensusRootAtSnapshot,
    ).toHaveBeenCalledTimes(1);

    expect(report.observations).toEqual([
      {
        id: 'parent',
        chainId: PARENT_CHAIN_ID,
        blockNumber: PARENT_SNAPSHOT.blockNumber,
        blockTimestamp: PARENT_SNAPSHOT.blockTimestamp,
      },
    ]);

    expect(
      report.checks[0],
    ).toEqual({
      id: 'deployment.rpc-context',
      observationIds: [],
      status: 'ERROR',
      expected: {
        chainId: CHAIN_ID,
      },
      error: 'L2 chain ID mismatch.',
    });

    expect(
      report.aggregateStatus,
    ).toBe(
      'ERROR',
    );
  });

  it('continues consensus-root verification after timestamp-envelope drift', async () => {
    mocks.checkTimestampEnvelopeAtSnapshot
      .mockResolvedValue({
        status: 'DRIFT',
        observedChainId: PARENT_CHAIN_ID,
        snapshot: PARENT_SNAPSHOT,
        checks: {
          sequencerInbox: {
            status: 'MATCH',
            expected: SEQUENCER_INBOX,
            observed: SEQUENCER_INBOX,
          },
          maxTimeVariation: {
            status: 'DRIFT',
            expected: OBSERVED_MAX_TIME_VARIATION,
            observed: {
              ...OBSERVED_MAX_TIME_VARIATION,
              delaySeconds: 301n,
            },
            reason: 'maxTimeVariation changed.',
          },
        },
      });

    const report = await runSecurityCheck(createArguments());

    expect(
      mocks.checkConsensusRootAtSnapshot,
    ).toHaveBeenCalledTimes(1);

    expect(
      report.checks,
    ).toContainEqual({
      id: 'arbitrum-nitro.max-time-variation',
      observationIds: [
        'parent',
      ],
      status: 'DRIFT',
      expected: OBSERVED_MAX_TIME_VARIATION,
      observed: {
        ...OBSERVED_MAX_TIME_VARIATION,
        delaySeconds: 301n,
      },
      reason: 'maxTimeVariation changed.',
    });

    expect(
      report.aggregateStatus,
    ).toBe(
      'DRIFT',
    );
  });

  it('continues consensus-root verification after an unexpected timestamp-envelope error', async () => {
    mocks.checkTimestampEnvelopeAtSnapshot
      .mockRejectedValue(
        new Error(
          'Unexpected timestamp failure.',
        ),
      );

    const report = await runSecurityCheck(createArguments());

    expect(
      mocks.checkConsensusRootAtSnapshot,
    ).toHaveBeenCalledTimes(1);

    expect(
      report.checks,
    ).toContainEqual({
      id: 'arbitrum-nitro.timestamp-envelope-execution',
      observationIds: [
        'parent',
      ],
      status: 'ERROR',
      expected: {
        expectedSequencerInbox: SEQUENCER_INBOX,
        expectedMaxTimeVariation: EXPECTED_MAX_TIME_VARIATION,
      },
      error: 'Unexpected timestamp failure.',
    });

    expect(
      report.aggregateStatus,
    ).toBe(
      'ERROR',
    );
  });

  it.each([
    [
      true,
      false,
    ],
    [
      false,
      true,
    ],
  ])(
    'marks the report dirty when the repository is dirty before or after verification',
    async (
      dirtyBefore,
      dirtyAfter,
    ) => {
      setRepositoryStates(
        {
          revision:
            REPOSITORY_REVISION,
          dirty: dirtyBefore,
        },
        {
          revision:
            REPOSITORY_REVISION,
          dirty: dirtyAfter,
        },
      );

      const report =
        await runSecurityCheck(
          createArguments(),
        );

      expect(
        report.repositoryDirty,
      ).toBe(true);
    },
  );

  it('rejects a repository revision change during verification', async () => {
    setRepositoryStates(
      {
        revision:
          REPOSITORY_REVISION,
        dirty: false,
      },
      {
        revision: 'def456',
        dirty: false,
      },
    );

    await expect(
      runSecurityCheck(
        createArguments(),
      ),
    ).rejects.toThrow(
      'Repository revision changed during verification.'
    );
  });
});

describe('main', () => {
  it('returns exit code 0 for MATCH', async () => {
    const exitCode =
      await main(
        createCliArguments(),
      );

    expect(exitCode).toBe(0);
  });

  it('returns exit code 2 for DRIFT', async () => {
    mocks.checkConsensusRootAtSnapshot
      .mockResolvedValue({
        status: 'DRIFT',
        observedChainId: PARENT_CHAIN_ID,
        snapshot: PARENT_SNAPSHOT,
        check: {
          status: 'DRIFT',
          expected: [
            APPROVED_WASM_MODULE_ROOT,
          ],
          observed:
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          reason: 'wasmModuleRoot is not in the approved root set.',
        },
      });

    const exitCode = await main(createCliArguments());

    expect(exitCode).toBe(2);
  });

  it('returns exit code 1 for ERROR', async () => {
    mocks.verifyRpcChainId.mockRejectedValue(
      new Error(
        'Parent chain ID mismatch.',
      ),
    );

    const exitCode = await main(createCliArguments());

    expect(exitCode).toBe(1);
  });

  it('writes a serialized report when --report is provided', async () => {
    const reportPath =
      'docs/security/verification/test-network/report.json';

    const exitCode =
      await main([
        ...createCliArguments(),
        '--report',
        reportPath,
      ]);

    expect(exitCode).toBe(0);

    expect(
      mocks.mkdir,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.writeFile,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.writeFile,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        reportPath,
      ),
      expect.stringContaining(
        '"aggregateStatus": "MATCH"',
      ),
      'utf8',
    );

    const serialized = mocks.writeFile.mock.calls[0]?.[1];

    expect(
      typeof serialized,
    ).toBe('string');

    expect(
      serialized,
    ).toContain(
      '"blockNumber": "123456"',
    );

    expect(
      serialized,
    ).toContain(
      '"repositoryRevision": "abc123"',
    );

    expect(
      serialized,
    ).toMatch(/\n$/);
  });

  it('rejects unknown CLI arguments before loading a profile', async () => {
    await expect(
      main([
        '--unknown',
      ]),
    ).rejects.toThrow(
      'Unknown argument: --unknown.'
    );

    expect(
      mocks.loadChainProfile,
    ).not.toHaveBeenCalled();
  });
});