import { and, eq, exists, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import type { MailboxDelivery } from "../../shared/workspace";
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

/** How an address delivers, as stored: the columns that go together. */
type Delivery = {
  delivery: MailboxDelivery;
  aliasOf: string | null;
  forwardTo: string[] | null;
  catchAll: boolean;
};

/** What a create or update asks for; omitted fields keep `current`. */
type DeliveryInput = {
  delivery?: MailboxDelivery;
  aliasOf?: string | null;
  forwardTo?: string[] | null;
  catchAll?: boolean;
};

/**
 * The delivery to store, or why not. An alias delivers into an inbox or list
 * of the same owner or team; a forward goes to outside addresses only; only
 * an inbox can be its domain's catch-all, one per domain.
 */
async function resolveDelivery(
  db: Database,
  input: DeliveryInput,
  address: {
    id: string | null;
    domain: string;
    ownerUserId: string | null;
    teamId: string | null;
    current: Delivery | null;
  }
): Promise<{ delivery: Delivery } | { refusal: string }> {
  const delivery = input.delivery ?? address.current?.delivery ?? "inbox";

  const aliasOf =
    delivery === "alias"
      ? (input.aliasOf ?? address.current?.aliasOf ?? null)
      : null;

  const forwardTo =
    delivery === "forward"
      ? (input.forwardTo ?? address.current?.forwardTo ?? null)
      : null;

  const catchAll = input.catchAll ?? address.current?.catchAll ?? false;

  if (delivery === "list" && !address.teamId) {
    return { refusal: "Only a team address can be a mailing list" };
  }

  if (catchAll && delivery !== "inbox") {
    return {
      refusal: "Only an address with its own mailbox can be a catch-all",
    };
  }

  if (delivery === "alias") {
    if (!aliasOf || aliasOf === address.id) {
      return { refusal: "Choose the mailbox this alias delivers into" };
    }

    const [target] = await db
      .select({
        delivery: mailboxes.delivery,
        ownerUserId: mailboxes.ownerUserId,
        teamId: mailboxes.teamId,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, aliasOf))
      .limit(1);

    if (
      !target ||
      (target.delivery !== "inbox" && target.delivery !== "list") ||
      target.ownerUserId !== address.ownerUserId ||
      target.teamId !== address.teamId
    ) {
      return {
        refusal: address.ownerUserId
          ? "An alias delivers into one of the same person's mailboxes"
          : "An alias delivers into one of the same team's addresses",
      };
    }
  }

  if (delivery === "forward") {
    if (!forwardTo?.length) return { refusal: "Add an address to forward to" };

    // Mail for the workspace's own domains arrives here again: a loop.
    if (forwardTo.some((destination) => mailDomainAllowed(destination))) {
      return { refusal: "Forward to addresses outside the workspace" };
    }
  }

  if (catchAll) {
    const [other] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.domain, address.domain),
          eq(mailboxes.catchAll, true),
          address.id ? ne(mailboxes.id, address.id) : undefined
        )
      )
      .limit(1);

    if (other) {
      return {
        refusal: `Another address is the catch-all for ${address.domain}`,
      };
    }
  }

  return { delivery: { delivery, aliasOf, forwardTo, catchAll } };
}

/** Lets modules act on a stored address; a failure doesn't undo the save. */
async function announceMailboxSaved(env: Env, mailboxId: string) {
  try {
    await runModuleHooks("mailboxSaved", env, mailboxId);
  } catch (error) {
    console.error(`A module could not handle saving ${mailboxId}`, error);
  }
}

/**
 * Deletes an address the way the admin API does: its aliases first, each
 * through this same path, then the row, its `mailbox.deleted` webhook and
 * every module's `mailboxDeleted` hook. Repeating it retries the hooks.
 */
