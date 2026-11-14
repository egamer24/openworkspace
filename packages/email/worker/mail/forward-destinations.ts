import {
  apiError,
  can,
  createDb,
  mailboxes,
  requireAuth,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { createDestinations, destinationStatuses } from "./email-routing";

async function forwardAddress(db: D1Database, mailboxId: string) {
  const [row] = await createDb(db)
    .select({
      ownerUserId: mailboxes.ownerUserId,
      delivery: mailboxes.delivery,
      forwardTo: mailboxes.forwardTo,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);

  return row ?? null;
}

/**
 * Core's `mailboxSaved` hook: a forward's destinations that Email Routing
 * doesn't know yet are added, and Cloudflare emails each its confirmation.
 */
export async function addForwardDestinations(env: Env, mailboxId: string) {
  const address = await forwardAddress(env.DB, mailboxId);

  if (address?.delivery === "forward" && address.forwardTo?.length) {
    await createDestinations(env, address.forwardTo);
  }
}

/**
 * Whether each of a forward's saved destinations confirmed Cloudflare's
 * email, for the address editor under People or Teams; only people who
 * manage that address see it.
 */
export const forwardDestinationRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/:mailboxId", async (c) => {
    const address = await forwardAddress(c.env.DB, c.req.param("mailboxId"));

    if (!address) return apiError(c, 404, "NOT_FOUND", "Address not found");

    if (!can(c, address.ownerUserId ? "manage_people" : "manage_teams")) {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "You do not have permission to manage this address"
      );
    }

    const forwardTo =
      address.delivery === "forward" ? (address.forwardTo ?? []) : [];

    const statuses = forwardTo.length ? await destinationStatuses(c.env) : null;

    return c.json({
      ok: true as const,
      /** False in local development, where there is no Email Routing. */
      connected: statuses !== null || !forwardTo.length,
      destinations: forwardTo.map((email) => ({
        email,
        confirmed: statuses?.get(email.toLowerCase()) === "confirmed",
      })),
    });
  });
