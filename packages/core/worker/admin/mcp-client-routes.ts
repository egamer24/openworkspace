import { and, desc, eq, max, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { WORKSPACE_SCOPE } from "../../shared/oidc";
import { oauthScope } from "../auth/oauth-scopes";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import {
  oidcAccessTokens,
  oidcClients,
  oidcGrants,
  oidcRefreshTokens,
  users,
} from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { zValidator } from "../lib/validator";
import {
  clientHost,
  selfRegistrationAllowed,
  setSelfRegistrationAllowed,
} from "../oidc/mcp-clients";
import { scopeInfo } from "../oidc/scopes";
import { clientAccessRevocations, insertOidcAudit } from "../oidc/service";

async function selfRegisteredClient(db: Database, clientId: string) {
  const [client] = await db
    .select({ id: oidcClients.id, enabled: oidcClients.enabled })
    .from(oidcClients)
    .where(
      and(eq(oidcClients.id, clientId), ne(oidcClients.registration, "admin"))
    )
    .limit(1);

  return client ?? null;
}

/**
 * Apps that registered themselves (MCP clients, by RFC 7591 or a metadata
 * document), across the workspace: who connected them, and the means to
 * turn one off for everyone or cut one person's connection. Administrators
 * only (the section is not delegated); an app's token needs admin.workspace.
 */
export const mcpClientAdminRoutes = new Hono<AppEnv>()
  .use("/mcp-clients/*", oauthScope(WORKSPACE_SCOPE))
  .get("/mcp-clients", async (c) => {
    const db = createDb(c.env.DB);

    const [clients, grants, refreshUse, accessUse, allowSelfRegistration] =
      await Promise.all([
        db
          .select({
            id: oidcClients.id,
            name: oidcClients.name,
            registration: oidcClients.registration,
            redirectUris: oidcClients.redirectUris,
            enabled: oidcClients.enabled,
            lastUsedAt: oidcClients.lastUsedAt,
            createdAt: oidcClients.createdAt,
          })
          .from(oidcClients)
          .where(ne(oidcClients.registration, "admin"))
          .orderBy(desc(oidcClients.createdAt)),
        db
          .select({
            clientId: oidcGrants.clientId,
            userId: oidcGrants.userId,
            name: users.name,
            scopes: oidcGrants.scopes,
            grantedAt: oidcGrants.grantedAt,
          })
          .from(oidcGrants)
          .innerJoin(users, eq(users.id, oidcGrants.userId))
          .innerJoin(oidcClients, eq(oidcClients.id, oidcGrants.clientId))
          .where(ne(oidcClients.registration, "admin"))
          .orderBy(desc(oidcGrants.grantedAt)),
        db
          .select({
            clientId: oidcRefreshTokens.clientId,
            userId: oidcRefreshTokens.userId,
            at: max(oidcRefreshTokens.createdAt),
          })
          .from(oidcRefreshTokens)
          .groupBy(oidcRefreshTokens.clientId, oidcRefreshTokens.userId),
        db
          .select({
            clientId: oidcAccessTokens.clientId,
            userId: oidcAccessTokens.userId,
            at: max(oidcAccessTokens.createdAt),
          })
          .from(oidcAccessTokens)
          .groupBy(oidcAccessTokens.clientId, oidcAccessTokens.userId),
        selfRegistrationAllowed(db),
      ]);

    // The newest token issued to each person for each app: when they last used it.
    const lastUse = new Map<string, Date>();

    for (const row of [...refreshUse, ...accessUse]) {
      if (!row.at) continue;
      const key = `${row.clientId}\0${row.userId}`;
      const at = new Date(row.at);

      const previous = lastUse.get(key);

      if (previous === undefined || previous < at) lastUse.set(key, at);
    }

    return c.json({
      ok: true as const,
      allowSelfRegistration,
      clients: clients.map(({ redirectUris, ...client }) => ({
        ...client,
        host: clientHost({ ...client, redirectUris }),
        connections: grants
          .filter((grant) => grant.clientId === client.id)
          .map((grant) => ({
            userId: grant.userId,
            name: grant.name,
            grantedAt: grant.grantedAt,
            lastUsedAt: lastUse.get(`${client.id}\0${grant.userId}`) ?? null,
            scopes: scopeInfo(grant.scopes),
          })),
      })),
    });
  })
  .put(
    "/mcp-clients/registration",
    zValidator("json", z.object({ allowed: z.boolean() })),
    async (c) => {
      await setSelfRegistrationAllowed(
        createDb(c.env.DB),
        c.req.valid("json").allowed
      );

      return c.json({ ok: true as const });
    }
  )
  /** Turns an app off for everyone: its tokens and consents go, and it may not sign anyone in. */
  .patch(
    "/mcp-clients/:id",
    zValidator("json", z.object({ enabled: z.boolean() })),
    async (c) => {
      const db = createDb(c.env.DB);
      const clientId = c.req.param("id");
      const client = await selfRegisteredClient(db, clientId);

      if (!client) return apiError(c, 404, "NOT_FOUND", "App not found");
      const { enabled } = c.req.valid("json");
      const now = new Date();
      await db.batch([
        db
          .update(oidcClients)
          .set({ enabled, updatedAt: now })
          .where(eq(oidcClients.id, clientId)),
        ...(enabled ? [] : clientAccessRevocations(db, clientId)),
        insertOidcAudit(db, {
          eventType: enabled ? "client.enabled" : "client.disabled",
          actorUserId: c.get("user").id,
          clientId,
        }),
      ]);

      return c.json({ ok: true as const });
    }
  )
  /** Cuts one person's connection; they can connect the app again. */
  .delete("/mcp-clients/:id/connections/:userId", async (c) => {
    const db = createDb(c.env.DB);
    const clientId = c.req.param("id");
    const userId = c.req.param("userId");

    if (!(await selfRegisteredClient(db, clientId))) {
      return apiError(c, 404, "NOT_FOUND", "App not found");
    }

    await db.batch([
      ...clientAccessRevocations(db, clientId, userId),
      insertOidcAudit(db, {
        eventType: "grant.revoked",
        actorUserId: c.get("user").id,
        subjectUserId: userId,
        clientId,
      }),
    ]);

    return c.json({ ok: true as const });
  });
