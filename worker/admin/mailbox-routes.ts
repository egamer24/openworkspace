import { zValidator } from "@hono/zod-validator";
import { and, eq, exists } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { domains, mailboxMembers, mailboxes, users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId, mailboxAddressParts } from "../lib/ids";
import { deleteMailboxStorage } from "../mail/mailbox-deletion";
import {
  deferWebhookTask,
  mailboxWebhookData,
  queueMailboxWebhookEvent,
  queueUserWebhookEvent,
} from "../webhooks/service";
import { domainForAddress, hasKnownUserIds } from "./records";
import { checkRateLimit } from "../lib/rate-limit";
import { inboundDeliveryId } from "../mail/inbound-delivery";
import { mailboxStub } from "../mailbox";
import { mailboxAddressSql } from "../db/mailboxes";
import {
  createMailboxSchema,
  mailImportQuerySchema,
  updateMailboxSchema,
} from "./schemas";

// Cloudflare Email Routing accepts messages up to 25 MiB.
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export const mailboxAdminRoutes = new Hono<AppEnv>()
  .post(
    "/mailboxes",
    zValidator("json", createMailboxSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const domain = await domainForAddress(db, input.address);
      if (!domain) {
        return apiError(c, 400, "BAD_REQUEST", "Mailbox domain is not configured");
      }
      if (
        input.ownerUserId
          ? !(await hasKnownUserIds(db, [input.ownerUserId]))
          : !(await hasKnownUserIds(
            db,
            input.members.map((member) => member.userId),
          ))
      ) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown mailbox member");
      }
      const id = createId("mbx");
      const now = new Date();
      const address = mailboxAddressParts(input.address);
      const members = input.ownerUserId
        ? [{ userId: input.ownerUserId, canSend: true }]
        : input.members;
      const [existingPrimary] = input.ownerUserId
        ? await db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(and(
            eq(mailboxes.ownerUserId, input.ownerUserId),
            eq(mailboxes.isPrimary, true),
          ))
          .limit(1)
        : [];
      try {
        await db.batch([
          db.insert(mailboxes).values({
            id,
            localPart: address.localPart,
            domainId: domain.id,
            displayName: input.displayName,
            ownerUserId: input.ownerUserId,
            isPrimary: Boolean(input.ownerUserId && !existingPrimary),
            createdByUserId: c.get("user").id,
            createdAt: now,
            updatedAt: now,
          }),
          ...members.map((member) =>
            db.insert(mailboxMembers).values({
              mailboxId: id,
              userId: member.userId,
              canSend: member.canSend,
              createdAt: now,
            }),
          ),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Mailbox address is already in use");
      }
      const webhookMailbox = await mailboxWebhookData(db, id);
      if (webhookMailbox) {
        deferWebhookTask(
          (task) => c.executionCtx.waitUntil(task),
          (eventId) => queueMailboxWebhookEvent(
            c.env,
            "mailbox.created",
            webhookMailbox,
            eventId,
          ),
        );
      }
      return c.json({ ok: true as const, mailboxId: id }, 201);
    },
  )
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
      if (mailbox.ownerUserId) {
        return apiError(c, 400, "BAD_REQUEST", "Personal mailbox access follows its owner");
      }
      if (!(await hasKnownUserIds(
        db,
        input.members.map((member) => member.userId),
      ))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown mailbox member");
      }
      const now = new Date();
      await db.batch([
        db
          .update(mailboxes)
          .set({ displayName: input.displayName, updatedAt: now })
          .where(eq(mailboxes.id, mailboxId)),
        db.delete(mailboxMembers).where(eq(mailboxMembers.mailboxId, mailboxId)),
        ...input.members.map((member) =>
          db.insert(mailboxMembers).values({
            mailboxId,
            userId: member.userId,
            canSend: member.canSend,
            createdAt: now,
          }),
        ),
      ]);
      const webhookMailbox = await mailboxWebhookData(db, mailboxId);
      if (webhookMailbox) {
        deferWebhookTask(
          (task) => c.executionCtx.waitUntil(task),
          (eventId) => queueMailboxWebhookEvent(
            c.env,
            "mailbox.updated",
            webhookMailbox,
            eventId,
          ),
        );
      }
      return c.json({ ok: true as const });
    },
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
    if (!mailbox.ownerUserId) {
      return apiError(c, 400, "BAD_REQUEST", "Shared mailbox cannot be primary");
    }
    if (mailbox.isPrimary) return c.json({ ok: true as const });
    const now = new Date();
    const targetExists = exists(
      db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(
          eq(mailboxes.id, mailboxId),
          eq(mailboxes.ownerUserId, mailbox.ownerUserId),
        )),
    );
    const [previousPrimaryRows, , promoted] = await db.batch([
      db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(
          eq(mailboxes.ownerUserId, mailbox.ownerUserId),
          eq(mailboxes.isPrimary, true),
        ))
        .limit(1),
      db
        .update(mailboxes)
        .set({ isPrimary: false, updatedAt: now })
        .where(and(
          eq(mailboxes.ownerUserId, mailbox.ownerUserId),
          eq(mailboxes.isPrimary, true),
          targetExists,
        )),
      db
        .update(mailboxes)
        .set({ isPrimary: true, updatedAt: now })
        .where(and(
          eq(mailboxes.id, mailboxId),
          eq(mailboxes.ownerUserId, mailbox.ownerUserId),
        ))
        .returning({ id: mailboxes.id }),
      db
        .update(users)
        .set({ updatedAt: now })
        .where(and(
          eq(users.id, mailbox.ownerUserId),
          targetExists,
        )),
    ]);
    if (promoted.length === 0) {
      return apiError(c, 404, "NOT_FOUND", "Mailbox not found");
    }
    deferWebhookTask(
      (task) => c.executionCtx.waitUntil(task),
      (eventId) => queueUserWebhookEvent(
        c.env,
        "user.updated",
        mailbox.ownerUserId!,
        eventId,
      ),
    );
    const changedMailboxIds = new Set(
      [previousPrimaryRows[0]?.id, mailboxId]
        .filter((id): id is string => Boolean(id)),
    );
    const changedMailboxes = await Promise.all(
      [...changedMailboxIds]
        .map((id) => mailboxWebhookData(db, id)),
    );
    for (const changedMailbox of changedMailboxes) {
      if (!changedMailbox) continue;
      deferWebhookTask(
        (task) => c.executionCtx.waitUntil(task),
        (eventId) => queueMailboxWebhookEvent(
          c.env,
          "mailbox.updated",
          changedMailbox,
          eventId,
        ),
      );
    }
    return c.json({ ok: true as const });
  })
  .delete("/mailboxes/:id", async (c) => {
    const db = createDb(c.env.DB);
    const mailboxId = c.req.param("id");
    const webhookMailbox = await mailboxWebhookData(db, mailboxId);
    if (webhookMailbox?.isPrimary) {
      return apiError(
        c,
        409,
        "CONFLICT",
        "Primary mailbox cannot be deleted",
      );
    }

    if (webhookMailbox) {
      // D1 is the access authority. Remove it first so no new authenticated
      // request can reach mailbox data while the cross-service cleanup runs.
      const [deleted] = await db
        .delete(mailboxes)
        .where(and(
          eq(mailboxes.id, mailboxId),
          eq(mailboxes.isPrimary, false),
        ))
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
              : "Mailbox changed; try deleting it again",
          );
        }
        await deleteMailboxStorage(c.env, mailboxId);
        return c.json({ ok: true as const, mailboxId });
      }
      deferWebhookTask(
        (task) => c.executionCtx.waitUntil(task),
        (eventId) => queueMailboxWebhookEvent(
          c.env,
          "mailbox.deleted",
          webhookMailbox,
          eventId,
        ),
      );
    }
    // Repeating DELETE also retries cleanup if an earlier R2 or DO operation
    // failed after the authoritative D1 row had already been removed.
    await deleteMailboxStorage(c.env, mailboxId);
    return c.json({ ok: true as const, mailboxId });
  })
  .post(
    "/mailboxes/:id/import",
    zValidator("query", mailImportQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const mailboxId = c.req.param("id");
      const declaredLength = Number(c.req.header("content-length") ?? 0);
      if (declaredLength > MAX_IMPORT_BYTES) {
        return apiError(c, 413, "PAYLOAD_TOO_LARGE", "Message exceeds 25 MiB");
      }
      const db = createDb(c.env.DB);
      const [mailbox] = await db
        .select({ address: mailboxAddressSql })
        .from(mailboxes)
        .innerJoin(domains, eq(mailboxes.domainId, domains.id))
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);
      if (!mailbox) return apiError(c, 404, "NOT_FOUND", "Mailbox not found");

      const rate = await checkRateLimit(c.env.DB, {
        action: "mail-import",
        identifier: c.get("user").id,
        limit: 600,
        windowMs: 60_000,
      });
      if (!rate.allowed) {
        c.header("retry-after", String(rate.retryAfterSeconds));
        return apiError(c, 429, "RATE_LIMITED", "Too many imports");
      }

      const raw = await c.req.arrayBuffer();
      if (raw.byteLength === 0) {
        return apiError(c, 400, "BAD_REQUEST", "Message body is required");
      }
      if (raw.byteLength > MAX_IMPORT_BYTES) {
        return apiError(c, 413, "PAYLOAD_TOO_LARGE", "Message exceeds 25 MiB");
      }

      const readers = query.seen
        ? await db
          .select({ userId: mailboxMembers.userId })
          .from(mailboxMembers)
          .where(eq(mailboxMembers.mailboxId, mailboxId))
        : [];
      // A fixed envelope keeps re-runs idempotent and separate from live delivery ids.
      const deliveryId = await inboundDeliveryId({
        mailboxId,
        envelopeFrom: "import",
        envelopeTo: mailbox.address,
        raw,
      });
      const rawObjectKey = `mailboxes/${mailboxId}/raw/${deliveryId}.eml`;
      await c.env.MAIL_STORAGE.put(rawObjectKey, raw, {
        httpMetadata: { contentType: "message/rfc822" },
      });
      const result = await mailboxStub(c.env, mailboxId).importEmail({
        deliveryId,
        rawObjectKey,
        raw,
        mailboxAddress: mailbox.address,
        direction: query.direction,
        state: query.state,
        folder: query.folder ?? null,
        seen: query.seen,
        readerUserIds: readers.map((reader) => reader.userId),
        receivedAt: query.receivedAt?.getTime() ?? null,
      });
      if (result.status === "unparseable" || result.status === "invalid_folder") {
        if (result.status === "unparseable") {
          await c.env.MAIL_STORAGE.delete(rawObjectKey);
        }
        return apiError(c, 400, "BAD_REQUEST", result.message);
      }
      return c.json({ ok: true as const, ...result });
    },
  );

