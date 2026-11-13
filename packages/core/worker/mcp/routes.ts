import type { AuthInfo } from "@modelcontextprotocol/server";
import { Hono } from "hono";

import { bearerToken, mcpResources } from "../auth/middleware";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { workspaceModules } from "../modules";
import {
  authenticateAccessToken,
  protectedResourceMetadataUrl,
} from "../oidc/mcp-clients";
import { suggestedScopes } from "../oidc/scopes";
import { AccountApiClient } from "./account-client";

/**
 * The MCP SDK, the server and the modules' tools, loaded with the first MCP
 * request: they are large and most of a workspace's requests are not MCP.
 */
function loadMcp() {
  return Promise.all([
    import("@modelcontextprotocol/server"),
    import("./server"),
    Promise.all(
      workspaceModules().flatMap((module) =>
        module.mcpTools ? [module.mcpTools()] : []
      )
    ),
  ]);
}

export const mcpRoutes = new Hono<AppEnv>().all("/", async (c) => {
  const origin = c.req.header("origin");
  const requestOrigin = new URL(c.req.url).origin;

  if (origin && origin !== requestOrigin) {
    return apiError(c, 403, "FORBIDDEN", "Cross-origin MCP request rejected");
  }

  const token = bearerToken(c.req.raw);

  const identity = token
    ? await authenticateAccessToken(createDb(c.env.DB), token, mcpResources(c))
    : null;

  if (!token || !identity) {
    // RFC 6750 / RFC 9728: point the client at the metadata so it can sign in.
    c.header(
      "www-authenticate",
      [
        `Bearer resource_metadata="${protectedResourceMetadataUrl(requestOrigin)}"`,
        `scope="${suggestedScopes().join(" ")}"`,
        ...(token ? ['error="invalid_token"'] : []),
      ].join(", ")
    );

    return apiError(
      c,
      401,
      "UNAUTHORIZED",
      token
        ? "The access token is invalid or expired"
        : "Sign in with OAuth to use this MCP server"
    );
  }

  const authInfo: AuthInfo = {
    token,
    clientId: identity.clientId,
    scopes: identity.scopes,
    extra: {
      userId: identity.user.id,
      role: identity.user.role,
    },
  };

  const api = new AccountApiClient(c.env, c.executionCtx, token, requestOrigin);

  const [{ createMcpHandler }, { createAccountMcpServer }, moduleTools] =
    await loadMcp();

  const handler = createMcpHandler(
    () => createAccountMcpServer({ api, scopes: identity.scopes, moduleTools }),
    {
      legacy: "stateless",
      onerror: (error) => console.error("MCP request failed", error),
    }
  );

  return handler.fetch(c.req.raw, { authInfo });
});
