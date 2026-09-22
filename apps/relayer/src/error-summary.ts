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
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EACCES',
  'ENOENT',
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
}

interface Budget {
  remaining: number;
  seen: Set<object>;
}

// Diagnostic labels are not evidence for transaction recovery. Fixed
// strings and bounded nodes also bound the serialized output size.
export function summarizeError(error: unknown): ErrorSummary {
  return visit(error, {
    remaining: MAX_ERROR_NODES,
    seen: new Set<object>(),
  }, 0) ?? unknownError();
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
): ErrorSummary | undefined {
  if (budget.remaining === 0 || depth >= MAX_ERROR_DEPTH) {
    return undefined;
  }

  const summary = unknownError();
  budget.remaining -= 1;

  if (typeof error !== 'object' || error === null) {
    return summary;
  }

  if (budget.seen.has(error)) {
    return undefined;
  }

  budget.seen.add(error);

  const chain = prototypeChain(error);
  if (chain === undefined) {
    return summary;
  }

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
    const child = visit(cause, budget, depth + 1);
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
        const length = dataProperty(arrayChain ?? [], 'length');

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

  return summary;
}

// Count the input itself. Validate termination even when it owns a name.
function prototypeChain(value: object): object[] | undefined {
  const chain: object[] = [];
  let current: object | null = value;

  try {
    while (current !== null && chain.length < MAX_PROTOTYPE_NODES) {
      if (chain.includes(current)) {
        return undefined;
      }

      chain.push(current);

      if (current === Object.prototype) {
        return chain;
      }

      current = Object.getPrototypeOf(current);
    }

    if (current === null) {
      return chain;
    }
  } catch {
    // Reflective operations may invoke Proxy traps.
  }

  return undefined;
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