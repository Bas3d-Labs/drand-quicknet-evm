const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Matches the canonical lowercase UUID v4 format used internally. */
export function isUuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 36 &&
    UUID_V4.test(value)
  );
}