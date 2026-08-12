import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock(
  '../src/config.js',
  () => ({
    loadRelayerConfig: vi.fn(),
    parseRelayerNetworkPreset: (
      value: string,
    ) => {
      if (
        value ===
          'robinhood-testnet'
      ) {
        return value;
      }

      throw new Error(
        `Unsupported network preset: ${value}. Supported presets: robinhood-testnet`
      );
    },
  }),
);

vi.mock(
  '../src/clients.js',
  () => ({
    createRelayerClients: vi.fn(),
  }),
);

vi.mock(
  '../src/daemon-command.js',
  () => ({
    runDaemonCommand: vi.fn(),
  }),
);

vi.mock(
  '../src/import-round.js',
  () => ({
    importQuicknetRound: vi.fn(),
  }),
);

vi.mock(
  '../src/import-round-when-available.js',
  () => ({
    importQuicknetRoundWhenAvailable: vi.fn(),
  }),
);

import {
  runDaemonCommand,
} from '../src/daemon-command.js';

import {
  main,
  parseCommandArguments,
} from '../src/cli.js';

const MAX_UINT64 = '18446744073709551615';
const ABOVE_MAX_UINT64 = '18446744073709551616';

describe('parseCommandArguments', () => {
  describe('help', () => {
    it('returns help when no command is provided', () => {
      expect(
        parseCommandArguments([])
      ).toEqual({
        command: 'help',
      });
    });

    it('returns help for --help', () => {
      expect(
        parseCommandArguments([
          '--help',
        ])
      ).toEqual({
        command: 'help',
      });
    });

    it('returns help for -h', () => {
      expect(
        parseCommandArguments([
          '-h',
        ])
      ).toEqual({
        command: 'help',
      });
    });

    it('returns help for the help command', () => {
      expect(
        parseCommandArguments([
          'help',
        ])
      ).toEqual({
        command: 'help',
      });
    });
  });

  describe('import', () => {
    it('parses an import command with a network preset', () => {
      expect(
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ])
      ).toEqual({
        command: 'import',
        source: {
          type: 'preset',
          network:
            'robinhood-testnet',
        },
        round: 31_089_008n,
      });
    });

    it('parses an import command with a custom network config', () => {
      expect(
        parseCommandArguments([
          'import',
          '--network-config',
          './networks/example-mainnet.json',
          '--round',
          '31089008',
        ])
      ).toEqual({
        command: 'import',
        source: {
          type: 'custom',
          configFile:
            './networks/example-mainnet.json',
        },
        round: 31_089_008n,
      });
    });

    it('accepts import options in either order', () => {
      expect(
        parseCommandArguments([
          'import',
          '--round',
          '31089008',
          '--network',
          'robinhood-testnet',
        ])
      ).toEqual({
        command: 'import',
        source: {
          type: 'preset',
          network:
            'robinhood-testnet',
        },
        round: 31_089_008n,
      });
    });

    it('accepts a custom network config after the round', () => {
      expect(
        parseCommandArguments([
          'import',
          '--round',
          '31089008',
          '--network-config',
          './networks/example-mainnet.json',
        ])
      ).toEqual({
        command: 'import',
        source: {
          type: 'custom',
          configFile:
            './networks/example-mainnet.json',
        },
        round: 31_089_008n,
      });
    });

    it('accepts leading zeroes in the round', () => {
      expect(
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '000123',
        ])
      ).toEqual({
        command: 'import',
        source: {
          type: 'preset',
          network:
            'robinhood-testnet',
        },
        round: 123n,
      });
    });

    it('accepts the maximum uint64 round', () => {
      expect(
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          MAX_UINT64,
        ])
      ).toEqual({
        command: 'import',
        source: {
          type: 'preset',
          network:
            'robinhood-testnet',
        },
        round: 18_446_744_073_709_551_615n,
      });
    });

    it('rejects a missing network source', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--round',
          '31089008',
        ])
      ).toThrow(
        'Missing required argument: --network or --network-config.'
      );
    });

    it('rejects a missing round', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
        ])
      ).toThrow(
        'Missing required argument: --round.'
      );
    });

    it('rejects a missing --network value', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
        ])
      ).toThrow(
        'Missing value for --network.'
      );
    });

    it('rejects a missing --network-config value', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network-config',
        ])
      ).toThrow(
        'Missing value for --network-config.'
      );
    });

    it('rejects a missing --round value', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
        ])
      ).toThrow(
        'Missing value for --round.'
      );
    });

    it('rejects duplicate network arguments', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ])
      ).toThrow(
        'Duplicate argument: --network.'
      );
    });

    it('rejects duplicate network config arguments', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network-config',
          './networks/example-mainnet.json',
          '--network-config',
          './networks/other-mainnet.json',
          '--round',
          '31089008',
        ])
      ).toThrow(
        'Duplicate argument: --network-config.'
      );
    });

    it('rejects a network preset with a custom network config', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--network-config',
          './networks/example-mainnet.json',
          '--round',
          '31089008',
        ])
      ).toThrow(
        'Arguments --network and --network-config are mutually exclusive.'
      );
    });

    it('rejects a custom network config with a network preset', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network-config',
          './networks/example-mainnet.json',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ])
      ).toThrow(
        'Arguments --network and --network-config are mutually exclusive.'
      );
    });

    it('rejects duplicate round arguments', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
          '--round',
          '31089009',
        ])
      ).toThrow(
        'Duplicate argument: --round.'
      );
    });

    it('rejects round zero', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '0',
        ])
      ).toThrow(
        'Round must be greater than zero.'
      );
    });

    it('rejects a round larger than uint64', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          ABOVE_MAX_UINT64,
        ])
      ).toThrow(
        'Round must fit in uint64.'
      );
    });

    it('rejects an empty round', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '',
        ])
      ).toThrow(
        'Round must be a positive decimal integer.'
      );
    });

    it('rejects a negative round', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '-1',
        ])
      ).toThrow(
        'Round must be a positive decimal integer.'
      );
    });

    it('rejects a hexadecimal round', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '0x1234',
        ])
      ).toThrow(
        'Round must be a positive decimal integer.'
      );
    });

    it('rejects a fractional round', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '123.5',
        ])
      ).toThrow(
        'Round must be a positive decimal integer.'
      );
    });

    it('rejects a non-numeric round', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '123abc',
        ])
      ).toThrow(
        'Round must be a positive decimal integer.'
      );
    });

    it('rejects a round with surrounding whitespace', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          ' 123 ',
        ])
      ).toThrow(
        'Round must be a positive decimal integer.'
      );
    });

    it('rejects an unsupported network preset', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'unsupported-network',
          '--round',
          '31089008',
        ])
      ).toThrow(
        'Unsupported network preset: unsupported-network. Supported presets: robinhood-testnet'
      );
    });

    it('rejects an unknown import argument', () => {
      expect(() =>
        parseCommandArguments([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
          '--unknown',
        ])
      ).toThrow(
        'Unknown import argument: --unknown.'
      );
    });
  });

  describe('import-when-available', () => {
    it('parses an import-when-available command with a network preset', () => {
      expect(
        parseCommandArguments([
          'import-when-available',
          '--network',
          'robinhood-testnet',
          '--round',
          '31192648',
        ])
      ).toEqual({
        command:
          'import-when-available',
        source: {
          type: 'preset',
          network:
            'robinhood-testnet',
        },
        round: 31_192_648n,
      });
    });

    it('parses an import-when-available command with a custom network config', () => {
      expect(
        parseCommandArguments([
          'import-when-available',
          '--network-config',
          './networks/example-mainnet.json',
          '--round',
          '31192648',
        ])
      ).toEqual({
        command:
          'import-when-available',
        source: {
          type: 'custom',
          configFile:
            './networks/example-mainnet.json',
        },
        round: 31_192_648n,
      });
    });

    it('accepts options in either order', () => {
      expect(
        parseCommandArguments([
          'import-when-available',
          '--round',
          '31192648',
          '--network',
          'robinhood-testnet',
        ])
      ).toEqual({
        command:
          'import-when-available',
        source: {
          type: 'preset',
          network:
            'robinhood-testnet',
        },
        round: 31_192_648n,
      });
    });

    it('rejects a missing network source', () => {
      expect(() =>
        parseCommandArguments([
          'import-when-available',
          '--round',
          '31192648',
        ])
      ).toThrow(
        'Missing required argument: --network or --network-config.'
      );
    });

    it('rejects a missing round', () => {
      expect(() =>
        parseCommandArguments([
          'import-when-available',
          '--network',
          'robinhood-testnet',
        ])
      ).toThrow(
        'Missing required argument: --round.'
      );
    });

    it('rejects an unknown import-when-available argument', () => {
      expect(() =>
        parseCommandArguments([
          'import-when-available',
          '--network',
          'robinhood-testnet',
          '--round',
          '31192648',
          '--unknown',
        ])
      ).toThrow(
        'Unknown import-when-available argument: --unknown.'
      );
    });
  });

  describe('daemon', () => {
    it('parses a daemon command with a network preset', () => {
      expect(
        parseCommandArguments([
          'daemon',
          '--network',
          'robinhood-testnet',
        ])
      ).toEqual({
        command: 'daemon',
        source: {
          type: 'preset',
          network:
            'robinhood-testnet',
        },
      });
    });

    it('parses a daemon command with a custom network config', () => {
      expect(
        parseCommandArguments([
          'daemon',
          '--network-config',
          './networks/example-mainnet.json',
        ])
      ).toEqual({
        command: 'daemon',
        source: {
          type: 'custom',
          configFile:
            './networks/example-mainnet.json',
        },
      });
    });

    it('returns daemon help for --help', () => {
      expect(
        parseCommandArguments([
          'daemon',
          '--help',
        ])
      ).toEqual({
        command: 'daemon-help',
      });
    });

    it('returns daemon help for -h', () => {
      expect(
        parseCommandArguments([
          'daemon',
          '-h',
        ])
      ).toEqual({
        command: 'daemon-help',
      });
    });

    it('rejects a daemon command with no network source', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
        ])
      ).toThrow(
        'Missing required argument: --network or --network-config.'
      );
    });

    it('rejects a missing daemon network value', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network',
        ])
      ).toThrow(
        'Missing value for --network.'
      );
    });

    it('rejects a missing daemon network config value', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network-config',
        ])
      ).toThrow(
        'Missing value for --network-config.'
      );
    });

    it('rejects duplicate daemon network arguments', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network',
          'robinhood-testnet',
          '--network',
          'robinhood-testnet',
        ])
      ).toThrow(
        'Duplicate argument: --network.'
      );
    });

    it('rejects duplicate daemon network config arguments', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network-config',
          './networks/example-mainnet.json',
          '--network-config',
          './networks/other-mainnet.json',
        ])
      ).toThrow(
        'Duplicate argument: --network-config.'
      );
    });

    it('rejects a daemon network preset with a custom network config', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network',
          'robinhood-testnet',
          '--network-config',
          './networks/example-mainnet.json',
        ])
      ).toThrow(
        'Arguments --network and --network-config are mutually exclusive.'
      );
    });

    it('rejects an unsupported daemon network preset', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network',
          'unsupported-network',
        ])
      ).toThrow(
        'Unsupported network preset: unsupported-network. Supported presets: robinhood-testnet'
      );
    });

    it('rejects an unknown daemon argument', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network',
          'robinhood-testnet',
          '--unknown',
        ])
      ).toThrow(
        'Unknown daemon argument: --unknown.'
      );
    });

    it('rejects --round because the daemon does not select a round', () => {
      expect(() =>
        parseCommandArguments([
          'daemon',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ])
      ).toThrow(
        'Unknown daemon argument: --round.'
      );
    });
  });

  it('rejects an unknown command', () => {
    expect(() =>
      parseCommandArguments([
        'unknown',
      ])
    ).toThrow(
      'Unknown command: unknown.'
    );
  });
});

