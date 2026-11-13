import type { Email } from "../mailbox/schema";
import {
  htmlWithQuotedContext,
  textWithQuotedContext,
} from "./outbound-content";
import { dedupeRecipientFields } from "./recipients";

export function emailDestinations(
  message: Pick<Email, "toJson" | "ccJson" | "bccJson">
) {
  const { to, cc, bcc } = dedupeRecipientFields({
    to: message.toJson.map((item) => item.address),
    cc: message.ccJson.map((item) => item.address),
    bcc: message.bccJson.map((item) => item.address),
  });

  if (to.length) {
    return {
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
    };
  }

  if (cc.length) return { cc, bcc: bcc.length ? bcc : undefined };

  if (bcc.length) return { bcc };
  throw new Error("Queued message has no recipients");
}

export async function prepareOutboundDelivery(env: Env, message: Email) {
  const storedHtml = message.bodyHtmlR2Key
    ? await env.MAIL_STORAGE.get(message.bodyHtmlR2Key).then((object) =>
        object?.text()
      )
    : undefined;

  const html = storedHtml
    ? htmlWithQuotedContext(storedHtml, message.quotedText)
    : undefined;

  const attachments: EmailAttachment[] = await Promise.all(
    message.attachmentsJson
      .filter((attachment) => attachment.delivery === "attached")
      .map(async (attachment) => {
        const object = await env.MAIL_STORAGE.get(attachment.r2Key);

        if (!object) {
          throw new Error(`Attachment ${attachment.filename} is missing`);
        }

        const content = await object.arrayBuffer();

        return attachment.disposition === "inline"
          ? {
              disposition: "inline" as const,
              contentId: attachment.contentId ?? attachment.id,
              filename: attachment.filename,
              type: attachment.contentType,
              content,
            }
          : {
              disposition: "attachment" as const,
              filename: attachment.filename,
              type: attachment.contentType,
              content,
            };
      })
  );

  const from = message.fromJson[0];

  if (!from) throw new Error("Outgoing message has no From address");
  // Threading headers, each only when the message has references to carry.
  const headers: Record<string, string> = {};

  if (message.inReplyToJson.length) {
    headers["In-Reply-To"] = message.inReplyToJson.join(" ");
  }

  if (message.referencesJson.length) {
    headers.References = message.referencesJson.join(" ");
  }

  return {
    from: { name: from.name ?? "", email: from.address },
    ...emailDestinations(message),
    replyTo: message.replyToJson[0]?.address,
    subject: message.subject,
    text:
      textWithQuotedContext(message.bodyText ?? "", message.quotedText) ||
      undefined,
    html,
    attachments: attachments.length ? attachments : undefined,
    headers,
  };
}
