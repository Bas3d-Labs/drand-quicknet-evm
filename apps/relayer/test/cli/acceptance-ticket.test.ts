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
  decodeAcceptanceTicket,
  ticketForOutcome,
} from '../../src/state/acceptance-ticket.js';

import {
  parseCommandArguments,
} from '../../src/cli/parse-command-arguments.js';

import {
  readAcceptanceTicket,
} from '../../src/cli/read-acceptance-ticket.js';

import {
  journalJson,
} from '../../src/state/journal-ledger-validation.js';

import {
  ATTEMPT_ID,
  IDENTITY,
} from '../helpers/operator-attribution-fixture.js';

import {
  maximumAcceptedOutcome,
} from '../helpers/operator-acceptance-fixture.js';

function ticketJson() {
  return journalJson(ticketForOutcome(IDENTITY, maximumAcceptedOutcome(0, 1n)));
}

describe('acceptance ticket codec', () => {
  it('round-trips a detached frozen ticket with decimal integers', () => {
    const json = ticketJson();

    const result = decodeAcceptanceTicket(json);

    expect(journalJson(result)).toBe(json);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.durable.anchor)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
  });

  it.each([
    'version',
    'kind',
    'identity',
    'requestId',
    'snapshotDigest',
    'proposalDigest',
    'operator',
    'at',
    'attemptId',
    'durable',
    'finality',
  ])('rejects missing %s with a fixed error', (field) => {
    const raw = JSON.parse(ticketJson());

    delete raw[field];

    expect(() => decodeAcceptanceTicket(JSON.stringify(raw)))
      .toThrow('Invalid operator acceptance ticket.');
  });

  it.each([
    'root-extra',
    'identity-extra',
    'durable-extra',
    'anchor-extra',
    'finality-extra',
    'numeric-nonce',
    'leading-zero',
    'overflow',
    'uppercase-hash',
    'wrong-kind',
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
        raw.proposalDigest = `0x${'AB'.repeat(32)}`;
        break;
      case 'wrong-kind':
        raw.kind = 'operator-attributed';
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

    expect(() => decodeAcceptanceTicket(json)).toThrow('Invalid operator acceptance ticket.');
  });

  it('rejects symlinks, invalid UTF-8 and oversized ticket files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acceptance-ticket-'));

    const path = join(directory, 'ticket.json');

    try {
      await writeFile(path, ticketJson());
      expect(await readAcceptanceTicket(path)).toEqual(decodeAcceptanceTicket(ticketJson()));

      await symlink(path, join(directory, 'link'));
      await expect(readAcceptanceTicket(join(directory, 'link')))
        .rejects.toThrow('Invalid operator acceptance ticket file.');

      await writeFile(path, Buffer.from([0xff]));
      await expect(readAcceptanceTicket(path))
        .rejects.toThrow('Invalid operator acceptance ticket file.');

      await writeFile(path, 'x'.repeat(4097));
      await expect(readAcceptanceTicket(path))
        .rejects.toThrow('Invalid operator acceptance ticket file.');
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });
});

describe('acceptance command arguments', () => {
  const base = [
    'accept-unattributed',
    '--network', 'robinhood-testnet',
    '--attempt-id', ATTEMPT_ID,
    '--operator', 'operator',
  ];

  it('defaults to dry-run', () => {
    expect(parseCommandArguments(base)).toEqual({
      command: 'accept-unattributed',
      mode: 'dry-run',
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      attemptId: ATTEMPT_ID,
      operator: 'operator',
    });

    expect(parseCommandArguments([...base, '--dry-run'])).toMatchObject({
      mode: 'dry-run',
    });
  });

  it('accepts only a ticket and one network for apply', () => {
    expect(parseCommandArguments([
      'accept-unattributed',
      '--network-config', 'network.json',
      '--apply',
      '--ticket', 'ticket.json',
    ])).toEqual({
      command: 'accept-unattributed',
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

  it.each(['--attempt-id', '--operator', '--network'])('requires %s in dry-run', (flag) => {
    const index = base.indexOf(flag);

    const args = base.slice();

    args.splice(index, 2);
    expect(() => parseCommandArguments(args)).toThrow();
  });
});
