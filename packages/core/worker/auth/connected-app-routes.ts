import { and, desc, eq, max, ne } from "drizzle-orm";
import { Hono } from "hono";

import { createDb } from "../db/client";
import {
  oidcAccessTokens,
  oidcClients,
  oidcGrants,
  oidcRefreshTokens,
} from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { clientHost } from "../oidc/mcp-clients";
import { scopeInfo } from "../oidc/scopes";
import { clientAccessRevocations, insertOidcAudit } from "../oidc/service";
import { requireSessionAuth } from "./middleware";

/**
 * The apps a person approved to use their account (AI agents, editors, mail
 * apps: every app that registered itself), and a way to disconnect one.
 */
export const connectedAppRoutes = new Hono<AppEnv>()
  .use("*", requireSessionAuth)
  .get("/", async (c) => {
    const userId = c.get("user").id;
    const db = createDb(c.env.DB);

    const [apps, refreshUse, accessUse] = await Promise.all([
      db
        .select({
          clientId: oidcClients.id,
          name: oidcClients.name,
          registration: oidcClients.registration,
          redirectUris: oidcClients.redirectUris,
          grantedAt: oidcGrants.grantedAt,
          scopes: oidcGrants.scopes,
        })
        .from(oidcGrants)
        .innerJoin(oidcClients, eq(oidcGrants.clientId, oidcClients.id))
        .where(
          and(
            eq(oidcGrants.userId, userId),
            ne(oidcClients.registration, "admin")
          )
        )
        .orderBy(desc(oidcGrants.grantedAt)),
      db
        .select({
          clientId: oidcRefreshTokens.clientId,
          at: max(oidcRefreshTokens.createdAt),
        })
        .from(oidcRefreshTokens)
        .where(eq(oidcRefreshTokens.userId, userId))
        .groupBy(oidcRefreshTokens.clientId),
      db
        .select({
          clientId: oidcAccessTokens.clientId,
          at: max(oidcAccessTokens.createdAt),
        })
        .from(oidcAccessTokens)
        .where(eq(oidcAccessTokens.userId, userId))
        .groupBy(oidcAccessTokens.clientId),
    ]);

    // The newest token issued to each app: when it last used the account.
    const lastUse = new Map<string, Date>();

    for (const row of [...refreshUse, ...accessUse]) {
      if (!row.at) continue;
      const at = new Date(row.at);

      const previous = lastUse.get(row.clientId);

      if (previous === undefined || previous < at) {
        lastUse.set(row.clientId, at);
      }
    }

    return c.json({
      ok: true as const,
      apps: apps.map(({ redirectUris, scopes, ...app }) => ({
        ...app,
        /** What the person approved; apps still get no more than the person may do. */
        scopes: scopeInfo(scopes),
        host: clientHost({
          id: app.clientId,
          registration: app.registration,
          redirectUris,
        }),
        lastUsedAt: lastUse.get(app.clientId) ?? null,
      })),
    });
  })
  .delete("/:clientId", async (c) => {
    const userId = c.get("user").id;
    const clientId = c.req.param("clientId");
    const db = createDb(c.env.DB);

    const [client] = await db
      .select({ registration: oidcClients.registration })
      .from(oidcClients)
      .where(eq(oidcClients.id, clientId))
      .limit(1);

    if (!client || client.registration === "admin") {
      return apiError(c, 404, "NOT_FOUND", "Connected app not found");
    }

    // Tokens and consent, and sign-ins in progress, so none can finish later.
    await db.batch([
      ...clientAccessRevocations(db, clientId, userId),
      insertOidcAudit(db, {
        eventType: "grant.revoked",
        actorUserId: userId,
        subjectUserId: userId,
        clientId,
      }),
    ]);

    return c.json({ ok: true as const });
  });
