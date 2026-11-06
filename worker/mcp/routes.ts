import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { authenticateAccountApiToken, bearerToken } from "../auth/api-tokens";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { AccountApiClient } from "./account-client";
import { createAccountMcpServer } from "./server";

export const mcpRoutes = new Hono<AppEnv>().all("/", async (c) => {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return apiError(c, 403, "FORBIDDEN", "Cross-origin MCP request rejected");
  }

  const token = bearerToken(c.req.raw);
  const identity = token
    ? await authenticateAccountApiToken(c.env.DB, token)
    : null;
  if (!token || !identity) {
    c.header("www-authenticate", 'Bearer realm="OpenWorkspace MCP"');
    return apiError(c, 401, "UNAUTHORIZED", "A valid account API token is required");
  }
  if (identity.scope !== "full") {
    return apiError(c, 403, "FORBIDDEN", "MCP requires a full-access API token");
  }

  const authInfo: AuthInfo = {
    token,
    clientId: identity.tokenId,
    scopes: identity.user.role === "admin" ? ["mail", "admin"] : ["mail"],
    extra: {
      userId: identity.user.id,
      role: identity.user.role,
    },
  };
  const api = new AccountApiClient(
    c.env,
    c.executionCtx,
    token,
    new URL(c.req.url).origin,
  );
  const handler = createMcpHandler(
    () => createAccountMcpServer({
      api,
      isAdmin: identity.user.role === "admin",
    }),
    {
      legacy: "stateless",
      onerror: (error) => console.error("MCP request failed", error),
    },
  );
  return handler.fetch(c.req.raw, { authInfo });
});
