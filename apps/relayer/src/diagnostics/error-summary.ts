import type {
  ScrubbedText,
} from './text-scrubber.js';

const MAX_PROTOTYPE_NODES = 5;
const MAX_ERROR_DEPTH = 4;
const MAX_ERROR_NODES = 12;
const MAX_AGGREGATE_ENTRIES = 4;

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
}

export type SummarizeErrorOptions =
  | { mode?: 'strict' }
  | {
      mode: 'standard';
      scrubText: (text: string) => ScrubbedText;
    };

interface Budget {
  remaining: number;
  seen: Set<object>;
}

// Diagnostic text and labels are not evidence for transaction recovery.
// Standard mode requires the configured, bounded text scrubber.
export function summarizeError(
  error: unknown,
  options: SummarizeErrorOptions = {},
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
  options: SummarizeErrorOptions,
): ErrorSummary | undefined {
  if (budget.remaining === 0 || depth >= MAX_ERROR_DEPTH) {
    return undefined;
  }

  const summary = unknownError();
  budget.remaining -= 1;

  if (typeof error !== 'object' || error === null) {
    if (options.mode === 'standard') {
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

  if (options.mode === 'standard') {
    const cleanName = scrubField(name, options.scrubText, summary);
    if (cleanName !== undefined) {
      summary.name = cleanName;
    }

    const cleanCode = scrubField(code, options.scrubText, summary);
    if (cleanCode !== undefined) {
      summary.code = cleanCode;
    }

    // Prefer provider evidence over generic wrapper descriptions.
    for (const key of ['details', 'shortMessage', 'message']) {
      const message = scrubField(
        dataProperty(chain, key),
        options.scrubText,
        summary,
      );

      if (message !== undefined) {
        summary.message = message;
        break;
      }
    }
  }

  return summary;
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