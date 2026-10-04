import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  isUuidV4,
} from '../../src/shared/uuid.js';

describe('isUuidV4', () => {
  it.each(['8', '9', 'a', 'b'])(
    'accepts UUID v4 variant %s',
    (variant) => {
      expect(isUuidV4(
        `12345678-abcd-4abc-${variant}abc-123456789abc`,
      )).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    123,
    {},
    '',
    '12345678-abcd-3abc-8abc-123456789abc',
    '12345678-abcd-4abc-7abc-123456789abc',
    '12345678-abcd-4abc-cabc-123456789abc',
    '12345678-ABCD-4ABC-8ABC-123456789ABC',
    '12345678abcd4abc8abc123456789abc',
    '12345678-abcd-4abc-8abc-123456789abc\n',
    'prefix-12345678-abcd-4abc-8abc-123456789abc',
  ])('rejects invalid input: %#', (value) => {
    expect(isUuidV4(value)).toBe(false);
  });
});