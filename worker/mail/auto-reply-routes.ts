import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import { mailboxes } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { mailboxStub } from "../mailbox";
import { getMailboxAccess } from "./access";
import { autoReplyAudiences, autoReplyStatus } from "./auto-reply";

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const autoReplySchema = z.object({
  enabled: z.boolean(),
  startsAt: timestamp.nullable().default(null),
  endsAt: timestamp.nullable().default(null),
  timeZone: z.string().trim().max(64).nullable().default(null),
  subject: z.string().trim().max(998).nullable().default(null)
    .transform((value) => value || null),
  bodyText: z.string().trim().max(10_000).default(""),
  audience: z.enum(autoReplyAudiences).default("everyone"),
  skipInternal: z.boolean().default(true),
  replyIntervalDays: z.number().int().min(1).max(30).default(4),
}).superRefine((value, context) => {
  if (value.enabled && !value.bodyText) {
    context.addIssue({ code: "custom", path: ["bodyText"], message: "Add a message for the automatic reply" });
  }
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start" });
  }
});

/** Owners and read-and-send members manage a mailbox's auto-reply; admins manage any. */
async function canManage(env: Env, user: AppEnv["Variables"]["user"], mailboxId: string) {
  const db = createDb(env.DB);
  const access = await getMailboxAccess(db, user.id, mailboxId);
  if (access) return access.canSend;
  if (user.role !== "admin") return false;
  const [mailbox] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);
  return Boolean(mailbox);
}

async function autoReplyResponse(env: Env, mailboxId: string) {
  const stub = mailboxStub(env, mailboxId);
  const [settings, recent] = await Promise.all([
    stub.getAutoReply(),
    stub.recentAutoReplies(),
  ]);
  return {
    ok: true as const,
    status: autoReplyStatus(settings, new Date()),
    settings: settings && {
      enabled: settings.enabled,
      startsAt: settings.startsAt,
      endsAt: settings.endsAt,
      timeZone: settings.timeZone,
      subject: settings.subject,
      bodyText: settings.bodyText,
      audience: settings.audience,
      skipInternal: settings.skipInternal,
      replyIntervalDays: settings.replyIntervalDays,
      updatedAt: settings.updatedAt,
    },
    recent: recent.map((entry) => ({
      senderAddress: entry.senderAddress,
      repliedAt: entry.lastRepliedAt,
    })),
  };
}

export const autoReplyRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const mailboxId = c.req.param("id") ?? "";
    if (!await canManage(c.env, c.get("user"), mailboxId)) {
      return apiError(c, 403, "FORBIDDEN", "Send access is required");
    }
    return c.json(await autoReplyResponse(c.env, mailboxId));
  })
  .put("/", zValidator("json", autoReplySchema), async (c) => {
    const mailboxId = c.req.param("id") ?? "";
    if (!await canManage(c.env, c.get("user"), mailboxId)) {
      return apiError(c, 403, "FORBIDDEN", "Send access is required");
    }
    await mailboxStub(c.env, mailboxId).setAutoReply(c.req.valid("json"), c.get("user").id);
    return c.json(await autoReplyResponse(c.env, mailboxId));
  });
