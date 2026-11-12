import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  decodeAttributionTicket,
  ticketForOutcome,
} from '../../src/state/attribution-ticket.js';

import {
  parseCommandArguments,
} from '../../src/cli/parse-command-arguments.js';

import {
  readAttributionTicket,
} from '../../src/cli/read-attribution-ticket.js';

import {
  journalJson,
} from '../../src/state/journal-ledger-validation.js';

import {
  ATTEMPT_ID,
  HINT_HASH,
  IDENTITY,
} from '../helpers/operator-attribution-fixture.js';

import {
  maximumOutcome,
} from '../helpers/operator-outcome-fixture.js';

function ticketJson() {
  return journalJson(ticketForOutcome(IDENTITY, maximumOutcome(0, 1n)));
}

describe('attribution ticket codec', () => {
  it('round-trips a detached frozen ticket with decimal integers', () => {
    const json = ticketJson();

    const result = decodeAttributionTicket(json);

    expect(journalJson(result)).toBe(json);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.durable.anchor)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
  });

  it.each([
    'version',
    'identity',
    'requestId',
    'snapshotDigest',
    'proposalDigest',
    'operator',
    'at',
    'attemptId',
    'hintHash',
    'inclusion',
    'durable',
    'finality',
  ])('rejects missing %s with a fixed error', (field) => {
    const raw = JSON.parse(ticketJson());

    delete raw[field];

    expect(() => decodeAttributionTicket(JSON.stringify(raw)))
      .toThrow('Invalid operator attribution ticket.');
  });

  it.each([
    'root-extra',
    'identity-extra',
    'inclusion-extra',
    'durable-extra',
    'anchor-extra',
    'finality-extra',
    'numeric-nonce',
    'leading-zero',
    'overflow',
    'uppercase-hash',
    'above-durable',
    'wrong-version',
    'bad-finality',
    'bad-time',
    'control-character',
    'malformed-json',
    'oversized',
  ])('rejects %s without echoing input', (fault) => {
    const raw = JSON.parse(ticketJson());

    switch (fault) {
      case 'root-extra':
        raw.signedTransaction = 'secret';
        break;
      case 'identity-extra':
        raw.identity.extra = 'secret';
        break;
      case 'inclusion-extra':
        raw.inclusion.extra = 'secret';
        break;
      case 'durable-extra':
        raw.durable.extra = 'secret';
        break;
      case 'anchor-extra':
        raw.durable.anchor.extra = 'secret';
        break;
      case 'finality-extra':
        raw.finality.extra = 'secret';
        break;
      case 'numeric-nonce':
        raw.durable.nonce = 2;
        break;
      case 'leading-zero':
        raw.durable.nonce = '02';
        break;
      case 'overflow':
        raw.durable.nonce = (1n << 256n).toString();
        break;
      case 'uppercase-hash':
        raw.hintHash = `0x${'AB'.repeat(32)}`;
        break;
      case 'above-durable':
        raw.inclusion.blockNumber = (BigInt(raw.durable.anchor.blockNumber) + 1n).toString();
        break;
      case 'wrong-version':
        raw.version = 2;
        break;
      case 'bad-finality':
        raw.finality = {
          type: 'latest',
        };
        break;
      case 'bad-time':
        raw.at = 'not a timestamp';
        break;
      case 'control-character':
        raw.operator = 'bad\noperator';
        break;
    }

    let json = JSON.stringify(raw);

    if (fault === 'malformed-json') {
      json = 'secret';
    }

    if (fault === 'oversized') {
      json = ' '.repeat(4097);
    }

    expect(() => decodeAttributionTicket(json)).toThrow('Invalid operator attribution ticket.');
  });

  it('reads a regular bounded file and rejects symlinks, invalid UTF-8 and oversized input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attribution-ticket-'));

    const path = join(directory, 'ticket.json');

    try {
      await writeFile(path, ticketJson());
      expect(await readAttributionTicket(path)).toEqual(decodeAttributionTicket(ticketJson()));

      await symlink(path, join(directory, 'link'));
      await expect(readAttributionTicket(join(directory, 'link'))).rejects.toThrow('Invalid operator attribution ticket file.');

      await writeFile(path, Buffer.from([0xff]));
      await expect(readAttributionTicket(path)).rejects.toThrow('Invalid operator attribution ticket file.');

      await writeFile(path, 'x'.repeat(4097));
      await expect(readAttributionTicket(path)).rejects.toThrow('Invalid operator attribution ticket file.');
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });
});

describe('attribution command arguments', () => {
  const base = [
    'attribute-transaction',
    '--network', 'robinhood-testnet',
    '--attempt-id', ATTEMPT_ID,
    '--tx-hash', HINT_HASH,
    '--operator', 'operator',
  ];

  it('defaults to dry-run and supports an explicit height', () => {
    expect(parseCommandArguments([...base, '--block-number', '101'])).toEqual({
      command: 'attribute-transaction',
      mode: 'dry-run',
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      attemptId: ATTEMPT_ID,
      transactionHash: HINT_HASH,
      operator: 'operator',
      blockNumber: 101n,
    });

    expect(parseCommandArguments([...base, '--dry-run'])).toMatchObject({
      mode: 'dry-run',
    });
  });

  it('accepts only a ticket and one network for apply', () => {
    expect(parseCommandArguments([
      'attribute-transaction',
      '--network-config', 'network.json',
      '--apply',
      '--ticket', 'ticket.json',
    ])).toEqual({
      command: 'attribute-transaction',
      mode: 'apply',
      source: {
        type: 'custom',
        configFile: 'network.json',
      },
      ticketPath: 'ticket.json',
    });
  });

  it.each([
    ['--apply'],
    ['--apply', '--ticket', 'ticket.json'],
    ['--ticket', 'ticket.json'],
    ['--force'],
    ['--operator', 'another'],
    ['--block-number'],
    ['--block-number', '--dry-run'],
    ['--block-number', '-1'],
    ['--block-number', (1n << 256n).toString()],
    ['--network-config', 'network.json'],
    ['--dry-run', '--dry-run'],
  ])('rejects conflicting, missing, duplicate or unknown options: %j', (...extra) => {
    expect(() => parseCommandArguments([...base, ...extra])).toThrow();
  });

  it.each(['--attempt-id', '--tx-hash', '--operator', '--network'])('requires %s in dry-run', (flag) => {
    const index = base.indexOf(flag);

    const args = base.slice();

    args.splice(index, 2);
    expect(() => parseCommandArguments(args)).toThrow();
  });
});
