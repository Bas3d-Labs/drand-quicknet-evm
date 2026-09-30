import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../../src/config/deployment.js', async (importOriginal) => ({
  ...await importOriginal<
    typeof import('../../src/config/deployment.js')
  >(),
  loadRegistryDeployment: vi.fn(),
}));

vi.mock('../../src/config/custom-network-config.js', () => ({
  loadCustomNetworkDescriptor: vi.fn(),
}));

import {
  main,
} from '../../src/cli/cli.js';

import {
  loadRegistryDeployment,
  parseRegistryDeployment,
} from '../../src/config/deployment.js';

import {
  loadCustomNetworkDescriptor,
} from '../../src/config/custom-network-config.js';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

import type {
  SummarizeErrorOptions,
} from '../../src/diagnostics/error-summary.js';

const SECRET = 'configuration-diagnostic-canary';
const PRIVATE_KEY = '0x' + '11'.repeat(32);
const RPC_URL = `https://rpc.example/${SECRET}`;

const WRONG_CHAIN_MANIFEST = {
  chainId: 4663,
  registry: {
    address: '0x2222222222222222222222222222222222222222',
    runtimeCodehash: '0x' + 'aa'.repeat(32),
  },
  verifier: {
    address: '0x3333333333333333333333333333333333333333',
    runtimeCodehash: '0x' + 'bb'.repeat(32),
  },
};

describe('configuration failure diagnostics through the CLI', () => {
  beforeEach(() => {
    vi.mocked(loadRegistryDeployment).mockReset();
    vi.mocked(loadCustomNetworkDescriptor).mockReset();

    vi.stubEnv('PRIVATE_KEY', PRIVATE_KEY);
    vi.stubEnv('ROBINHOOD_TESTNET_RPC_URL', RPC_URL);
    vi.stubEnv('QUICKNET_RPC_URL', RPC_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['import', 'import-when-available', 'daemon'])(
    '%s installs diagnostics before deployment chain validation',
    async (command) => {
      let policy: SummarizeErrorOptions | undefined;

      const onDiagnostics = vi.fn((value) => {
        policy = value;
      });

      vi.mocked(loadRegistryDeployment).mockImplementation(
        async (options) => {
          expect(onDiagnostics).toHaveBeenCalledOnce();
          expect(policy).toBeDefined();

          return parseRegistryDeployment(WRONG_CHAIN_MANIFEST, {
            expectedChainId: options.expectedChainId!,
          });
        },
      );

      const args = [
        command,
        '--network',
        'robinhood-testnet',
      ];

      if (command !== 'daemon') {
        args.push('--round', '1');
      }

      const output = vi.fn();
      let failure: unknown;

      try {
        await main(args, output, { onDiagnostics });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(onDiagnostics).toHaveBeenCalledOnce();
      expect(output).not.toHaveBeenCalled();

      const record = JSON.parse(renderDiagnostic(failure, policy));

      expect(record).toMatchObject({
        event: 'cli_failed',
        kind: 'operation',
        err: {
          message:
            'Deployment manifest chain mismatch: ' +
            'expected 46630, received 4663.',
        },
      });
    },
  );

  it.each(['import', 'import-when-available', 'daemon'])(
    '%s scrubs a descriptor failure after installing diagnostics',
    async (command) => {
      let policy: SummarizeErrorOptions | undefined;

      const onDiagnostics = vi.fn((value) => {
        policy = value;
      });

      const failure = new Error(
        'Invalid custom network descriptor; ' +
        `endpoint=${RPC_URL}; key=${PRIVATE_KEY}`,
      );

      vi.mocked(loadCustomNetworkDescriptor).mockImplementation(
        async () => {
          expect(onDiagnostics).toHaveBeenCalledOnce();
          throw failure;
        },
      );

      const args = [
        command,
        '--network-config',
        './networks/invalid.json',
      ];

      if (command !== 'daemon') {
        args.push('--round', '1');
      }

      await expect(
        main(args, vi.fn(), { onDiagnostics }),
      ).rejects.toBe(failure);

      expect(onDiagnostics).toHaveBeenCalledOnce();

      const line = renderDiagnostic(failure, policy);
      const record = JSON.parse(line);

      expect(record.err.message)
        .toContain('Invalid custom network descriptor');
      expect(record.err.textModified).toBe(true);
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(PRIVATE_KEY.slice(2));
    },
  );

  it('rejects an invalid custom RPC URL before reading the descriptor', async () => {
    vi.stubEnv('QUICKNET_RPC_URL', 'not-a-url');

    const onDiagnostics = vi.fn();

    await expect(
      main([
        'import',
        '--network-config',
        './networks/example.json',
        '--round',
        '1',
      ], vi.fn(), { onDiagnostics }),
    ).rejects.toThrow();

    expect(onDiagnostics).not.toHaveBeenCalled();
    expect(loadCustomNetworkDescriptor).not.toHaveBeenCalled();
    expect(loadRegistryDeployment).not.toHaveBeenCalled();
  });
});