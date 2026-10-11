const priorStateErrors = new WeakSet<object>();

export function priorSignerStateError(): Error & {
  readonly code: 'prior-state-present';
} {
  const error = Object.assign(
    new Error(
      'Cannot automatically initialize a missing signer journal ' +
      'because the state directory contains other entries. ' +
      'Verify the configured directory and restore the matching ' +
      'journal if available. ' +
      'Remove entries only after establishing they are unrelated ' +
      'to prior relayer state.'
    ),
    { code: 'prior-state-present' as const },
  );

  priorStateErrors.add(error);

  return error;
}

export function isPriorSignerStateError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    priorStateErrors.has(error)
  );
}