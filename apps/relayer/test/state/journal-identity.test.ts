import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  Address,
} from 'viem';

import {
  captureJournalIdentity,
} from '../../src/state/journal-identity.js';

const CHAIN_ID = 46_630;

const MIXED_CASE_SIGNER: Address =
  `0x${'aA'.repeat(20)}`;

const LOWERCASE_SIGNER: Address =
  `0x${'aa'.repeat(20)}`;

describe('captureJournalIdentity', () => {
  it('returns a distinct frozen copy of a valid identity', () => {
    const original = {
      chainId: CHAIN_ID,
      signer: MIXED_CASE_SIGNER,
    };

    const captured = captureJournalIdentity(original);

    expect(captured).toEqual(original);
    expect(captured).not.toBe(original);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it('does not change when the original identity is mutated', () => {
    const original = {
      chainId: CHAIN_ID,
      signer: MIXED_CASE_SIGNER,
    };

    const captured = captureJournalIdentity(original);

    original.chainId = 4_663;
    original.signer = LOWERCASE_SIGNER;

    expect(captured).toEqual({
      chainId: CHAIN_ID,
      signer: MIXED_CASE_SIGNER,
    });
  });

  it('preserves signer casing without normalization', () => {
    const mixedCase = captureJournalIdentity({
      chainId: CHAIN_ID,
      signer: MIXED_CASE_SIGNER,
    });

    const lowercase = captureJournalIdentity({
      chainId: CHAIN_ID,
      signer: LOWERCASE_SIGNER,
    });

    expect(MIXED_CASE_SIGNER.toLowerCase()).toBe(LOWERCASE_SIGNER);
    expect(mixedCase.signer).toBe(MIXED_CASE_SIGNER);
    expect(lowercase.signer).toBe(LOWERCASE_SIGNER);
    expect(mixedCase).not.toEqual(lowercase);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid chain ID %s', (chainId) => {
    const capture = () => captureJournalIdentity({
      chainId,
      signer: LOWERCASE_SIGNER,
    });

    expect(capture).toThrow(TypeError);
    expect(capture).toThrow('Invalid journal identity.');
  });

  it.each([
    { name: 'empty address', signer: '0x' },
    { name: 'short address', signer: `0x${'aa'.repeat(19)}` },
    { name: 'long address', signer: `0x${'aa'.repeat(21)}` },
    { name: 'non-hex address', signer: `0x${'gg'.repeat(20)}` },
    { name: 'missing prefix', signer: 'aa'.repeat(20) },
  ])('rejects $name', ({ signer }) => {
    const capture = () => captureJournalIdentity({
      chainId: CHAIN_ID,
      // Deliberately malformed input exercises runtime validation.
      signer: signer as Address,
    });

    expect(capture).toThrow(TypeError);
    expect(capture).toThrow('Invalid journal identity.');
  });
});