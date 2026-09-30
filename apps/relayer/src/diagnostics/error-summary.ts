import {
  mismatchDetails,
  mismatchMessage,
  type MismatchDetails,
} from './mismatch-errors.js';

import type {
  ScrubbedText,
} from './text-scrubber.js';

const MAX_PROTOTYPE_NODES = 5;
const MAX_ERROR_DEPTH = 4;
const MAX_ERROR_NODES = 12;
const MAX_AGGREGATE_ENTRIES = 4;

const MAX_REVERT_ARGUMENTS = 4;
const MIN_REVERT_INTEGER = -(1n << 255n);
const MAX_REVERT_INTEGER = (1n << 256n) - 1n;

const ERROR_MESSAGES = new Map<string, string>([
  ['UnknownError', 'Operation failed; details redacted.'],
  ['Error', 'Operation failed; details redacted.'],
  ['TypeError', 'Invalid value; details redacted.'],
  ['RangeError', 'Value out of range; details redacted.'],
  ['SyntaxError', 'Invalid syntax; details redacted.'],
  ['ReferenceError', 'Invalid reference; details redacted.'],
  ['URIError', 'Invalid URI encoding; details redacted.'],
  ['EvalError', 'Evaluation failed; details redacted.'],
  ['AggregateError', 'Multiple operations failed.'],
  ['HttpRequestError', 'HTTP request failed.'],
  ['WebSocketRequestError', 'WebSocket request failed.'],
  ['RpcRequestError', 'RPC request failed.'],
  ['TimeoutError', 'Request timed out.'],
  ['WaitForTransactionReceiptTimeoutError', 'Receipt wait timed out.'],
  ['NonceTooLowError', 'Transaction nonce is too low.'],
  ['NonceTooHighError', 'Transaction nonce is too high.'],
  ['InsufficientFundsError', 'Insufficient funds for transaction.'],
  ['TransactionExecutionError', 'Transaction execution failed.'],
  ['ContractFunctionExecutionError', 'Contract execution failed.'],
  ['ContractFunctionRevertedError', 'Contract execution reverted.'],
  ['EstimateGasExecutionError', 'Gas estimation failed.'],
  ['CallExecutionError', 'Call execution failed.'],
  ['AbortError', 'Operation aborted.'],
]);

