import { z } from "zod";

import { isMailboxEvent, workspaceWebhookEvents } from "../modules";

const webhookUrlSchema = z
  .url()
  .max(2048)
  .transform((value, context) => {
    const url = new URL(value);

    if (url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Webhook URL must use HTTPS",
      });

      return z.NEVER;
    }

    if (url.username || url.password || url.hash) {
      context.addIssue({
        code: "custom",
        message: "Webhook URL cannot contain credentials or a fragment",
      });

      return z.NEVER;
    }

    return url.toString();
  });

const webhookEventsSchema = z
  .array(
    z
      .string()
      .refine(
        (event) => event in workspaceWebhookEvents(),
        "This workspace does not send this event"
      )
  )
  .min(1, "Choose at least one event")
  .refine(
    (events) => new Set(events).size === events.length,
    "Events must be unique"
  );

export const webhookEndpointInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    url: webhookUrlSchema,
    events: webhookEventsSchema,
    /**
     * The mailboxes whose mail its mailbox events deliver: required with
     * them, and only mailboxes the person saving the endpoint can open
     * (administrators: any). Mail is delivered only while that stays so.
     */
    mailboxIds: z
      .array(z.string().min(1))
      .max(100)
      .default([])
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Mailboxes must be unique"
      ),
    enabled: z.boolean(),
  })
  .superRefine((input, context) => {
    const mail = input.events.some(isMailboxEvent);

    if (mail && !input.mailboxIds.length) {
      context.addIssue({
        code: "custom",
        path: ["mailboxIds"],
        message: "Choose the mailboxes whose mail it receives",
      });
    }

    if (!mail && input.mailboxIds.length) {
      context.addIssue({
        code: "custom",
        path: ["mailboxIds"],
        message: "Mailboxes are only for mail events",
      });
    }
  });

export type WebhookEndpointInput = z.infer<typeof webhookEndpointInputSchema>;
