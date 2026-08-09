import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  parseCliArgs,
} from '../src/cli.js';

describe('parseCliArgs', () => {
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

  it('allows import options in either order', () => {
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

  it('shows help when --help follows import', () => {
    expect(
      parseCliArgs([
        'import',
        '--help',
      ]),
    ).toEqual({
      kind: 'help',
    });
  });

  it('shows help when -h follows import', () => {
    expect(
      parseCliArgs([
        'import',
        '-h',
      ]),
    ).toEqual({
      kind: 'help',
    });
  });

  it('rejects an unknown command', () => {
    expect(() =>
      parseCliArgs([
        'something',
      ]),
    ).toThrow(
      'Unknown command: something',
    );
  });

  it('requires --network', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--round',
        '31089008',
      ]),
    ).toThrow(
      'Missing required option: --network',
    );
  });

  it('requires --round', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
      ]),
    ).toThrow(
      'Missing required option: --round',
    );
  });

  it('rejects a missing --network value', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
      ]),
    ).toThrow(
      'Missing value for --network',
    );
  });

  it('rejects a missing --round value', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
      ]),
    ).toThrow(
      'Missing value for --round',
    );
  });

  it('rejects another option as the --network value', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        '--round',
        '31089008',
      ]),
    ).toThrow(
      'Missing value for --network',
    );
  });

  it('rejects another option as the --round value', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--round',
        '--network',
        'robinhood-testnet',
      ]),
    ).toThrow(
      'Missing value for --round',
    );
  });

  it('rejects duplicate --network options', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--network',
        'robinhood-testnet',
        '--round',
        '31089008',
      ]),
    ).toThrow(
      'Option --network may only be specified once.',
    );
  });

  it('rejects duplicate --round options', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        '31089008',
        '--round',
        '31089009',
      ]),
    ).toThrow(
      'Option --round may only be specified once.',
    );
  });

  it('rejects an unknown option', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        '31089008',
        '--unknown',
      ]),
    ).toThrow(
      'Unknown option: --unknown',
    );
  });

  it('rejects an unsupported network', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'not-a-network',
        '--round',
        '31089008',
      ]),
    ).toThrow();
  });

  it('rejects round zero', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        '0',
      ]),
    ).toThrow(
      'Quicknet round must be greater than zero.',
    );
  });

  it('rejects a negative round', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        '-1',
      ]),
    ).toThrow(
      'Invalid Quicknet round: -1',
    );
  });

  it('rejects a hexadecimal round', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        '0x1234',
      ]),
    ).toThrow(
      'Invalid Quicknet round: 0x1234',
    );
  });

  it('rejects a decimal round', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        '123.5',
      ]),
    ).toThrow(
      'Invalid Quicknet round: 123.5',
    );
  });

  it('rejects a round containing non-numeric characters', () => {
    expect(() =>
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        '31089008abc',
      ]),
    ).toThrow(
      'Invalid Quicknet round: 31089008abc',
    );
  });

  it('supports arbitrarily large positive bigint rounds', () => {
    const round =
      '18446744073709551615';

    expect(
      parseCliArgs([
        'import',
        '--network',
        'robinhood-testnet',
        '--round',
        round,
      ]),
    ).toEqual({
      kind: 'import',
      network: 'robinhood-testnet',
      round:
        18_446_744_073_709_551_615n,
    });
  });
});