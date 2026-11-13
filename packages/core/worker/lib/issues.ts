import type { z } from "zod";

/**
 * Protocol errors built from zod issues. JMAP's `invalidProperties`, SCIM's
 * `invalidValue` and MCP tool errors each name the bad properties; these
 * turn a failed `safeParse` into those names and a readable description, so
 * protocol handlers parse their arguments with a schema instead of checking
 * each property by hand.
 */
export type Issue = z.core.$ZodIssue;

/** The issue's location as a JSON Pointer without the leading slash: `to/0/email`. */
export function issuePath(issue: Issue) {
  return issue.path
    .map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
}

/**
 * The properties the issues point at, once each in the order found. With
 * `topLevel`, only the first path segment: the argument or object property
 * that holds the bad value. Issues about the value as a whole (an empty
 * path) are left out.
 */
export function issueProperties(
  issues: readonly Issue[],
  options: { topLevel?: boolean } = {}
) {
  const properties = new Set<string>();

  for (const issue of issues) {
    const [first] = issue.path;

    if (first === undefined) continue;
    properties.add(
      options.topLevel
        ? issuePath({ ...issue, path: [first] })
        : issuePath(issue)
    );
  }

  return [...properties];
}

/** One line per issue, `path: message`, for an error's description. */
export function describeIssues(issues: readonly Issue[]) {
  return issues
    .map((issue) => {
      const path = issuePath(issue);

      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
