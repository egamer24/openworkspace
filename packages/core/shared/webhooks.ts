/**
 * A webhook event as people read it in the webhook editor. Core declares its
 * own below; a module declares the events it sends (`webhookEvents` on its
 * `WorkspaceModule` and `ClientModule`, one shared constant).
 */
export type WebhookEventDeclaration = {
  label: string;
  description: string;
  /**
   * The event carries a mailbox's mail: an endpoint subscribed to it names
   * the mailboxes it covers, and gets their mail only while the person who
   * saved it can open them. Its source names the mailbox (`mailboxId`).
   */
  mailboxes?: boolean;
};

/** An event's type: area, a dot, a name, e.g. user.joined. */
export type WebhookEventType = string;

/** What every webhook event type looks like. */
export const webhookEventPattern = /^[a-z][a-z_]*\.[a-z][a-z_]*$/u;

/** The events core sends. */
export const coreWebhookEvents = {
  "user.joined": {
    label: "User joined",
    description: "When an invited user completes registration.",
  },
  "user.updated": {
    label: "User updated",
    description: "Name, role, or account status changed by an administrator.",
  },
  "mailbox.created": {
    label: "Mailbox created",
    description: "A personal or shared mailbox was provisioned.",
  },
  "mailbox.updated": {
    label: "Mailbox updated",
    description: "Display name or shared membership changed.",
  },
  "mailbox.deleted": {
    label: "Mailbox deleted",
    description: "A mailbox was permanently removed.",
  },
} satisfies Record<WebhookEventType, WebhookEventDeclaration>;

/** The modules' events first, in their order, then core's. */
export function mergeWebhookEvents(
  modules: readonly {
    webhookEvents?: Record<string, WebhookEventDeclaration>;
  }[]
) {
  const merged: Record<WebhookEventType, WebhookEventDeclaration> = {};

  for (const module of modules) Object.assign(merged, module.webhookEvents);
  Object.assign(merged, coreWebhookEvents);

  return merged;
}

export const webhookDeliveryStatuses = [
  "pending",
  "delivered",
  "failed",
] as const;

export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];
