import { and, eq, exists } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { can } from "../auth/permissions";
import { mailDomainAllowed, mailDomainRefusal } from "../config/mail-domains";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { mailboxes, teams, users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId, mailboxAddressParts } from "../lib/ids";
import { zValidator } from "../lib/validator";
import { runModuleHooks } from "../modules";
import {
  deferWebhookTask,
  mailboxWebhookData,
  queueMailboxWebhookEvent,
  queueUserWebhookEvent,
} from "../webhooks/service";
import { createMailboxSchema, updateMailboxSchema } from "./schemas";
import { userTargetRefusal } from "./target-guard";

/**
 * Personal mailboxes are managed with people, team addresses with teams. A
 * personal mailbox is its owner's: whoever changes it must be allowed to act
 * on that person (target-guard.ts). The refusal to answer with, or null.
 */
async function mailboxRefusal(
  c: Context<AppEnv>,
  db: Database,
  mailbox: { ownerUserId: string | null }
) {
  if (!mailbox.ownerUserId) {
    return can(c, "manage_teams") ? null : forbidden(c);
  }

  if (!can(c, "manage_people")) return forbidden(c);
  const refusal = await userTargetRefusal(c, db, mailbox.ownerUserId);

  return refusal
    ? apiError(c, refusal.status, refusal.code, refusal.message)
    : null;
}