export async function deleteMailboxAddress(
  env: Env,
  db: Database,
  mailboxId: string,
  defer: (task: Promise<unknown>) => void
): Promise<"deleted" | "primary" | "changed"> {
  const webhookMailbox = await mailboxWebhookData(db, mailboxId);

  if (webhookMailbox?.isPrimary) return "primary";

  const aliases = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.aliasOf, mailboxId));

  // An alias has no aliases of its own, so this goes one level deep.
  const aliasResults = await Promise.all(
    aliases.map((alias) => deleteMailboxAddress(env, db, alias.id, defer))
  );

  if (aliasResults.some((result) => result !== "deleted")) return "changed";

  if (webhookMailbox) {
    // D1 is the access authority. Remove it first so no new authenticated
    // request can reach mailbox data while the cross-service cleanup runs.
    // An alias added meanwhile fails this on its foreign key: try again.
    const deleted = await db
      .delete(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.isPrimary, false)))
      .returning({ id: mailboxes.id })
      .then(
        (rows) => rows[0],
        () => null
      );

    if (deleted === null) return "changed";

    if (deleted) {
      deferWebhookTask(defer, (eventId) =>
        queueMailboxWebhookEvent(
          env,
          "mailbox.deleted",
          webhookMailbox,
          eventId
        )
      );
    } else {
      const [current] = await db
        .select({ isPrimary: mailboxes.isPrimary })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);

      if (current) return current.isPrimary ? "primary" : "changed";
    }
  }

  // Repeating DELETE also retries cleanup if an earlier R2 or DO operation
  // failed after the authoritative D1 row had already been removed.
  await runModuleHooks("mailboxDeleted", env, mailboxId);

  return "deleted";
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
    const teamId = input.ownerUserId ? null : input.teamId;

    const resolved = await resolveDelivery(db, input, {
      id: null,
      domain: address.domain,
      ownerUserId: input.ownerUserId,
      teamId,
      current: null,
    });

    if ("refusal" in resolved) {
      return apiError(c, 400, "BAD_REQUEST", resolved.refusal);
    }

    const { delivery } = resolved;

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
        teamId,
        ...delivery,
        listPosting: input.listPosting,
        // A person's first address is their primary, and needs a mailbox.
        isPrimary: Boolean(
          input.ownerUserId && !existingPrimary && delivery.delivery === "inbox"
        ),
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

    await announceMailboxSaved(c.env, id);

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
        .select({
          id: mailboxes.id,
          domain: mailboxes.domain,
          ownerUserId: mailboxes.ownerUserId,
          teamId: mailboxes.teamId,
          isPrimary: mailboxes.isPrimary,
          delivery: mailboxes.delivery,
          aliasOf: mailboxes.aliasOf,
          forwardTo: mailboxes.forwardTo,
          catchAll: mailboxes.catchAll,
        })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);

      if (!mailbox) return apiError(c, 404, "NOT_FOUND", "Mailbox not found");
      const refused = await mailboxRefusal(c, db, mailbox);

      if (refused) return refused;

      if (mailbox.ownerUserId && input.teamId) {
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

      const resolved = await resolveDelivery(db, input, {
        id: mailbox.id,
        domain: mailbox.domain,
        ownerUserId: mailbox.ownerUserId,
        teamId: input.teamId ?? mailbox.teamId,
        current: mailbox,
      });

      if ("refusal" in resolved) {
        return apiError(c, 400, "BAD_REQUEST", resolved.refusal);
      }

      const { delivery } = resolved;

      if (mailbox.isPrimary && delivery.delivery !== "inbox") {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "A primary address keeps its own mailbox"
        );
      }

      if (delivery.delivery === "alias" || delivery.delivery === "forward") {
        const [alias] = await db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(eq(mailboxes.aliasOf, mailboxId))
          .limit(1);

        if (alias) {
          return apiError(
            c,
            409,
            "CONFLICT",
            "Aliases deliver into this address; delete them first"
          );
        }
      }

      try {
        await db
          .update(mailboxes)
          .set({
            // Drizzle leaves the columns of omitted (undefined) fields unchanged.
            displayName: input.displayName,
            teamId: input.teamId,
            ...delivery,
            listPosting: input.listPosting,
            updatedAt: new Date(),
          })
          .where(eq(mailboxes.id, mailboxId));
      } catch {
        // Another address became the domain's catch-all meanwhile.
        return apiError(
          c,
          409,
          "CONFLICT",
          `Another address is the catch-all for ${mailbox.domain}`
        );
      }

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

      await announceMailboxSaved(c.env, mailboxId);

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
        delivery: mailboxes.delivery,
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

    if (mailbox.delivery !== "inbox") {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "Only an address with its own mailbox can be primary"
      );
    }

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

    const result = await deleteMailboxAddress(c.env, db, mailboxId, (task) =>
      c.executionCtx.waitUntil(task)
    );

    if (result !== "deleted") {
      return apiError(
        c,
        409,
        "CONFLICT",
        result === "primary"
          ? "Primary mailbox cannot be deleted"
          : "Mailbox changed; try deleting it again"
      );
    }

    return c.json({ ok: true as const, mailboxId });
  });
