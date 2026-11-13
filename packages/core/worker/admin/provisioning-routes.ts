import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { createDb } from "../db/client";
import type { Database } from "../db/client";
import {
  oidcClients,
  samlApplications,
  scimConnections,
  scimResources,
} from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { zValidator } from "../lib/validator";
import { requestScimSync, testScimConnection } from "../scim/sync";
import { serverCallbackUrlSchema } from "./schemas";

const provisioningInputSchema = z.object({
  enabled: z.boolean(),
  baseUrl: serverCallbackUrlSchema,
  /** Omit to keep the saved token; required when the URL moves to another origin. */
  token: z.string().trim().min(1).max(4096).optional(),
});

const provisioningTestSchema = z.object({
  baseUrl: serverCallbackUrlSchema,
  token: z.string().trim().min(1).max(4096).optional(),
});

type AppKind = "oidc-clients" | "saml-applications";

function connectionColumn(kind: AppKind) {
  return kind === "oidc-clients"
    ? scimConnections.oidcClientId
    : scimConnections.samlApplicationId;
}

async function applicationExists(db: Database, kind: AppKind, id: string) {
  const rows =
    kind === "oidc-clients"
      ? await db
          .select({ id: oidcClients.id })
          .from(oidcClients)
          // Self-registered MCP clients have no provisioning.
          .where(
            and(eq(oidcClients.id, id), eq(oidcClients.registration, "admin"))
          )
      : await db
          .select({ id: samlApplications.id })
          .from(samlApplications)
          .where(eq(samlApplications.id, id));

  return rows.length > 0;
}

/**
 * The saved token belongs to the server it was entered for: it is only ever
 * sent to that origin, and a URL on another origin needs its own token.
 */
function sameOrigin(left: string, right: string) {
  return new URL(left).origin === new URL(right).origin;
}

async function savedConnection(db: Database, kind: AppKind, id: string) {
  const [connection] = await db
    .select()
    .from(scimConnections)
    .where(eq(connectionColumn(kind), id))
    .limit(1);

  return connection;
}

/** Each application's provisioning status for the admin overview, by `oidc:` or `saml:` id. */
export async function provisioningSummaries(db: Database) {
  const [connections, counts] = await Promise.all([
    db.select().from(scimConnections),
    db
      .select({
        connectionId: scimResources.connectionId,
        kind: scimResources.kind,
        active: scimResources.active,
        total: count(),
      })
      .from(scimResources)
      .groupBy(
        scimResources.connectionId,
        scimResources.kind,
        scimResources.active
      ),
  ]);

  const summaries = new Map<string, ReturnType<typeof summary>>();

  function summary(connection: typeof scimConnections.$inferSelect) {
    const own = counts.filter((row) => row.connectionId === connection.id);

    return {
      enabled: connection.enabled,
      baseUrl: connection.baseUrl,
      lastSyncAt: connection.lastSyncAt,
      lastSuccessAt: connection.lastSuccessAt,
      lastError: connection.lastError,
      syncing: Boolean(
        connection.leaseUntil && connection.leaseUntil > new Date()
      ),
      users: own.find((row) => row.kind === "user" && row.active)?.total ?? 0,
      deactivatedUsers:
        own.find((row) => row.kind === "user" && !row.active)?.total ?? 0,
      groups: own.find((row) => row.kind === "group")?.total ?? 0,
    };
  }

  for (const connection of connections) {
    const key = connection.oidcClientId
      ? `oidc:${connection.oidcClientId}`
      : `saml:${connection.samlApplicationId}`;

    summaries.set(key, summary(connection));
  }

  return summaries;
}

