import { McpServer } from "@modelcontextprotocol/server";

import type { ScopedToolRegistrar } from "../modules";

/**
 * `tool(scope)("name", config, handler)` registers the tool only when the
 * request's token holds `scope` (each of them, for a list; one of them,
 * for `{ anyOf }`); otherwise the
 * tool is neither listed nor callable. The routes the tool calls check the
 * same scopes again.
 */
export function scopedTools(
  server: McpServer,
  scopes: readonly string[]
): ScopedToolRegistrar {
  const granted = new Set(scopes);
  const register = server.registerTool.bind(server);
  // A tool the token may not use goes to a server nobody connects to: it is
  // registered as usual, but never listed or callable.
  const unlisted = new McpServer({ name: "unlisted", version: "0" });
  const skip = unlisted.registerTool.bind(unlisted);

  return (scope) => (scopeGranted(scope, granted) ? register : skip);
}

function scopeGranted(
  scope: Parameters<ScopedToolRegistrar>[0],
  granted: ReadonlySet<string>
) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- picks the string member of the typed scope union; nothing here is unparsed input
  if (typeof scope === "string") return granted.has(scope);

  return "anyOf" in scope
    ? scope.anyOf.some((item) => granted.has(item))
    : scope.every((item) => granted.has(item));
}
