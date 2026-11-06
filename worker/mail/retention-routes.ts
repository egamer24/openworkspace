import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { mailboxStub } from "../mailbox";
import { getMailboxAccess } from "./access";

const retentionDays = z.number().int().min(1).max(365).nullable();

export const retentionSchema = z.object({
  trashDays: retentionDays,
  spamDays: retentionDays,
});

function retentionResponse(settings: { trashDays: number | null; spamDays: number | null } | null) {
  return {
    ok: true as const,
    retention: {
      trashDays: settings?.trashDays ?? null,
      spamDays: settings?.spamDays ?? null,
    },
  };
}

async function access(env: Env, userId: string, mailboxId: string) {
  return getMailboxAccess(createDb(env.DB), userId, mailboxId);
}

/**
 * Mounted at /mail/mailboxes/:id. Middleware is per route so it does not run
 * for the other /mail/mailboxes/:id/* routes owned by mailRoutes.
 */
export const retentionRoutes = new Hono<AppEnv>()
  .get("/retention", requireAuth, async (c) => {
    const mailboxId = c.req.param("id") ?? "";
    if (!await access(c.env, c.get("user").id, mailboxId)) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    return c.json(retentionResponse(await mailboxStub(c.env, mailboxId).getRetention()));
  })
  .put("/retention", requireAuth, zValidator("json", retentionSchema), async (c) => {
    const mailboxId = c.req.param("id") ?? "";
    if (!(await access(c.env, c.get("user").id, mailboxId))?.canSend) {
      return apiError(c, 403, "FORBIDDEN", "Send access is required to delete mail permanently");
    }
    const settings = await mailboxStub(c.env, mailboxId)
      .setRetention(c.req.valid("json"), c.get("user").id);
    return c.json(retentionResponse(settings));
  })
  .post(
    "/folders/:folder/empty",
    requireAuth,
    zValidator("param", z.object({ id: z.string(), folder: z.enum(["trash", "spam"]) })),
    async (c) => {
      const { id: mailboxId, folder } = c.req.valid("param");
      if (!(await access(c.env, c.get("user").id, mailboxId))?.canSend) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required to delete mail permanently");
      }
      const result = await mailboxStub(c.env, mailboxId).emptyFolder(folder);
      return c.json({ ok: true as const, ...result });
    },
  );
