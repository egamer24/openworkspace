import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { createDb } from "../db/client";
import { webhookEndpoints } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { zValidator } from "../lib/validator";
import { webhookEndpointInputSchema } from "../webhooks/schemas";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookSettings,
  queueWebhookTest,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  WebhookEndpointLimitError,
  WebhookMailboxError,
} from "../webhooks/service";
import { rejectDeploymentManaged } from "./managed-apps";

export const webhookAdminRoutes = new Hono<AppEnv>()
  .on(
    ["PUT", "DELETE", "POST"],
    ["/:id", "/:id/rotate-secret"],
    rejectDeploymentManaged("webhook")
  )
  .get("/", async (c) =>
    c.json({
      ok: true as const,
      ...(await listWebhookSettings(createDb(c.env.DB), c.get("user").id)),
    })
  )
  .post("/", zValidator("json", webhookEndpointInputSchema), async (c) => {
    try {
      const result = await createWebhookEndpoint(
        createDb(c.env.DB),
        c.get("user").id,
        c.req.valid("json")
      );

      return c.json({ ok: true as const, ...result }, 201);
    } catch (error) {
      if (error instanceof WebhookEndpointLimitError) {
        return apiError(c, 409, "CONFLICT", error.message);
      }

      if (error instanceof WebhookMailboxError) {
        return apiError(c, 403, "FORBIDDEN", error.message);
      }

      throw error;
    }
  })
  .put("/:id", zValidator("json", webhookEndpointInputSchema), async (c) => {
    let webhook: Awaited<ReturnType<typeof updateWebhookEndpoint>>;

    try {
      webhook = await updateWebhookEndpoint(
        createDb(c.env.DB),
        c.req.param("id"),
        c.get("user").id,
        c.req.valid("json")
      );
    } catch (error) {
      if (error instanceof WebhookMailboxError) {
        return apiError(c, 403, "FORBIDDEN", error.message);
      }

      throw error;
    }

    if (!webhook) {
      return apiError(c, 404, "NOT_FOUND", "Webhook endpoint not found");
    }

    return c.json({ ok: true as const, webhook });
  })
  .delete("/:id", async (c) => {
    if (!(await deleteWebhookEndpoint(createDb(c.env.DB), c.req.param("id")))) {
      return apiError(c, 404, "NOT_FOUND", "Webhook endpoint not found");
    }

    return c.json({ ok: true as const });
  })
  .post("/:id/rotate-secret", async (c) => {
    const result = await rotateWebhookSecret(
      createDb(c.env.DB),
      c.req.param("id")
    );

    if (!result) {
      return apiError(c, 404, "NOT_FOUND", "Webhook endpoint not found");
    }

    return c.json({ ok: true as const, ...result });
  })
  .post("/:id/test", async (c) => {
    const [endpoint] = await createDb(c.env.DB)
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, c.req.param("id")))
      .limit(1);

    if (!endpoint) {
      return apiError(c, 404, "NOT_FOUND", "Webhook endpoint not found");
    }

    await queueWebhookTest(c.env, endpoint.id);

    return c.json({ ok: true as const }, 202);
  });
