import { z } from "zod";

import { jsonObjectSchema, jsonValueSchema } from "../lib/json";

/**
 * What core keeps in its JSON columns. D1 hands a column back as whatever
 * JSON it holds, so readers parse it with these schemas.
 */

/**
 * `auth_challenges.payload`: a passkey ceremony's context. Bootstrap keeps
 * the first account it creates, sign-in the identity request it finishes.
 */
export const challengePayloadSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  userId: z.string().optional(),
  oidcRequestId: z.string().optional(),
  samlRequestId: z.string().optional(),
});

export type ChallengePayload = z.infer<typeof challengePayloadSchema>;

/** `oidc_audit_events.detail`: what an audited change touched. */
export type OidcAuditDetail = { teamId: string } | { scopes: string[] };

/** A core event's source: its payload itself. */
const coreWebhookSourceSchema = z.object({
  kind: z.literal("data"),
  data: jsonObjectSchema,
});

/**
 * A source a module queued: its kind, the mailbox for a mailbox event
 * (`WebhookEventDeclaration.mailboxes`), and whatever else its builder reads.
 */
const moduleWebhookSourceSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .refine((kind) => kind !== "data"),
    mailboxId: z.string().min(1).optional(),
  })
  .catchall(jsonValueSchema);

export type ModuleWebhookSource = z.infer<typeof moduleWebhookSourceSchema>;

/** `webhook_deliveries.source`, and a dispatch job's: what the event's payload is built from. */
export const webhookSourceSchema = z.union([
  coreWebhookSourceSchema,
  moduleWebhookSourceSchema,
]);

export type WebhookEventSource = z.infer<typeof webhookSourceSchema>;
