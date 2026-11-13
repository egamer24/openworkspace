import type { BatchItem } from "drizzle-orm/batch";

/** One statement of a D1 batch. */
export type BatchStatement = BatchItem<"sqlite">;

/** What `db.batch` takes: at least one statement. */
export type BatchStatements = [BatchStatement, ...BatchStatement[]];

/** `statements` as a batch, or null when there is nothing to run. */
export function nonEmptyBatch(
  statements: readonly BatchStatement[]
): BatchStatements | null {
  const [first, ...rest] = statements;

  return first ? [first, ...rest] : null;
}