async function saveProvisioning(
  c: Context<AppEnv>,
  kind: AppKind,
  id: string,
  input: z.infer<typeof provisioningInputSchema>
) {
  const db = createDb(c.env.DB);

  if (!(await applicationExists(db, kind, id))) {
    return apiError(c, 404, "NOT_FOUND", "Application not found");
  }

  const existing = await savedConnection(db, kind, id);
  const now = new Date();

  if (
    existing &&
    !input.token &&
    !sameOrigin(existing.baseUrl, input.baseUrl)
  ) {
    return apiError(
      c,
      400,
      "BAD_REQUEST",
      "The SCIM URL moved to another server; enter the token for it"
    );
  }

  if (existing) {
    await db
      .update(scimConnections)
      .set({
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        // Omitted, the saved token stays: drizzle skips undefined fields.
        token: input.token,
        updatedAt: now,
      })
      .where(eq(scimConnections.id, existing.id));
  } else {
    if (!input.token) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "Enter the application's SCIM token"
      );
    }

    await db.insert(scimConnections).values({
      id: createId("scim"),
      ...(kind === "oidc-clients"
        ? { oidcClientId: id }
        : { samlApplicationId: id }),
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      token: input.token,
      createdAt: now,
      updatedAt: now,
    });
  }

  const saved = await savedConnection(db, kind, id);

  if (saved?.enabled) await requestScimSync(c.env, [saved.id]);

  return c.json({ ok: true as const });
}

async function removeProvisioning(
  c: Context<AppEnv>,
  kind: AppKind,
  id: string
) {
  // People already provisioned stay in the application.
  await createDb(c.env.DB)
    .delete(scimConnections)
    .where(eq(connectionColumn(kind), id));

  return c.json({ ok: true as const });
}

async function syncNow(c: Context<AppEnv>, kind: AppKind, id: string) {
  const connection = await savedConnection(createDb(c.env.DB), kind, id);

  if (!connection) {
    return apiError(c, 404, "NOT_FOUND", "Provisioning is not set up");
  }

  if (!connection.enabled) {
    return apiError(c, 400, "BAD_REQUEST", "Turn provisioning on first");
  }

  await requestScimSync(c.env, [connection.id]);

  return c.json({ ok: true as const });
}

async function testProvisioning(
  c: Context<AppEnv>,
  kind: AppKind,
  id: string,
  input: z.infer<typeof provisioningTestSchema>
) {
  const saved = input.token
    ? undefined
    : await savedConnection(createDb(c.env.DB), kind, id);

  const token =
    input.token ??
    (saved && sameOrigin(saved.baseUrl, input.baseUrl)
      ? saved.token
      : undefined);

  if (!token) {
    return apiError(
      c,
      400,
      "BAD_REQUEST",
      saved
        ? "The SCIM URL moved to another server; enter the token for it"
        : "Enter the application's SCIM token"
    );
  }

  return c.json({
    ok: true as const,
    ...(await testScimConnection(input.baseUrl, token)),
  });
}

export const provisioningAdminRoutes = new Hono<AppEnv>()
  .put(
    "/oidc-clients/:id/provisioning",
    zValidator("json", provisioningInputSchema),
    (c) =>
      saveProvisioning(
        c,
        "oidc-clients",
        c.req.param("id"),
        c.req.valid("json")
      )
  )
  .put(
    "/saml-applications/:id/provisioning",
    zValidator("json", provisioningInputSchema),
    (c) =>
      saveProvisioning(
        c,
        "saml-applications",
        c.req.param("id"),
        c.req.valid("json")
      )
  )
  .delete("/oidc-clients/:id/provisioning", (c) =>
    removeProvisioning(c, "oidc-clients", c.req.param("id"))
  )
  .delete("/saml-applications/:id/provisioning", (c) =>
    removeProvisioning(c, "saml-applications", c.req.param("id"))
  )
  .post("/oidc-clients/:id/provisioning/sync", (c) =>
    syncNow(c, "oidc-clients", c.req.param("id"))
  )
  .post("/saml-applications/:id/provisioning/sync", (c) =>
    syncNow(c, "saml-applications", c.req.param("id"))
  )
  .post(
    "/oidc-clients/:id/provisioning/test",
    zValidator("json", provisioningTestSchema),
    (c) =>
      testProvisioning(
        c,
        "oidc-clients",
        c.req.param("id"),
        c.req.valid("json")
      )
  )
  .post(
    "/saml-applications/:id/provisioning/test",
    zValidator("json", provisioningTestSchema),
    (c) =>
      testProvisioning(
        c,
        "saml-applications",
        c.req.param("id"),
        c.req.valid("json")
      )
  );
