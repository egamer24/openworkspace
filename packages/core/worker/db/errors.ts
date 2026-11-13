/**
 * Whether a failed D1 statement (or a batch it was part of) broke a
 * constraint on this column, e.g. "access_link_claims.access_link_id";
 * `kind` narrows it to one kind, e.g. "NOT NULL". Drizzle wraps D1's
 * error, so the whole cause chain is searched.
 */
export function violatesConstraintOn(
  cause: unknown,
  column: string,
  kind?: "NOT NULL" | "UNIQUE"
) {
  const failure = `${kind ? `${kind} ` : ""}constraint failed: ${column}`;

  for (let current = cause; current instanceof Error; current = current.cause) {
    if (current.message.includes(failure)) return true;
  }

  return false;
}
