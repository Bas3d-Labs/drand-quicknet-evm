import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  WalletClient,
} from 'viem';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

import {
  isSignerRestartFailure,
} from '../../src/execution/signer-restart-failure.js';

import {
  SignerRestartRequiredError,
} from '../../src/state/signer-restart-required-error.js';

import {
  TransactionManager,
} from '../../src/state/transaction-manager.js';

import {
  ACCOUNT,
  IDENTITY,
  client,
} from '../helpers/operator-attribution-fixture.js';

async function wrapped(cause: unknown) {
  const manager = await TransactionManager.create({
    identity: IDENTITY,
    store: {
      load: async () => ({ kind: 'missing' }),
      save: async () => { throw new Error('Unexpected save'); },
    },
    maxRetainedAttempts: 1,
    publicClient: client().publicClient,
    walletClient: {} as WalletClient,
    account: ACCOUNT,
    readChainHeads: async () => { throw cause; },
    maxBlockRange: 2n,
    retry: { initialDelayMs: 1_000, maxDelayMs: 10_000 },
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      destination: { write() {} },
    }),
    createErrorSummary: () => ({
      scrubText: (text) => ({ text, removed: false }),
    }),
  });

  try {
    await manager.submit({
      work: {
        workId: 'recognition:test',
        call: { to: ACCOUNT.address, data: '0x', value: 0n },
      },
    });
  } catch (error) {
    return error;
  }

  throw new Error('Expected a submission failure.');
}

describe('restart failure classification', () => {
  it('recognizes direct and once-wrapped typed failures', async () => {
    const error = new SignerRestartRequiredError();

    const wrapper = await wrapped(error);

    expect(isSignerRestartFailure(error)).toBe(true);
    expect(isSignerRestartFailure(wrapper)).toBe(true);
    expect(isSignerRestartFailure(await wrapped(wrapper))).toBe(false);
    expect(isSignerRestartFailure(await wrapped(new Error('ordinary'))))
      .toBe(false);
  });

  it('does not classify names, messages or unregistered causes', () => {
    const error = new SignerRestartRequiredError();

    expect(isSignerRestartFailure(new Error(error.message))).toBe(false);
    expect(isSignerRestartFailure({ name: error.name, message: error.message }))
      .toBe(false);
    expect(isSignerRestartFailure(new Error('wrapper', { cause: error })))
      .toBe(false);
    expect(isSignerRestartFailure(null)).toBe(false);
  });

  it('never evaluates a registered wrapper cause getter', async () => {
    const wrapper = await wrapped(new SignerRestartRequiredError());

    const getter = vi.fn(() => { throw new Error('Getter ran'); });

    Object.defineProperty(wrapper, 'cause', { get: getter });

    expect(isSignerRestartFailure(wrapper)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it(
    'does not recognize an inherited cause on a registered wrapper',
    async () => {
      const wrapper = await wrapped(new SignerRestartRequiredError());

      Reflect.deleteProperty(wrapper as object, 'cause');
      Object.setPrototypeOf(wrapper, {
        cause: new SignerRestartRequiredError(),
      });

      expect(isSignerRestartFailure(wrapper)).toBe(false);
    },
  );

  it('contains hostile prototype inspection', () => {
    const error = new Proxy({}, {
      getPrototypeOf() { throw new Error('Opaque error'); },
    });

    expect(isSignerRestartFailure(error)).toBe(false);
  });

  it(
    'renders fixed restart guidance without reading the error message',
    async () => {
      const error = new SignerRestartRequiredError();

      const getter = vi.fn(() => { throw new Error('Secret getter'); });

      Object.defineProperty(error, 'message', { get: getter });

      const wrapper = await wrapped(error);

      for (const failure of [error, wrapper]) {
        expect(JSON.parse(renderDiagnostic(failure))).toEqual({
          event: 'cli_failed',
          kind: 'signer-journal',
          code: 'signer-restart-required',
          message:
            'Journal persistence was acknowledged, but coordinator ' +
            'completion failed. The committed journal is retained. ' +
            'Restart the relayer to reload it and run recovery; ' +
            'persistence retry is unavailable.',
        });
      }

      expect(getter).not.toHaveBeenCalled();
    },
  );
});
