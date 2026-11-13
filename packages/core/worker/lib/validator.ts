import { zValidator as honoZodValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { z } from "zod";
import type { ZodType } from "zod";

import { apiError } from "./http";

type Issue = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  input?: unknown;
};

/** Zod's wording for its built-in checks, said plainly. */
function plainMessage(issue: Issue) {
  if (issue.code === "invalid_type" && issue.input === undefined) {
    return "is required";
  }

  if (issue.origin === "string" && issue.code === "too_small") {
    return Number(issue.minimum) <= 1
      ? "is required"
      : `needs at least ${issue.minimum} characters`;
  }

  if (issue.origin === "string" && issue.code === "too_big") {
    return `can be at most ${issue.maximum} characters`;
  }

  if (issue.origin === "array" && issue.code === "too_small") {
    return `needs at least ${issue.minimum}`;
  }

  if (issue.origin === "array" && issue.code === "too_big") {
    return `can have at most ${issue.maximum}`;
  }

  return null;
}

const propertyName = z.string();

/** Readable text for the first problem, e.g. "Name needs at least 2 characters". */
export function validationMessage(issues: readonly Issue[]) {
  const issue = issues[0];

  if (!issue) return "The request is not valid";

  // The innermost property name; array indexes are numbers.
  const field = issue.path
    .flatMap((part) => {
      const name = propertyName.safeParse(part);

      return name.success ? [name.data] : [];
    })
    .at(-1);

  const plain = plainMessage(issue);

  if (!field) return plain ? `Value ${plain}` : issue.message;

  const words = field
    .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll(/[_-]/gu, " ")
    .toLowerCase();

  const label = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

  return plain ? `${label} ${plain}` : `${label}: ${issue.message}`;
}

/** zValidator that answers bad input with the usual `{ ok: false, error }` body and a readable message. */
export const zValidator = <
  Target extends keyof ValidationTargets,
  Schema extends ZodType,
>(
  target: Target,
  schema: Schema
) =>
  honoZodValidator(target, schema, (result, c) => {
    if (!result.success) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        validationMessage(result.error.issues)
      );
    }
  });
