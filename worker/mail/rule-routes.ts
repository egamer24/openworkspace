import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { mailboxStub } from "../mailbox";
import { getMailboxAccess } from "./access";
import { ruleInputSchema } from "./rules";

const ruleIdParam = z.object({ id: z.string(), ruleId: z.string().min(1).max(80) });

/** Rules can forward mail and reveal forwarding addresses, so all routes need send access. */
async function sendAccess(c: Context<AppEnv>) {
  const mailboxId = c.req.param("id") ?? "";
  const access = await getMailboxAccess(createDb(c.env.DB), c.get("user").id, mailboxId);
  return access?.canSend ? mailboxId : null;
}

const forbidden = (c: Context<AppEnv>) =>
  apiError(c, 403, "FORBIDDEN", "Send access is required to manage rules");

/**
 * Mounted at /mail/mailboxes/:id. Middleware is per route so it does not run
 * for the other /mail/mailboxes/:id/* routes owned by mailRoutes.
 */
export const ruleRoutes = new Hono<AppEnv>()
  .get("/rules", requireAuth, async (c) => {
    const mailboxId = await sendAccess(c);
    if (!mailboxId) return forbidden(c);
    return c.json({ ok: true as const, rules: await mailboxStub(c.env, mailboxId).listRules() });
  })
  .post("/rules", requireAuth, zValidator("json", ruleInputSchema), async (c) => {
    const mailboxId = await sendAccess(c);
    if (!mailboxId) return forbidden(c);
    const result = await mailboxStub(c.env, mailboxId).createRule(c.req.valid("json"), c.get("user").id);
    if (result.status === "invalid") return apiError(c, 400, "BAD_REQUEST", result.error);
    if (result.status === "limit") return apiError(c, 409, "CONFLICT", "A mailbox can have at most 100 rules");
    return c.json({ ok: true as const, rule: result.rule }, 201);
  })
  .post(
    "/rules/test",
    requireAuth,
    zValidator("json", ruleInputSchema.pick({ match: true, conditions: true })),
    async (c) => {
      const mailboxId = await sendAccess(c);
      if (!mailboxId) return forbidden(c);
      return c.json({ ok: true as const, ...await mailboxStub(c.env, mailboxId).testRule(c.req.valid("json")) });
    },
  )
  .put(
    "/rules/order",
    requireAuth,
    zValidator("json", z.object({ ruleIds: z.array(z.string().min(1).max(80)).max(100) })),
    async (c) => {
      const mailboxId = await sendAccess(c);
      if (!mailboxId) return forbidden(c);
      if (!await mailboxStub(c.env, mailboxId).reorderRules(c.req.valid("json").ruleIds)) {
        return apiError(c, 409, "CONFLICT", "Rules changed; reload and try again");
      }
      return c.json({ ok: true as const });
    },
  )
  .put(
    "/rules/:ruleId",
    requireAuth,
    zValidator("param", ruleIdParam),
    zValidator("json", ruleInputSchema),
    async (c) => {
      const mailboxId = await sendAccess(c);
      if (!mailboxId) return forbidden(c);
      const result = await mailboxStub(c.env, mailboxId)
        .updateRule(c.req.valid("param").ruleId, c.req.valid("json"));
      if (result.status === "invalid") return apiError(c, 400, "BAD_REQUEST", result.error);
      if (result.status === "not_found") return apiError(c, 404, "NOT_FOUND", "Rule not found");
      return c.json({ ok: true as const, rule: result.rule });
    },
  )
  .delete("/rules/:ruleId", requireAuth, zValidator("param", ruleIdParam), async (c) => {
    const mailboxId = await sendAccess(c);
    if (!mailboxId) return forbidden(c);
    if (!await mailboxStub(c.env, mailboxId).deleteRule(c.req.valid("param").ruleId)) {
      return apiError(c, 404, "NOT_FOUND", "Rule not found");
    }
    return c.json({ ok: true as const });
  });
