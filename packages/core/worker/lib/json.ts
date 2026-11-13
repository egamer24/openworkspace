import { z } from "zod";

/** Any JSON value. */
export const jsonValueSchema = z.json();

export type JsonValue = z.infer<typeof jsonValueSchema>;

/** A JSON object. */
export type JsonObject = Record<string, JsonValue>;

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema
);