async function mailboxOwnership(db: Database, mailboxId: string) {
  const [mailbox] = await db
    .select({ ownerUserId: mailboxes.ownerUserId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);

  return mailbox ?? null;
}

function forbidden(c: Context<AppEnv>) {
  return apiError(
    c,
    403,
    "FORBIDDEN",
    "You do not have permission to manage this mailbox"
  );
}

async function teamExists(db: Database, teamId: string) {
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  return Boolean(team);
}

export const mailboxAdminRoutes = new Hono<AppEnv>()
  .post("/mailboxes", zValidator("json", createMailboxSchema), async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);

    const refused = await mailboxRefusal(c, db, {
      ownerUserId: input.ownerUserId,
    });

    if (refused) return refused;

    if (!mailDomainAllowed(input.address)) {
      return apiError(c, 400, "BAD_REQUEST", mailDomainRefusal());
    }

    if (input.teamId && !(await teamExists(db, input.teamId))) {
      return apiError(c, 400, "BAD_REQUEST", "Unknown team");
    }

    const id = createId("mbx");
    const now = new Date();
    const address = mailboxAddressParts(input.address);

    const [existingPrimary] = input.ownerUserId
      ? await db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.ownerUserId, input.ownerUserId),
              eq(mailboxes.isPrimary, true)
            )
          )
          .limit(1)
      : [];

    try {
      await db.insert(mailboxes).values({
        id,
        localPart: address.localPart,
        domain: address.domain,
        displayName: input.displayName,
        ownerUserId: input.ownerUserId,
        teamId: input.ownerUserId ? null : input.teamId,
        delivery: input.delivery,
        listPosting: input.listPosting,
        isPrimary: Boolean(input.ownerUserId && !existingPrimary),
        createdByUserId: c.get("user").id,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      return apiError(c, 409, "CONFLICT", "Mailbox address is already in use");
    }

    const webhookMailbox = await mailboxWebhookData(db, id);

    if (webhookMailbox) {
      deferWebhookTask(
        (task) => c.executionCtx.waitUntil(task),
        (eventId) =>
          queueMailboxWebhookEvent(
            c.env,
            "mailbox.created",
            webhookMailbox,
            eventId
          )
      );
    }

    return c.json({ ok: true as const, mailboxId: id }, 201);
  })
  .patch(
    "/mailboxes/:id",
    zValidator("json", updateMailboxSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const mailboxId = c.req.param("id");
      const input = c.req.valid("json");

      const [mailbox] = await db
        .select({ id: mailboxes.id, ownerUserId: mailboxes.ownerUserId })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);

      if (!mailbox) return apiError(c, 404, "NOT_FOUND", "Mailbox not found");
      const refused = await mailboxRefusal(c, db, mailbox);

      if (refused) return refused;

      if (mailbox.ownerUserId) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Personal mailbox access follows its owner"
        );
      }

      if (input.teamId && !(await teamExists(db, input.teamId))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown team");
      }

      await db
        .update(mailboxes)
        .set({
          // Drizzle leaves the columns of omitted (undefined) fields unchanged.
          displayName: input.displayName,
          teamId: input.teamId,
          delivery: input.delivery,
          listPosting: input.listPosting,
          updatedAt: new Date(),
        })
        .where(eq(mailboxes.id, mailboxId));
      const webhookMailbox = await mailboxWebhookData(db, mailboxId);

      if (webhookMailbox) {
        deferWebhookTask(
          (task) => c.executionCtx.waitUntil(task),
          (eventId) =>
            queueMailboxWebhookEvent(
              c.env,
              "mailbox.updated",
              webhookMailbox,
              eventId
            )
        );
      }

      return c.json({ ok: true as const });
    }
  )
  .post("/mailboxes/:id/primary", async (c) => {
    const db = createDb(c.env.DB);
    const mailboxId = c.req.param("id");

    const [mailbox] = await db
      .select({
        ownerUserId: mailboxes.ownerUserId,
        isPrimary: mailboxes.isPrimary,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1);

    if (!mailbox) return apiError(c, 404, "NOT_FOUND", "Mailbox not found");
    const refused = await mailboxRefusal(c, db, mailbox);

    if (refused) return refused;

    const { ownerUserId } = mailbox;

    if (!ownerUserId) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "Shared mailbox cannot be primary"
      );
    }

    if (mailbox.isPrimary) return c.json({ ok: true as const });
    const now = new Date();

    const targetExists = exists(
      db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.ownerUserId, ownerUserId)
          )
        )
    );

    const [previousPrimaryRows, , promoted] = await db.batch([
      db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.ownerUserId, ownerUserId),
            eq(mailboxes.isPrimary, true)
          )
        )
        .limit(1),
      db
        .update(mailboxes)
        .set({ isPrimary: false, updatedAt: now })
        .where(
          and(
            eq(mailboxes.ownerUserId, ownerUserId),
            eq(mailboxes.isPrimary, true),
            targetExists
          )
        ),
      db
        .update(mailboxes)
        .set({ isPrimary: true, updatedAt: now })
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.ownerUserId, ownerUserId)
          )
        )
        .returning({ id: mailboxes.id }),
      db
        .update(users)
        .set({ updatedAt: now })
        .where(and(eq(users.id, ownerUserId), targetExists)),
    ]);

    if (promoted.length === 0) {
      return apiError(c, 404, "NOT_FOUND", "Mailbox not found");
    }

    deferWebhookTask(
      (task) => c.executionCtx.waitUntil(task),
      (eventId) =>
        queueUserWebhookEvent(c.env, "user.updated", ownerUserId, eventId)
    );

    const changedMailboxIds = new Set(
      [previousPrimaryRows[0]?.id, mailboxId].filter((id): id is string =>
        Boolean(id)
      )
    );

    const changedMailboxes = await Promise.all(
      [...changedMailboxIds].map((id) => mailboxWebhookData(db, id))
    );

    for (const changedMailbox of changedMailboxes) {
      if (!changedMailbox) continue;
      deferWebhookTask(
        (task) => c.executionCtx.waitUntil(task),
        (eventId) =>
          queueMailboxWebhookEvent(
            c.env,
            "mailbox.updated",
            changedMailbox,
            eventId
          )
      );
    }

    return c.json({ ok: true as const });
  })
  .delete("/mailboxes/:id", async (c) => {
    const db = createDb(c.env.DB);
    const mailboxId = c.req.param("id");
    const ownership = await mailboxOwnership(db, mailboxId);

    if (ownership) {
      const refused = await mailboxRefusal(c, db, ownership);

      if (refused) return refused;
    }

    const webhookMailbox = await mailboxWebhookData(db, mailboxId);

    if (webhookMailbox?.isPrimary) {
      return apiError(c, 409, "CONFLICT", "Primary mailbox cannot be deleted");
    }

    if (webhookMailbox) {
      // D1 is the access authority. Remove it first so no new authenticated
      // request can reach mailbox data while the cross-service cleanup runs.
      const [deleted] = await db
        .delete(mailboxes)
        .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.isPrimary, false)))
        .returning({ id: mailboxes.id });

      if (!deleted) {
        const [current] = await db
          .select({ isPrimary: mailboxes.isPrimary })
          .from(mailboxes)
          .where(eq(mailboxes.id, mailboxId))
          .limit(1);

        if (current) {
          return apiError(
            c,
            409,
            "CONFLICT",
            current.isPrimary
              ? "Primary mailbox cannot be deleted"
              : "Mailbox changed; try deleting it again"
          );
        }

        await runModuleHooks("mailboxDeleted", c.env, mailboxId);

        return c.json({ ok: true as const, mailboxId });
      }

      deferWebhookTask(
        (task) => c.executionCtx.waitUntil(task),
        (eventId) =>
          queueMailboxWebhookEvent(
            c.env,
            "mailbox.deleted",
            webhookMailbox,
            eventId
          )
      );
    }

    // Repeating DELETE also retries cleanup if an earlier R2 or DO operation
    // failed after the authoritative D1 row had already been removed.
    await runModuleHooks("mailboxDeleted", c.env, mailboxId);

    return c.json({ ok: true as const, mailboxId });
  });
