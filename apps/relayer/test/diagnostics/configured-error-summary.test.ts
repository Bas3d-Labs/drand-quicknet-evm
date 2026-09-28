import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createConfiguredErrorSummary,
} from '../../src/diagnostics/configured-error-summary.js';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

const TOKEN = 'configured-rpc-canary';
const PRIVATE_KEY = `0x${'ab12'.repeat(16)}`;
const RPC_URL = `https://rpc.example/v3/${TOKEN}`;

describe('createConfiguredErrorSummary', () => {
  it('preserves explanations and scrubs configured credentials', () => {
    const policy = createConfiguredErrorSummary({
      rpcUrl: RPC_URL,
      privateKey: PRIVATE_KEY,
    });

    const error = new Error(
      'historical state is not available; ' +
      `${RPC_URL}; token=${TOKEN}; ` +
      `key=${PRIVATE_KEY.toUpperCase()}`,
    );

    const line = renderDiagnostic(error, policy);

    expect(policy.mode).toBe('standard');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(line).toContain('historical state is not available');
    expect(line).toContain('https://rpc.example/[REDACTED]');
    expect(line).not.toContain(TOKEN);
    expect(line.toLowerCase()).not.toContain(PRIVATE_KEY.slice(2));
  });

  it('captures credentials independently of later option changes', () => {
    const options = {
      rpcUrl: RPC_URL,
      privateKey: PRIVATE_KEY,
    };

    const policy = createConfiguredErrorSummary(options);

    options.rpcUrl = 'https://other.example';
    options.privateKey = `0x${'22'.repeat(32)}`;

    const line = renderDiagnostic(
      new Error(`request rejected; token=${TOKEN}; key=${PRIVATE_KEY}`),
      policy,
    );

    expect(JSON.parse(line).err.message).toBe(
      'request rejected; token=[REDACTED]; key=[REDACTED]',
    );
  });
});