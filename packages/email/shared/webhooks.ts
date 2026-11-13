import type { WebhookEventDeclaration } from "@open-workspace/core/shared";

/** The webhook events the mail module sends. */
export const EMAIL_RECEIVED_EVENT = "email.received";
export const EMAIL_SENT_EVENT = "email.sent";

export type EmailWebhookEvent =
  | typeof EMAIL_RECEIVED_EVENT
  | typeof EMAIL_SENT_EVENT;

/**
 * The module's events as core offers them (`webhookEvents` on its server and
 * browser halves). Both carry a mailbox's mail.
 */
export const emailWebhookEvents: Record<
  EmailWebhookEvent,
  WebhookEventDeclaration
> = {
  [EMAIL_RECEIVED_EVENT]: {
    label: "Email received",
    description: "After spam and AI routing, including text and HTML body.",
    mailboxes: true,
  },
  [EMAIL_SENT_EVENT]: {
    label: "Email sent",
    description: "After an outgoing message is persisted and submitted.",
    mailboxes: true,
  },
};

/** The kind of webhook source the module queues: a message in a mailbox (worker/mail/webhook-source.ts). */
export const EMAIL_WEBHOOK_SOURCE = "email";

/** The stable id of a mail event, so a retried queue message is delivered once. */
export function emailWebhookEventId(
  eventType: EmailWebhookEvent,
  mailboxId: string,
  messageId: string
) {
  return `evt_${eventType.replace(".", "_")}_${mailboxId}_${messageId}`;
}
