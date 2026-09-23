import { runInNewContext } from 'node:vm';

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { HttpRequestError } from 'viem';

import {
  summarizeError,
  type ErrorSummary,
} from '../src/diagnostics/error-summary.js';

const SECRET = 'summary-credential-canary';

function countNodes(summary: ErrorSummary): number {
  let count = 1;

  if (summary.cause !== undefined) {
    count += countNodes(summary.cause);
  }

  for (const child of summary.errors ?? []) {
    count += countNodes(child);
  }

  return count;
}

function tree(depth: number): Error {
  if (depth === 0) {
    return new Error(SECRET);
  }

  return new AggregateError(
    Array.from({ length: 5 }, () => tree(depth - 1)),
    SECRET,
    { cause: tree(depth - 1) },
  );
}

describe('summarizeError', () => {
  it.each([
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    URIError,
    EvalError,
  ])('recognizes inherited names on %s', (Constructor) => {
    const error = new Constructor(SECRET);

    expect(Object.hasOwn(error, 'name')).toBe(false);
    expect(summarizeError(error).name).toBe(Constructor.name);
    expect(JSON.stringify(summarizeError(error))).not.toContain(SECRET);
  });

  it('recognizes native errors from another realm', () => {
    const error = runInNewContext('new TypeError()');

    expect(summarizeError(error).name).toBe('TypeError');
  });

  it('retains viem categories without copying provider data', () => {
    const error = new HttpRequestError({
      url: `https://rpc.example/${SECRET}`,
      body: { secret: SECRET },
      details: SECRET,
      status: 429,
    });

    const before = error.message;
    const summary = summarizeError(error);

    expect(summary).toEqual({
      name: 'HttpRequestError',
      message: 'HTTP request failed.',
      status: 429,
    });

    expect(error.message).toBe(before);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('never invokes accessors, coercion, or serialization hooks', () => {
    const access = vi.fn(() => {
      throw new Error(SECRET);
    });

    const error = Object.create(TypeError.prototype);

    for (const key of [
      'name',
      'code',
      'status',
      'cause',
      'message',
      'stack',
    ]) {
      Object.defineProperty(error, key, { get: access });
    }

    error.toJSON = access;
    error.toString = access;

    expect(summarizeError(error).name).toBe('UnknownError');
    expect(JSON.stringify(summarizeError(error))).not.toContain(SECRET);
    expect(access).not.toHaveBeenCalled();
  });

  it('requires termination within five prototype nodes', () => {
    let error = Object.create(null);

    for (let i = 1; i < 5; i += 1) {
      error = Object.create(error);
    }

    error.name = 'TypeError';

    expect(summarizeError(error).name).toBe('TypeError');

    const tooDeep = Object.create(error);
    tooDeep.name = 'HttpRequestError';

    expect(summarizeError(tooDeep).name).toBe('UnknownError');
  });

  it('bounds cyclic and perpetually fresh Proxy prototype chains', () => {
    const cycle: object = new Proxy({}, {
      getPrototypeOf: () => cycle,
    });

    expect(summarizeError(cycle).name).toBe('UnknownError');

    let calls = 0;

    function fresh(): object {
      return new Proxy({}, {
        getPrototypeOf() {
          calls += 1;
          return fresh();
        },
      });
    }

    expect(summarizeError(fresh()).name).toBe('UnknownError');
    expect(calls).toBe(5);
  });

  it('contains throwing descriptor traps and revoked proxies', () => {
    const error = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error(SECRET);
      },
    });

    expect(summarizeError(error).name).toBe('UnknownError');

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(summarizeError(revoked.proxy).name).toBe('UnknownError');
  });

  it.each([
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EACCES',
    'ENOENT',
    -32000,
  ])('retains approved code %s', (code) => {
    expect(summarizeError({ code }).code).toBe(code);
  });

  it.each([
    SECRET,
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('omits unsupported codes: %#', (code) => {
    expect(summarizeError({ code }).code).toBeUndefined();
  });

  it('shares one node budget between causes and aggregate members', () => {
    const summary = summarizeError(tree(3));

    expect(countNodes(summary)).toBe(12);
    expect(summary.errorsOmitted).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(8192);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('limits aggregate entries and builds independent output objects', () => {
    const input = Array.from(
      { length: 6 },
      () => new TypeError(SECRET),
    );

    const summary = summarizeError(new AggregateError(input, SECRET));

    expect(summary.errors).toHaveLength(4);
    expect(summary.errorsOmitted).toBe(true);
    expect(summary.errors).not.toBe(input);
    expect(summary.errors?.[0]).not.toBe(input[0]);
  });

  it('does not invoke getters for aggregate members', () => {
    const access = vi.fn(() => {
      throw new Error(SECRET);
    });

    const error = new AggregateError([new Error()], SECRET);

    Object.defineProperty(error.errors, '0', { get: access });

    expect(() => summarizeError(error)).not.toThrow();
    expect(access).not.toHaveBeenCalled();
  });

  it('handles aggregate cycles and preserves omission markers', () => {
    const error = new AggregateError([], SECRET);
    error.cause = error;
    error.errors.push(error);

    const summary = summarizeError(error);

    expect(summary.causeOmitted).toBe(true);
    expect(summary.errorsOmitted).toBe(true);
    expect(summarizeError(summary)).toEqual(summary);
  });

  it('never passes through input messages', () => {
    for (const message of [
      'Invalid RPC URL.',
      'Unknown command.',
      SECRET,
    ]) {
      expect(summarizeError(new Error(message)).message)
        .toBe('Operation failed; details redacted.');
    }
  });

  it('marks revoked aggregate members as omitted', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    const error = new AggregateError([], 'Sensitive details');

    Object.defineProperty(error, 'errors', {
      value: proxy,
    });

    revoke();

    expect(summarizeError(error)).toEqual({
      name: 'AggregateError',
      message: 'Multiple operations failed.',
      errorsOmitted: true,
    });
  });
});