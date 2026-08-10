import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  parseCliArgs,
} from '../src/cli.js';

const IMPORT_COMMANDS = [
  'import',
  'import-when-available',
] as const;

describe('parseCliArgs', () => {
  describe('help', () => {
    it('shows help when no arguments are provided', () => {
      expect(
        parseCliArgs([]),
      ).toEqual({
        kind: 'help',
      });
    });

    it('shows help for --help', () => {
      expect(
        parseCliArgs([
          '--help',
        ]),
      ).toEqual({
        kind: 'help',
      });
    });

    it('shows help for -h', () => {
      expect(
        parseCliArgs([
          '-h',
        ]),
      ).toEqual({
        kind: 'help',
      });
    });

    it('shows help for the help command', () => {
      expect(
        parseCliArgs([
          'help',
        ]),
      ).toEqual({
        kind: 'help',
      });
    });

    for (
      const command of
      IMPORT_COMMANDS
    ) {
      it(`shows help for ${command} --help`, () => {
        expect(
          parseCliArgs([
            command,
            '--help',
          ]),
        ).toEqual({
          kind: 'help',
        });
      });

      it(`shows help for ${command} -h`, () => {
        expect(
          parseCliArgs([
            command,
            '-h',
          ]),
        ).toEqual({
          kind: 'help',
        });
      });
    }
  });

  describe('leading -- separator', () => {
    it('accepts a leading -- separator', () => {
      expect(
        parseCliArgs([
          '--',
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ]),
      ).toEqual({
        kind: 'import',
        network: 'robinhood-testnet',
        round: 31_089_008n,
      });
    });

    it('accepts a leading -- separator for import-when-available', () => {
      expect(
        parseCliArgs([
          '--',
          'import-when-available',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ]),
      ).toEqual({
        kind: 'import-when-available',
        network: 'robinhood-testnet',
        round: 31_089_008n,
      });
    });
  });

  describe('import', () => {
    it('parses a valid import command', () => {
      expect(
        parseCliArgs([
          'import',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ]),
      ).toEqual({
        kind: 'import',
        network: 'robinhood-testnet',
        round: 31_089_008n,
      });
    });

    it('allows options in either order', () => {
      expect(
        parseCliArgs([
          'import',
          '--round',
          '31089008',
          '--network',
          'robinhood-testnet',
        ]),
      ).toEqual({
        kind: 'import',
        network: 'robinhood-testnet',
        round: 31_089_008n,
      });
    });
  });

  describe(
    'import-when-available',
    () => {
      it('parses a valid command', () => {
        expect(
          parseCliArgs([
            'import-when-available',
            '--network',
            'robinhood-testnet',
            '--round',
            '31089008',
          ]),
        ).toEqual({
          kind: 'import-when-available',
          network: 'robinhood-testnet',
          round: 31_089_008n,
        });
      });

      it('allows options in either order', () => {
        expect(
          parseCliArgs([
            'import-when-available',
            '--round',
            '31089008',
            '--network',
            'robinhood-testnet',
          ]),
        ).toEqual({
          kind: 'import-when-available',
          network: 'robinhood-testnet',
          round: 31_089_008n,
        });
      });
    },
  );

  describe('commands', () => {
    it('rejects an unknown command', () => {
      expect(() =>
        parseCliArgs([
          'something',
        ]),
      ).toThrow('Unknown command: something');
    });
  });

  describe.each(
    IMPORT_COMMANDS,
  )('%s options', (command) => {
    it('requires --network', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--round',
          '31089008',
        ]),
      ).toThrow('Missing required option: --network');
    });

    it('requires --round', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
        ]),
      ).toThrow('Missing required option: --round');
    });

    it('rejects a missing --network value', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
        ]),
      ).toThrow('Missing value for --network');
    });

    it('rejects a missing --round value', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
        ]),
      ).toThrow('Missing value for --round');
    });

    it('rejects another option as the --network value', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          '--round',
          '31089008',
        ]),
      ).toThrow('Missing value for --network');
    });

    it('rejects another option as the --round value', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--round',
          '--network',
          'robinhood-testnet',
        ]),
      ).toThrow('Missing value for --round');
    });

    it('rejects duplicate --network options', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
        ]),
      ).toThrow('Option --network may only be specified once.');
    });

    it('rejects duplicate --round options', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
          '--round',
          '31089009',
        ]),
      ).toThrow('Option --round may only be specified once.');
    });

    it('rejects an unknown option', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008',
          '--unknown',
        ]),
      ).toThrow('Unknown option: --unknown');
    });

    it('rejects an unsupported network', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'not-a-network',
          '--round',
          '31089008',
        ]),
      ).toThrow('Unsupported network: not-a-network.');
    });

    it('rejects round zero', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '0',
        ]),
      ).toThrow('Quicknet round must be greater than zero.');
    });

    it('rejects a negative round', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '-1',
        ]),
      ).toThrow('Invalid Quicknet round: -1');
    });

    it('rejects a hexadecimal round', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '0x1234',
        ]),
      ).toThrow('Invalid Quicknet round: 0x1234');
    });

    it('rejects a fractional round', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '123.5',
        ]),
      ).toThrow('Invalid Quicknet round: 123.5');
    });

    it('rejects a round containing non-numeric characters', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '31089008abc',
        ]),
      ).toThrow('Invalid Quicknet round: 31089008abc');
    });

    it('accepts the maximum uint64 round', () => {
      expect(
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '18446744073709551615',
        ]),
      ).toEqual({
        kind: command,
        network: 'robinhood-testnet',
        round: 18_446_744_073_709_551_615n,
      });
    });

    it('rejects a round larger than uint64', () => {
      expect(() =>
        parseCliArgs([
          command,
          '--network',
          'robinhood-testnet',
          '--round',
          '18446744073709551616',
        ]),
      ).toThrow('Quicknet round must fit within uint64.');
    });
  });
});