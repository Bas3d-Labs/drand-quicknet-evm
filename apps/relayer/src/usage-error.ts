import {
  USAGE_MESSAGES
} from './diagnostic-messages.js';

export type UsageCode = keyof typeof USAGE_MESSAGES;

const codes = new WeakMap<object, UsageCode>();

export class UsageError extends Error {
  readonly code: UsageCode;

  constructor(code: UsageCode) {
    if (
      typeof code !== 'string' ||
      !Object.hasOwn(USAGE_MESSAGES, code)
    ) {
      throw new TypeError('Invalid usage diagnostic code.');
    }

    super(USAGE_MESSAGES[code]);

    this.code = code;
    codes.set(this, code);
  }
}

export function usageCode(
  error: unknown,
): UsageCode | undefined {
  if (!(error instanceof UsageError)) {
    return undefined;
  }

  return codes.get(error);
}