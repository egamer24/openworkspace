import { z } from "zod";

/**
 * Typed reads of the Worker's JSON answers for the stack tests: a body goes
 * through a zod schema, so a body of the wrong shape fails the test where it
 * is read instead of surfacing as `undefined` further on.
 */

/** The response's JSON body, parsed with `schema`. */
export async function readJson<S extends z.ZodType>(
  response: Response,
  schema: S
): Promise<z.output<S>> {
  return schema.parse(await response.json());
}

/** `{ error }`, the Worker's error body. */
export const errorBody = z.looseObject({ error: z.string() });

/** A JSON value, for bodies a test compares whole. */
export const jsonValue = z.json();

export type JsonValue = z.output<typeof jsonValue>;

/** A JSON object, e.g. the arguments of a tool call. */
export type JsonObject = Record<string, JsonValue>;
