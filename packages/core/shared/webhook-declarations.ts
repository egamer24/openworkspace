import { z } from "zod";

import { webhookEventPattern } from "./webhooks.ts";

/*
 * Webhook endpoints declared in alchemy.run.ts. Unlike single sign-on apps a
 * declaration carries its signing secret (the Worker signs with it), so the
 * list is bound as a Worker secret, DECLARED_WEBHOOKS.
 */
export const declaredWebhookSchema = z.object({
  id: z.string().regex(/^whk_[a-f0-9]{32}$/u),
  name: z.string().trim().min(2).max(80),
  url: z
    .string()
    .url()
    .max(2048)
    .refine(
      (value) => new URL(value).protocol === "https:",
      "Use an https:// URL"
    ),
  /** Checked against the events the workspace sends when the Worker applies it. */
  events: z
    .array(
      z
        .string()
        .regex(webhookEventPattern, "Use an event type such as user.joined")
    )
    .min(1),
  enabled: z.boolean().default(true),
  /** A Standard Webhooks secret: `whsec_` and base64. */
  secret: z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/u),
});

export const declaredWebhooksSchema = z.array(declaredWebhookSchema).max(20);

export type DeclaredWebhook = z.infer<typeof declaredWebhookSchema>;
