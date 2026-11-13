import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { createDb } from "../db/client";
import { oidcClients, samlApplications, webhookEndpoints } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";

/**
 * Apps declared in alchemy.run.ts are changed by deploying; the admin API
 * only reads them, their provisioning (SCIM) included. A sync of provisioning
 * that already exists changes nothing, so it may still be started.
 */
export const rejectDeploymentManaged = (kind: "oidc" | "saml" | "webhook") =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.path.endsWith("/provisioning/sync")) return next();
    const id = c.req.param("id");

    const table =
      kind === "oidc"
        ? oidcClients
        : kind === "saml"
          ? samlApplications
          : webhookEndpoints;

    const [row] = id
      ? await createDb(c.env.DB)
          .select({ managedBy: table.managedBy })
          .from(table)
          .where(eq(table.id, id))
          .limit(1)
      : [];

    if (row?.managedBy) {
      return apiError(
        c,
        409,
        "CONFLICT",
        "This is declared in alchemy.run.ts; change it there and deploy"
      );
    }

    await next();
  });