describe('main daemon command', () => {
  beforeEach(() => {
    vi.mocked(
      runDaemonCommand,
    ).mockReset();

    vi.mocked(
      runDaemonCommand,
    ).mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the daemon for the selected network preset', async () => {
    await main([
      'daemon',
      '--network',
      'robinhood-testnet',
    ]);

    expect(
      runDaemonCommand,
    ).toHaveBeenCalledOnce();

    const call =
      vi.mocked(
        runDaemonCommand,
      ).mock.calls[0];

    if (call === undefined) {
      throw new Error(
        'Expected runDaemonCommand to be called.'
      );
    }

    const options = call[0];

    expect(
      options.source,
    ).toEqual({
      type: 'preset',
      network:
        'robinhood-testnet',
    });

    expect(
      options.signal,
    ).toBeInstanceOf(
      AbortSignal
    );

    expect(
      options.signal?.aborted,
    ).toBe(
      false
    );
  });

  it('runs the daemon for a custom network config', async () => {
    await main([
      'daemon',
      '--network-config',
      './networks/example-mainnet.json',
    ]);

    expect(
      runDaemonCommand,
    ).toHaveBeenCalledOnce();

    const call =
      vi.mocked(
        runDaemonCommand,
      ).mock.calls[0];

    if (call === undefined) {
      throw new Error(
        'Expected runDaemonCommand to be called.'
      );
    }

    const options = call[0];

    expect(
      options.source,
    ).toEqual({
      type: 'custom',
      configFile:
        './networks/example-mainnet.json',
    });

    expect(
      options.signal,
    ).toBeInstanceOf(
      AbortSignal
    );

    expect(
      options.signal?.aborted,
    ).toBe(
      false
    );
  });

  it('accepts the pnpm argument separator', async () => {
    await main([
      '--',
      'daemon',
      '--network',
      'robinhood-testnet',
    ]);

    expect(
      runDaemonCommand,
    ).toHaveBeenCalledOnce();
  });

  it('aborts the daemon on SIGINT', async () => {
    const listenerCountBefore =
      process.listenerCount('SIGINT');

    vi.mocked(
      runDaemonCommand,
    ).mockImplementation(
      async (options) => {
        expect(
          options.signal?.aborted,
        ).toBe(
          false
        );

        expect(
          process.listenerCount(
            'SIGINT',
          )
        ).toBe(
          listenerCountBefore + 1
        );

        const listeners =
          process.listeners(
            'SIGINT',
          );

        const listener =
          listeners[
            listeners.length - 1
          ];

        if (listener === undefined) {
          throw new Error(
            'Expected SIGINT listener.'
          );
        }

        listener(
          'SIGINT',
        );

        expect(
          options.signal?.aborted,
        ).toBe(
          true
        );
      },
    );

    await main([
      'daemon',
      '--network',
      'robinhood-testnet',
    ]);

    expect(
      process.listenerCount(
        'SIGINT',
      )
    ).toBe(
      listenerCountBefore
    );
  });

  it('continues handling repeated SIGINT while the daemon is shutting down', async () => {
    const listenerCountBefore = process.listenerCount('SIGINT');

    vi.mocked(
      runDaemonCommand,
    ).mockImplementation(
      async (options) => {
        const listeners =
          process.listeners('SIGINT');

        const listener =
          listeners[
            listeners.length - 1
          ];

        if (listener === undefined) {
          throw new Error(
            'Expected SIGINT listener.'
          );
        }

        listener('SIGINT');

        expect(
          options.signal?.aborted,
        ).toBe(
          true
        );

        expect(
          process.listenerCount('SIGINT'),
        ).toBe(
          listenerCountBefore + 1
        );

        listener('SIGINT');

        expect(
          options.signal?.aborted,
        ).toBe(
          true
        );

        expect(
          process.listenerCount('SIGINT'),
        ).toBe(
          listenerCountBefore + 1
        );
      }
    );

    await main([
      'daemon',
      '--network',
      'robinhood-testnet',
    ]);

    expect(
      process.listenerCount('SIGINT'),
    ).toBe(
      listenerCountBefore
    );
  });

  it('aborts the daemon on SIGTERM', async () => {
    const listenerCountBefore =
      process.listenerCount(
        'SIGTERM',
      );

    vi.mocked(
      runDaemonCommand,
    ).mockImplementation(
      async (options) => {
        expect(
          options.signal?.aborted,
        ).toBe(
          false
        );

        expect(
          process.listenerCount(
            'SIGTERM',
          )
        ).toBe(
          listenerCountBefore + 1
        );

        const listeners =
          process.listeners(
            'SIGTERM',
          );

        const listener =
          listeners[
            listeners.length - 1
          ];

        if (listener === undefined) {
          throw new Error(
            'Expected SIGTERM listener.'
          );
        }

        listener(
          'SIGTERM',
        );

        expect(
          options.signal?.aborted,
        ).toBe(
          true
        );
      },
    );

    await main([
      'daemon',
      '--network',
      'robinhood-testnet',
    ]);

    expect(
      process.listenerCount(
        'SIGTERM',
      )
    ).toBe(
      listenerCountBefore
    );
  });

  it('removes signal listeners after the daemon exits', async () => {
    const sigintCountBefore =
      process.listenerCount(
        'SIGINT',
      );

    const sigtermCountBefore =
      process.listenerCount(
        'SIGTERM',
      );

    await main([
      'daemon',
      '--network',
      'robinhood-testnet',
    ]);

    expect(
      process.listenerCount(
        'SIGINT',
      )
    ).toBe(
      sigintCountBefore
    );

    expect(
      process.listenerCount(
        'SIGTERM',
      )
    ).toBe(
      sigtermCountBefore
    );
  });

  it('removes signal listeners when the daemon fails', async () => {
    const failure =
      new Error(
        'Daemon failed.',
      );

    const sigintCountBefore =
      process.listenerCount(
        'SIGINT',
      );

    const sigtermCountBefore =
      process.listenerCount(
        'SIGTERM',
      );

    vi.mocked(
      runDaemonCommand,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      main([
        'daemon',
        '--network',
        'robinhood-testnet',
      ])
    ).rejects.toBe(
      failure
    );

    expect(
      process.listenerCount(
        'SIGINT',
      )
    ).toBe(
      sigintCountBefore
    );

    expect(
      process.listenerCount(
        'SIGTERM',
      )
    ).toBe(
      sigtermCountBefore
    );
  });

  it('propagates daemon failures', async () => {
    const failure =
      new Error(
        'Daemon failed.',
      );

    vi.mocked(
      runDaemonCommand,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      main([
        'daemon',
        '--network',
        'robinhood-testnet',
      ])
    ).rejects.toBe(
      failure
    );
  });

  it('prints daemon help without starting the daemon', async () => {
    const consoleLog =
      vi.spyOn(
        console,
        'log'
      ).mockImplementation(
        () => {}
      );

    await main([
      'daemon',
      '--help',
    ]);

    expect(
      runDaemonCommand,
    ).not.toHaveBeenCalled();

    expect(
      consoleLog,
    ).toHaveBeenCalledOnce();

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'relayer daemon --network <preset>'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'relayer daemon --network-config <file>'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'QUICKNET_CONSUMERS'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'QUICKNET_START_BLOCK'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'QUICKNET_CHECKPOINT_FILE'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'QUICKNET_RPC_URL'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'QUICKNET_MAX_BLOCK_RANGE'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'QUICKNET_POLL_INTERVAL_MS'
      )
    );
  });

  it('includes the daemon in top-level help', async () => {
    const consoleLog =
      vi.spyOn(
        console,
        'log'
      ).mockImplementation(
        () => {}
      );

    await main([]);

    expect(
      runDaemonCommand,
    ).not.toHaveBeenCalled();

    expect(
      consoleLog,
    ).toHaveBeenCalledOnce();

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'daemon                 Watch configured consumers and relay requested rounds.'
      )
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        '--network-config <file>'
      )
    );
  });
});