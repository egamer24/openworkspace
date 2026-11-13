import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { timed } from "../lib/server-timing";
import { oidcIssuer } from "../oidc/keys";
import { authenticateAccessToken, mcpResourceUri } from "../oidc/mcp-clients";
import { oauthScopeRefusal } from "./oauth-scopes";
import { readSessionFromContext } from "./session";
import type { lookupSession, SessionCompanion } from "./session";

type AccountSession = NonNullable<
  Awaited<ReturnType<typeof lookupSession>>["session"]
>;

/** Signs the request in as `session`, as the middleware below do. */
export function setSessionContext(c: Context<AppEnv>, session: AccountSession) {
  c.set("user", session.user);
  c.set("authKind", "session");
  c.set("sessionId", session.id);
  c.set("sessionTokenHash", session.tokenHash);
}

export const requireSessionAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await readSessionFromContext(c);

  if (!session) return apiError(c, 401, "UNAUTHORIZED", "Sign in is required");
  setSessionContext(c, session);
  await next();
});

/**
 * The MCP endpoint's resource URIs: at the issuer's origin and this
 * request's. The account API is what the MCP server calls with the
 * client's token, so it accepts tokens for that resource only.
 */
export function mcpResources(c: Context<AppEnv>) {
  const origins = new Set([new URL(c.req.url).origin]);

  try {
    origins.add(new URL(oidcIssuer(c.env)).origin);
  } catch {
    // Without a configured issuer, only this origin.
  }

  return [...origins].map(mcpResourceUri);
}

/**
 * A session cookie or, for MCP clients, an OAuth access token for the MCP
 * resource. A token is never a session: it reaches only routes that declare
 * the scopes it needs (`oauthScope`), and only with scopes the person may
 * still use; anything else refuses it. With a `companion`, a cookie
 * session's lookup also runs that statement in the same D1 round trip and
 * leaves its result in `authCompanion`.
 */
export function requireAuthWith(companion?: SessionCompanion) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await timed(c, "d1", "session", () =>
      readSessionFromContext(c, companion)
    );

    if (session) {
      setSessionContext(c, session);
      c.set("authCompanion", session.companion);
      await next();

      return;
    }

    // MCP clients reach the API with their OAuth access token.
    const rawToken = bearerToken(c.req.raw);

    const identity = rawToken
      ? await timed(c, "d1", "oauth", () =>
          authenticateAccessToken(createDb(c.env.DB), rawToken, mcpResources(c))
        )
      : null;

    if (!identity) {
      c.header("www-authenticate", 'Bearer realm="OpenWorkspace API"');

      return apiError(c, 401, "UNAUTHORIZED", "Authentication is required");
    }

    c.set("user", identity.user);
    c.set("authKind", "oauth");
    c.set("oauthScopes", identity.scopes);
    c.set("sessionId", identity.familyId);
    c.set("sessionTokenHash", identity.tokenHash);
    const refused = oauthScopeRefusal(c);

    if (refused) return refused;
    await next();
  });
}

export const requireAuth = requireAuthWith();

export function bearerToken(request: Request) {
  const match = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/iu);

  return match?.[1]?.trim() || null;
}

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");

  if (user.role !== "admin") {
    return apiError(c, 403, "FORBIDDEN", "Administrator access is required");
  }

  await next();
});

export const verifySameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    await next();

    return;
  }

  const origin = c.req.header("origin");

  // Non-browser clients do not automatically carry ambient cookies. Browsers
  // do, so their state-changing requests must prove they are same-origin.
  if (origin && origin !== new URL(c.req.url).origin) {
    return apiError(c, 403, "FORBIDDEN", "Cross-origin request rejected");
  }

  await next();
});