const SYSTEM_CODES = new Set([
  'ABORT_ERR',
  'EACCES',
  'EAGAIN',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EINTR',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

export type RevertArgument = string | number | boolean | null;

export interface ErrorSummary {
  name: string;
  message: string;
  code?: number | string;
  status?: number;
  cause?: ErrorSummary;
  causeOmitted?: true;
  errors?: ErrorSummary[];
  errorsOmitted?: true;
  textModified?: true;
  revert?: RevertSummary;
  mismatch?: MismatchDetails;
}

export interface RevertSummary {
  name?: string;
  reason?: string;
  args?: RevertArgument[];
  argsOmitted?: true;
}

export interface SummarizeErrorOptions {
  scrubText: (text: string) => ScrubbedText;
}

interface Budget {
  remaining: number;
  seen: Set<object>;
}

// Diagnostic text and labels are not evidence for transaction recovery.
// External text requires the configured, bounded scrubber.
export function summarizeError(
  error: unknown,
  options?: SummarizeErrorOptions,
): ErrorSummary {
  return visit(error, {
    remaining: MAX_ERROR_NODES,
    seen: new Set<object>(),
  }, 0, options) ?? unknownError();
}

function unknownError(): ErrorSummary {
  return {
    name: 'UnknownError',
    message: 'Operation failed; details redacted.',
  };
}

function visit(
  error: unknown,
  budget: Budget,
  depth: number,
  options: SummarizeErrorOptions | undefined,
): ErrorSummary | undefined {
  if (budget.remaining === 0 || depth >= MAX_ERROR_DEPTH) {
    return undefined;
  }

  const summary = unknownError();
  budget.remaining -= 1;

  if (typeof error !== 'object' || error === null) {
    if (options !== undefined) {
      const message = scrubField(error, options.scrubText, summary);
      if (message !== undefined) {
        summary.message = message;
      }
    }

    return summary;
  }

  if (budget.seen.has(error)) {
    return undefined;
  }

  budget.seen.add(error);

  const chain = prototypeChain(error);
  const name = dataProperty(chain, 'name');

  if (typeof name === 'string') {
    const message = ERROR_MESSAGES.get(name);
    if (message !== undefined) {
      summary.name = name;
      summary.message = message;
    }
  }

  const code = dataProperty(chain, 'code');
  if (
    (typeof code === 'number' && Number.isSafeInteger(code)) ||
    (typeof code === 'string' && SYSTEM_CODES.has(code))
  ) {
    summary.code = code;
  }

  const status = dataProperty(chain, 'status');
  if (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  ) {
    summary.status = status;
  }

  if (dataProperty(chain, 'causeOmitted') === true) {
    summary.causeOmitted = true;
  }

  const cause = dataProperty(chain, 'cause');
  if (cause !== undefined && cause !== null) {
    const child = visit(cause, budget, depth + 1, options);
    if (child === undefined) {
      summary.causeOmitted = true;
    } else {
      summary.cause = child;
    }
  }

  if (summary.name === 'AggregateError') {
    if (dataProperty(chain, 'errorsOmitted') === true) {
      summary.errorsOmitted = true;
    }

    const errors = dataProperty(chain, 'errors');

    try {
      if (Array.isArray(errors)) {
        const arrayChain = prototypeChain(errors);
        const length = dataProperty(arrayChain, 'length');

        if (
          typeof length !== 'number' ||
          !Number.isSafeInteger(length) ||
          length < 0
        ) {
          summary.errorsOmitted = true;
        } else {
          const children: ErrorSummary[] = [];

          const limit = Math.min(length, MAX_AGGREGATE_ENTRIES);
          for (let index = 0; index < limit; index += 1) {
            const child = visit(
              dataProperty([errors], String(index)),
              budget,
              depth + 1,
              options,
            );

            if (child === undefined) {
              summary.errorsOmitted = true;
            } else {
              children.push(child);
            }
          }

          if (children.length > 0) {
            summary.errors = children;
          }

          if (length > limit) {
            summary.errorsOmitted = true;
          }
        }
      }
    } catch {
      // Array.isArray can throw for a revoked Proxy.
      summary.errorsOmitted = true;
    }
  }

  if (options !== undefined) {
    const cleanName = scrubField(name, options.scrubText, summary);
    if (cleanName !== undefined) {
      summary.name = cleanName;
    }

    const cleanCode = scrubField(code, options.scrubText, summary);
    if (cleanCode !== undefined) {
      summary.code = cleanCode;
    }

    const message = scrubField(
      selectErrorMessage(chain, cause),
      options.scrubText,
      summary,
    );

    if (message !== undefined) {
      summary.message = message;
    }

    if (name === 'ContractFunctionRevertedError') {
      const revert = summarizeRevert(
        chain,
        options.scrubText,
        summary,
      );

      if (revert !== undefined) {
        summary.revert = revert;
      }
    }
  }

  const mismatch = mismatchDetails(error);
  if (mismatch !== undefined) {
    summary.mismatch = mismatch;

    if (mismatch.kind === 'deployment-chain') {
      summary.code = 'DEPLOYMENT_CHAIN_MISMATCH';
    } else {
      summary.code = 'CONSUMER_REGISTRY_MISMATCH';
    }

    if (options === undefined) {
      // Reconstruct solely from registered, validated public values.
      summary.message = mismatchMessage(mismatch);
    }
  }

  return summary;
}

function summarizeRevert(
  chain: readonly object[],
  scrubText: (text: string) => ScrubbedText,
  summary: ErrorSummary,
): RevertSummary | undefined {
  const revert: RevertSummary = {};

  const reason = scrubField(
    dataProperty(chain, 'reason'),
    scrubText,
    summary,
  );

  if (reason !== undefined) {
    revert.reason = reason;
  }

  const data = dataProperty(chain, 'data');
  if (typeof data === 'object' && data !== null) {
    const dataChain = prototypeChain(data);

    const name = scrubField(
      dataProperty(dataChain, 'errorName'),
      scrubText,
      summary,
    );

    if (name !== undefined) {
      revert.name = name;
    }

    const args = dataProperty(dataChain, 'args');
    if (args !== undefined) {
      try {
        if (!Array.isArray(args)) {
          revert.argsOmitted = true;
        } else {
          const length = dataProperty([args], 'length');

          if (
            typeof length !== 'number' ||
            !Number.isSafeInteger(length) ||
            length < 0
          ) {
            revert.argsOmitted = true;
          } else {
            const limit = Math.min(length, MAX_REVERT_ARGUMENTS);
            revert.args = [];

            for (let index = 0; index < limit; index += 1) {
              const value = revertArgument(
                dataProperty([args], String(index)),
                scrubText,
                summary,
              );

              if (value === undefined) {
                // Preserve argument positions when a value is omitted.
                revert.args.push('[omitted]');
                revert.argsOmitted = true;
              } else {
                revert.args.push(value);
              }
            }

            if (length > limit) {
              revert.argsOmitted = true;
            }
          }
        }
      } catch {
        // Array.isArray can throw for a revoked Proxy.
        revert.argsOmitted = true;
      }
    }
  }

  if (Object.keys(revert).length === 0) {
    return undefined;
  }

  return revert;
}

function revertArgument(
  value: unknown,
  scrubText: (text: string) => ScrubbedText,
  summary: ErrorSummary,
): RevertArgument | undefined {
  if (typeof value === 'string') {
    if (value.length === 0) {
      return '';
    }

    return scrubField(value, scrubText, summary);
  }

  if (typeof value === 'bigint') {
    if (
      value < MIN_REVERT_INTEGER ||
      value > MAX_REVERT_INTEGER
    ) {
      return undefined;
    }

    return scrubField(value.toString(), scrubText, summary);
  }

  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value)
  ) {
    return value;
  }

  if (typeof value === 'boolean' || value === null) {
    return value;
  }

  // Never coerce or recursively serialize external argument objects.
  return undefined;
}

