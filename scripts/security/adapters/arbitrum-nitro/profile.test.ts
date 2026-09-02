import {
  getAddress,
} from 'viem';
import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  validateArbitrumNitroConfig,
} from './profile.js';

const ROLLUP =
  '0xdc5F8E399DBd8a9F5F87AeC4C23Beb12431b386D';

const SEQUENCER_INBOX =
  '0xA0D9dB3DC9791D54b5183C1C1866eFe1eCA7D414';

const CONSENSUS_V61_ROOT =
  '0xc10cd7ec6acaf1c441a3f6bd0900ad20'
  + 'f15855ba775a96f1939118cbc629dc97';

const OTHER_ROOT =
  '0x11111111111111111111111111111111'
  + '11111111111111111111111111111111';

function validConfig() {
  return {
    parentChain: {
      name: 'ethereum-sepolia',
      chainId: 11155111,
      slotSeconds: 12,
      requireTimeVariationSlotParity: true,
    },
    rollup: ROLLUP,
    expectedSequencerInbox: SEQUENCER_INBOX,
    expectedMaxTimeVariation: {
      delayBlocks: 28800,
      futureBlocks: 300,
      delaySeconds: 345600,
      futureSeconds: 3600,
    },
    approvedWasmModuleRoots: [
      {
        consensusRelease: 'consensus-v61',
        root: CONSENSUS_V61_ROOT,
      },
    ],
  };
}

describe('validateArbitrumNitroConfig', () => {
  it('accepts the Robinhood Testnet configuration', () => {
    expect(
      () => validateArbitrumNitroConfig(validConfig()),
    ).not.toThrow();
  });

  it('canonicalizes addresses', () => {
    const config = validConfig();

    config.rollup = ROLLUP.toLowerCase();
    config.expectedSequencerInbox =
      SEQUENCER_INBOX.toLowerCase();

    const validated =
      validateArbitrumNitroConfig(config);

    expect(validated.rollup).toBe(
      getAddress(ROLLUP),
    );

    expect(validated.expectedSequencerInbox).toBe(
      getAddress(SEQUENCER_INBOX),
    );
  });

  it('accepts lowercase addresses', () => {
    const config = validConfig();

    config.rollup = ROLLUP.toLowerCase();
    config.expectedSequencerInbox =
      SEQUENCER_INBOX.toLowerCase();

    expect(
      () => validateArbitrumNitroConfig(config),
    ).not.toThrow();
  });

  it('rejects an invalid mixed-case address checksum', () => {
    const config = validConfig();

    config.rollup =
      '0xdc5F8E399DBd8a9F5F87AeC4C23Beb12431b386d';

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.rollup must be an EVM address.'
    );
  });

  it('rejects an invalid Rollup address', () => {
    const config = validConfig();

    config.rollup = '0x1234';

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.rollup must be an EVM address.'
    );
  });

  it('rejects an invalid expected SequencerInbox address', () => {
    const config = validConfig();

    config.expectedSequencerInbox = 'not-an-address';

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.expectedSequencerInbox '
      + 'must be an EVM address.'
    );
  });

  it('rejects a non-hex WASM root', () => {
    const config = validConfig();

    config.approvedWasmModuleRoots[0]!.root =
      'not-hex';

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.approvedWasmModuleRoots[0].root '
      + 'must be hex.'
    );
  });

  it('rejects a WASM root that is not bytes32', () => {
    const config = validConfig();

    config.approvedWasmModuleRoots[0]!.root =
      '0x1234';

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.approvedWasmModuleRoots[0].root '
      + 'must be bytes32.'
    );
  });

  it('rejects a duplicate approved WASM root', () => {
    const config = validConfig();

    config.approvedWasmModuleRoots.push({
      consensusRelease: 'consensus-v62',
      root: CONSENSUS_V61_ROOT,
    });

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      `duplicate approved WASM root: ${CONSENSUS_V61_ROOT}`
    );
  });

  it('rejects a duplicate approved WASM root case-insensitively', () => {
    const config = validConfig();

    const upperRoot =
      `0x${CONSENSUS_V61_ROOT.slice(2).toUpperCase()}`;

    config.approvedWasmModuleRoots.push({
      consensusRelease: 'consensus-v62',
      root: upperRoot,
    });

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      `duplicate approved WASM root: ${CONSENSUS_V61_ROOT}`
    );
  });

  it('rejects a duplicate approved consensus release', () => {
    const config = validConfig();

    config.approvedWasmModuleRoots.push({
      consensusRelease: 'consensus-v61',
      root: OTHER_ROOT,
    });

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'duplicate approved consensus release: consensus-v61'
    );
  });

  it('rejects an unknown adapter key', () => {
    const config = {
      ...validConfig(),
      unexpected: true,
    };

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.unexpected is not supported.'
    );
  });

  it('rejects an unknown parent-chain key', () => {
    const base = validConfig();

    const config = {
      ...base,
      parentChain: {
        ...base.parentChain,
        unexpected: true,
      },
    };

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.parentChain.unexpected '
      + 'is not supported.'
    );
  });

  it('rejects an unknown approved-root key', () => {
    const base = validConfig();
    const root = base.approvedWasmModuleRoots[0]!;

    const config = {
      ...base,
      approvedWasmModuleRoots: [
        {
          ...root,
          unexpected: true,
        },
      ],
    };

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.approvedWasmModuleRoots[0].unexpected '
      + 'is not supported.',
    );
  });

  it('rejects delay block/second parity mismatch', () => {
    const config = validConfig();

    config.expectedMaxTimeVariation.delaySeconds =
      345599;

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'delayBlocks/delaySeconds do not match '
      + 'parent-chain slot parity: '
      + '28800 * 12 != 345599'
    );
  });

  it('rejects future block/second parity mismatch', () => {
    const config = validConfig();

    config.expectedMaxTimeVariation.futureSeconds =
      3599;

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'futureBlocks/futureSeconds do not match '
      + 'parent-chain slot parity: '
      + '300 * 12 != 3599'
    );
  });

  it('allows parity mismatch when parity validation is disabled', () => {
    const config = validConfig();

    config.parentChain.requireTimeVariationSlotParity =
      false;

    config.expectedMaxTimeVariation.delaySeconds =
      1;

    config.expectedMaxTimeVariation.futureSeconds =
      2;

    expect(
      () => validateArbitrumNitroConfig(config),
    ).not.toThrow();
  });

  it('allows zero max-time-variation values', () => {
    const config = validConfig();

    config.expectedMaxTimeVariation = {
      delayBlocks: 0,
      futureBlocks: 0,
      delaySeconds: 0,
      futureSeconds: 0,
    };

    expect(
      () => validateArbitrumNitroConfig(config),
    ).not.toThrow();
  });

  it('rejects a zero parent-chain chain ID', () => {
    const config = validConfig();

    config.parentChain.chainId = 0;

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.parentChain.chainId '
      + 'must be a positive safe integer.'
    );
  });

  it('rejects a zero parent-chain slot duration', () => {
    const config = validConfig();

    config.parentChain.slotSeconds = 0;

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.parentChain.slotSeconds '
      + 'must be a positive safe integer.'
    );
  });

  it('rejects an empty approved WASM root list', () => {
    const config = validConfig();

    config.approvedWasmModuleRoots = [];

    expect(
      () => validateArbitrumNitroConfig(config),
    ).toThrow(
      'chainAdapter.config.approvedWasmModuleRoots '
      + 'must be a non-empty array.'
    );
  });
});