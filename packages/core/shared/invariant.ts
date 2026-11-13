/**
 * Invariants: conditions the code relies on but the type checker can't see.
 * A failure is a bug in this code, not bad input, so it throws instead of
 * answering with a validation error. Parse untrusted input with a schema.
 */
export class InvariantError extends Error {}

/** Throws an InvariantError with `message` unless `condition` holds. */
export function invariant(
  condition: boolean,
  message: string
): asserts condition {
  if (!condition) throw new InvariantError(message);
}

/** `value`, or an InvariantError with `message` when it is null or undefined. */
export function required<T>(value: T, message: string): NonNullable<T> {
  if (value == null) throw new InvariantError(message);

  return value;
}
