import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { mailboxStub } from "../mailbox";
import { getMailboxAccess } from "./access";
import {
  spamSenderEntrySchema,
  spamSenderSchema,
  spamSettingsSchema,
} from "./schemas";

/** Reading needs mailbox access; changing the filter needs send access. */
async function mailboxPermission(c: Context<AppEnv>, permission: "read" | "send") {
  const access = await getMailboxAccess(
    createDb(c.env.DB),
    c.get("user").id,
    c.req.param("id") ?? "",
  );
  if (!access) return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
  if (permission === "send" && !access.canSend) {
    return apiError(c, 403, "FORBIDDEN", "Send access is required to change the spam filter");
  }
  return null;
}

export const spamRoutes = new Hono<AppEnv>()
  .get("/spam", requireAuth, async (c) => {
    const denied = await mailboxPermission(c, "read");
    if (denied) return denied;
    return c.json({
      ok: true as const,
      settings: await mailboxStub(c.env, c.req.param("id")!).getSpamSettings(),
    });
  })
  .put(
    "/spam",
    requireAuth,
    zValidator("json", spamSettingsSchema),
    async (c) => {
      const denied = await mailboxPermission(c, "send");
      if (denied) return denied;
      return c.json({
        ok: true as const,
        settings: await mailboxStub(c.env, c.req.param("id")!)
          .setSpamSettings(c.req.valid("json")),
      });
    },
  )
  .get("/spam/learning", requireAuth, async (c) => {
    const denied = await mailboxPermission(c, "read");
    if (denied) return denied;
    return c.json({
      ok: true as const,
      learning: await mailboxStub(c.env, c.req.param("id")!).getSpamLearning(),
    });
  })
  .delete("/spam/learning", requireAuth, async (c) => {
    const denied = await mailboxPermission(c, "send");
    if (denied) return denied;
    return c.json({
      ok: true as const,
      learning: await mailboxStub(c.env, c.req.param("id")!).resetSpamLearning(),
    });
  })
  .put(
    "/spam/senders/:entry",
    requireAuth,
    zValidator("json", spamSenderSchema),
    async (c) => {
      const denied = await mailboxPermission(c, "send");
      if (denied) return denied;
      const entry = spamSenderEntrySchema.safeParse(c.req.param("entry"));
      if (!entry.success) {
        return apiError(c, 400, "BAD_REQUEST", "Enter an email address or a domain");
      }
      const result = await mailboxStub(c.env, c.req.param("id")!)
        .setSpamSender(entry.data, c.req.valid("json").list);
      if (result.status === "limit") {
        return apiError(c, 409, "CONFLICT", "The allow and block lists are full");
      }
      return c.json({ ok: true as const, settings: result.settings });
    },
  )
  .delete("/spam/senders/:entry", requireAuth, async (c) => {
    const denied = await mailboxPermission(c, "send");
    if (denied) return denied;
    const entry = spamSenderEntrySchema.safeParse(c.req.param("entry"));
    if (!entry.success) {
      return apiError(c, 400, "BAD_REQUEST", "Enter an email address or a domain");
    }
    const settings = await mailboxStub(c.env, c.req.param("id")!)
      .removeSpamSender(entry.data);
    if (!settings) return apiError(c, 404, "NOT_FOUND", "Entry not found");
    return c.json({ ok: true as const, settings });
  });
