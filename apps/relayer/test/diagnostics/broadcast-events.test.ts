import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  RpcRequestError,
} from 'viem';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

describe('broadcast events', () => {
  function captureBroadcastLog() {
    const lines: string[] = [];

    const log = createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    const identity = {
      signer: `0x${'11'.repeat(20)}` as const,
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: `0x${'aa'.repeat(32)}` as const,
      nonce: 4n,
    };

    return { lines, log, identity };
  }

  it('emits request-error for a caught undefined value', () => {
    const lines: string[] = [];

    const log = createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    const identity = {
      signer: `0x${'11'.repeat(20)}` as const,
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: `0x${'aa'.repeat(32)}` as const,
      nonce: 4n,
    };

    log.attemptBroadcastNotAcknowledged({
      ...identity,
      observation: 'request-error',
      error: undefined,
    });

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record).toMatchObject({
      ...identity,
      nonce: '4',
      level: 30,
      event: 'attempt_broadcast_not_acknowledged',
      observation: 'request-error',
      msg: 'Broadcast acknowledgement not established. Reconciliation is required',
      err: {
        name: 'UnknownError',
        message: 'Operation failed; details redacted.',
      },
    });

    expect(record).not.toHaveProperty('error');
    expect(record).not.toHaveProperty('returnedTransactionHash');
  });

  it('emits invalid-response without an error or returned hash', () => {
    const lines: string[] = [];

    const log = createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    log.attemptBroadcastNotAcknowledged({
      signer: `0x${'11'.repeat(20)}`,
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: `0x${'aa'.repeat(32)}`,
      nonce: 4n,
      observation: 'invalid-response',
    });

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record).toMatchObject({
      level: 30,
      event: 'attempt_broadcast_not_acknowledged',
      observation: 'invalid-response',
      transactionHash: `0x${'aa'.repeat(32)}`,
      nonce: '4',
    });

    expect(record).not.toHaveProperty('err');
    expect(record).not.toHaveProperty('error');
    expect(record).not.toHaveProperty('returnedTransactionHash');
  });

  it('emits hash-mismatch with the local and returned hashes', () => {
    const lines: string[] = [];

    const log = createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    const transactionHash = `0x${'aa'.repeat(32)}` as const;
    const returnedTransactionHash = `0x${'bb'.repeat(32)}` as const;

    log.attemptBroadcastNotAcknowledged({
      signer: `0x${'11'.repeat(20)}`,
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash,
      nonce: 4n,
      observation: 'hash-mismatch',
      returnedTransactionHash,
    });

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record).toMatchObject({
      level: 30,
      event: 'attempt_broadcast_not_acknowledged',
      observation: 'hash-mismatch',
      transactionHash,
      returnedTransactionHash,
      nonce: '4',
    });

    expect(record).not.toHaveProperty('err');
    expect(record).not.toHaveProperty('error');
  });

  it('rejects hash-mismatch when the hashes differ only in casing', () => {
    const lines: string[] = [];

    const log = createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    });

    log.attemptBroadcastNotAcknowledged({
      signer: `0x${'11'.repeat(20)}`,
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: `0x${'ab'.repeat(32)}`,
      nonce: 4n,
      observation: 'hash-mismatch',
      returnedTransactionHash: `0x${'AB'.repeat(32)}`,
    });

    expect(lines).toHaveLength(0);
  });

  it('emits an accepted broadcast without claiming inclusion', () => {
    const { lines, log, identity } = captureBroadcastLog();

    log.attemptBroadcastAccepted(identity);

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record).toMatchObject({
      ...identity,
      nonce: '4',
      level: 30,
      event: 'attempt_broadcast_accepted',
      msg: 'Broadcast acknowledged by RPC. Inclusion is not established',
    });

    expect(record).not.toHaveProperty('err');
    expect(record).not.toHaveProperty('observation');
    expect(record).not.toHaveProperty('returnedTransactionHash');
  });

  it('summarizes request errors under the attempt-scoped policy', () => {
    const { lines, log, identity } = captureBroadcastLog();
    const secret = 'broadcast-diagnostic-canary';
    const inspected: string[] = [];

    const scoped = log.withErrorSummary({
      scrubText(text) {
        inspected.push(text);

        return {
          text: text.replaceAll(secret, '[redacted]'),
          removed: text.includes(secret),
        };
      },
    });

    const error = new RpcRequestError({
      body: {
        method: 'eth_sendRawTransaction',
        params: [secret],
      },
      error: {
        code: -32000,
        message: `Node response containing ${secret}`,
      },
      url: 'https://rpc.example.test',
    });

    scoped.attemptBroadcastNotAcknowledged({
      ...identity,
      observation: 'request-error',
      error,
    });

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record).toMatchObject({
      ...identity,
      nonce: '4',
      level: 30,
      event: 'attempt_broadcast_not_acknowledged',
      observation: 'request-error',
      err: {
        code: -32000,
      },
    });

    expect(inspected.some((text) => text.includes(secret))).toBe(true);
    expect(lines[0]).not.toContain(secret);
    expect(record).not.toHaveProperty('error');
    expect(record).not.toHaveProperty('returnedTransactionHash');
  });

  it.each([
    {
      label: 'error on invalid-response',
      fields: {
        observation: 'invalid-response',
        error: undefined,
      },
    },
    {
      label: 'returned hash on invalid-response',
      fields: {
        observation: 'invalid-response',
        returnedTransactionHash: undefined,
      },
    },
    {
      label: 'returned hash on request-error',
      fields: {
        observation: 'request-error',
        error: new Error('Request failed'),
        returnedTransactionHash: undefined,
      },
    },
    {
      label: 'error on hash-mismatch',
      fields: {
        observation: 'hash-mismatch',
        returnedTransactionHash: `0x${'bb'.repeat(32)}`,
        error: undefined,
      },
    },
    {
      label: 'missing error on request-error',
      fields: {
        observation: 'request-error',
      },
    },
    {
      label: 'missing returned hash on hash-mismatch',
      fields: {
        observation: 'hash-mismatch',
      },
    },
    {
      label: 'malformed returned hash',
      fields: {
        observation: 'hash-mismatch',
        returnedTransactionHash: '0x1234',
      },
    },
    {
      label: 'unknown observation',
      fields: {
        observation: 'unexpected',
      },
    },
    {
      label: 'non-string observation',
      fields: {
        observation: 42,
      },
    },
  ])('rejects $label', ({ fields }) => {
    const { lines, log, identity } = captureBroadcastLog();

    // Exercise the runtime boundary with inputs TypeScript rejects.
    const input = {
      ...identity,
      ...fields,
    } as unknown as Parameters<
      typeof log.attemptBroadcastNotAcknowledged
    >[0];

    log.attemptBroadcastNotAcknowledged(input);

    expect(lines).toHaveLength(0);
  });

  it('rejects an error accessor without invoking it', () => {
    const { lines, log, identity } = captureBroadcastLog();
    let getterCalls = 0;

    const input = {
      ...identity,
      observation: 'request-error',
    };

    Object.defineProperty(input, 'error', {
      get() {
        getterCalls += 1;
        return new Error('Must not be read');
      },
    });

    log.attemptBroadcastNotAcknowledged(
      input as unknown as Parameters<
        typeof log.attemptBroadcastNotAcknowledged
      >[0],
    );

    expect(getterCalls).toBe(0);
    expect(lines).toHaveLength(0);
  });

  it('ignores unrelated input fields without invoking their accessors', () => {
    const { lines, log, identity } = captureBroadcastLog();
    let getterCalls = 0;

    const input = {
      ...identity,
      observation: 'invalid-response' as const,
    };

    Object.defineProperty(input, 'unrelated', {
      get() {
        getterCalls += 1;
        throw new Error('Must not be read');
      },
    });

    log.attemptBroadcastNotAcknowledged(input);

    expect(getterCalls).toBe(0);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);

    expect(record.event).toBe('attempt_broadcast_not_acknowledged');
    expect(record.observation).toBe('invalid-response');
    expect(record).not.toHaveProperty('unrelated');
  });
});