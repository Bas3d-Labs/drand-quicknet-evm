const priorStateErrors = new WeakSet<object>();

export function priorSignerStateError(): Error & {
  readonly code: 'prior-state-present';
} {
  const error = Object.assign(
    new Error(
      'Cannot automatically initialize a missing signer journal ' +
      'when checkpoint state exists.'
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