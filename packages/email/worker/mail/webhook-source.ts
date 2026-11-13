import {
  createDb,
  mailboxAddressSql,
  mailboxKind,
  mailboxes,
} from "@open-workspace/core/module";
import type { WorkspaceModule } from "@open-workspace/core/module";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import { headerAuthentication } from "./header-metadata";

function publicEmail(email: Email, bodyHtml: string | null) {
  return {
    id: email.id,
    conversationId: email.conversationId,
    direction: email.direction,
    from: email.fromJson,
    to: email.toJson,
    cc: email.ccJson,
    bcc: email.bccJson,
    replyTo: email.replyToJson,
    subject: email.subject,
    body: {
      text: email.bodyText,
      html: bodyHtml,
    },
    attachments: email.attachmentsJson.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      contentId: attachment.contentId,
      disposition: attachment.disposition,
    })),
    authentication: headerAuthentication(email),
    aiClassification: email.aiClassificationJson,
    transportState: email.transportState,
    transportError: email.transportError,
    deliveryStatuses: email.deliveryStatusJson,
    occurredAt: email.timelineAt.toISOString(),
  };
}

/** What outbound-service queues as an `EMAIL_WEBHOOK_SOURCE` source. */
const EmailWebhookSource = z.object({
  mailboxId: z.string(),
  messageId: z.string(),
});

type WebhookSourceBuilder = NonNullable<
  WorkspaceModule["webhookSources"]
>[string];

/** The payload of a mail webhook event, from its `EMAIL_WEBHOOK_SOURCE` source. */
export const emailWebhookData: WebhookSourceBuilder = async (env, queued) => {
  const parsed = EmailWebhookSource.safeParse(queued);

  if (!parsed.success) {
    throw new Error("Email webhook source needs a mailbox and message");
  }

  const source = parsed.data;

  const [mailbox, email] = await Promise.all([
    createDb(env.DB)
      .select({
        id: mailboxes.id,
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
        ownerUserId: mailboxes.ownerUserId,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, source.mailboxId))
      .limit(1)
      .then(([row]) =>
        row ? { ...row, kind: mailboxKind(row.ownerUserId) } : null
      ),
    mailboxStub(env, source.mailboxId).getEmail(source.messageId),
  ]);

  if (!mailbox || !email) throw new Error("Webhook email no longer exists");

  const htmlObject = email.bodyHtmlR2Key
    ? await env.MAIL_STORAGE.get(email.bodyHtmlR2Key)
    : null;

  return {
    mailbox,
    email: publicEmail(email, htmlObject ? await htmlObject.text() : null),
  };
};