function selectErrorMessage(
  chain: readonly object[],
  cause: unknown,
): unknown {
  const details = dataProperty(chain, 'details');
  const shortMessage = dataProperty(chain, 'shortMessage');

  if (typeof details === 'string' && details.length > 0) {
    if (
      typeof shortMessage === 'string' &&
      shortMessage.length > 0 &&
      typeof cause === 'object' &&
      cause !== null
    ) {
      const causeDetails = dataProperty(
        prototypeChain(cause),
        'details',
      );

      // Compare raw strings, before either value is scrubbed or truncated.
      if (
        typeof causeDetails === 'string' &&
        details === causeDetails
      ) {
        return shortMessage;
      }
    }

    return details;
  }

  if (typeof shortMessage === 'string' && shortMessage.length > 0) {
    return shortMessage;
  }

  return dataProperty(chain, 'message');
}

function scrubField(
  value: unknown,
  scrubText: (text: string) => ScrubbedText,
  summary: ErrorSummary,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  try {
    const result = scrubText(value);
    if (result.removed) {
      summary.textModified = true;
    }

    return result.text;
  } catch {
    // Never fall back to raw text if scrubbing fails.
    summary.textModified = true;
    return '[diagnostic text unavailable]';
  }
}

// Count the input itself and retain the bounded prefix we can inspect.
function prototypeChain(value: object): object[] {
  const chain: object[] = [];
  let current: object | null = value;

  try {
    while (current !== null && chain.length < MAX_PROTOTYPE_NODES) {
      if (chain.includes(current)) {
        break;
      }

      chain.push(current);

      if (
        current === Object.prototype ||
        chain.length === MAX_PROTOTYPE_NODES
      ) {
        break;
      }

      current = Object.getPrototypeOf(current);
    }
  } catch {
    // A throwing prototype trap does not invalidate earlier nodes.
  }

  return chain;
}

function dataProperty(
  chain: readonly object[],
  key: string,
): unknown {
  try {
    for (const value of chain) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined) {
        if (Object.hasOwn(descriptor, 'value')) {
          return descriptor.value;
        }

        // An accessor shadows inherited properties, never invoke or skip it.
        return undefined;
      }
    }
  } catch {
    // Treat throwing descriptor traps as unavailable data.
  }

  return undefined;
}