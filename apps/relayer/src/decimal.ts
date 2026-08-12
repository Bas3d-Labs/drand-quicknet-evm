export function isDecimalInteger(
  value: string,
): boolean {
  if (value.length === 0) {
    return false;
  }

  for (const character of value) {
    if(character < '0' || character > '9') {
      return false;
    }
  }

  return true;
}