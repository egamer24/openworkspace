import PostalMime, { type Address, type Email as ParsedEmail } from "postal-mime";
import { convert } from "html-to-text";
import { createId, normalizeMailboxAddress } from "../lib/ids";
import type { MailAddress, StoredAttachment } from "../mailbox/model";
import type { Email, NewEmail, PendingInbound } from "../mailbox/schema";
import { shouldDetachInboundReply } from "./inbound-threading";
import { parseReplyText } from "./quote-parser";
import {
  address,
  headerValue,
  listId,
  listPostAddress,
  messageIds,
} from "./rfc";

function flattenAddresses(values: Address[] | undefined): MailAddress[] {
  return (values ?? []).flatMap((value) =>
    value.group
      ? value.group.map((mailbox) => address(mailbox.address, mailbox.name))
      : value.address
        ? [address(value.address, value.name)]
        : [],
  );
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string) {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export class UnprocessableInboundEmailError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnprocessableInboundEmailError";
  }
}

export class MissingRawMimeError extends Error {
  constructor() {
    super("The original message is not available in storage yet");
    this.name = "MissingRawMimeError";
  }
}

export function inboundMessageId(deliveryId: string) {
  return `msg_${deliveryId.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}`;
}

async function parseMime(bytes: ArrayBuffer): Promise<ParsedEmail> {
  try {
    return await PostalMime.parse(bytes);
  } catch (error) {
    throw new UnprocessableInboundEmailError(
      "The original message could not be parsed",
      { cause: error },
    );
  }
}

export async function readInboundRawMime(env: Env, job: PendingInbound) {
  const raw = await env.MAIL_STORAGE.get(job.rawObjectKey);
  if (!raw) {
    // The durable queue is committed before the R2 upload, so an alarm can
    // briefly win that race. Missing storage remains retryable.
    throw new MissingRawMimeError();
  }
  return raw.arrayBuffer();
}

export function prepareUnprocessableInboundEmail(input: {
  job: PendingInbound;
  reason: string;
  rawMimeR2Key: string | null;
}): NewEmail {
  const messageId = inboundMessageId(input.job.id);
  const fromAddress = input.job.envelopeFrom || "unknown@invalid";
  return {
    id: messageId,
    conversationId: createId("conv"),
    direction: "incoming",
    messageIdHeader: null,
    inReplyToJson: [],
    referencesJson: [],
    fromJson: [address(fromAddress)],
    replyToJson: [],
    toJson: [address(input.job.envelopeTo)],
    ccJson: [],
    bccJson: [],
    subject: "(unreadable message)",
    preview: input.reason,
    bodyText: [
      input.reason,
      "",
      input.rawMimeR2Key
        ? "The original MIME message was preserved for diagnostics."
        : "The original MIME message is not available.",
    ].join("\n"),
    quotedText: null,
    bodyHtmlR2Key: null,
    rawMimeR2Key: input.rawMimeR2Key,
    attachmentsJson: [],
    listId: null,
    listPostAddress: null,
    timelineAt: input.job.receivedAt,
    transportState: "received",
    deliveryStatusJson: [],
  };
}

/** The stored row plus parsed bodies the spam filter inspects in memory. */
export type PreparedInboundEmail = {
  email: NewEmail;
  html: string | null;
  hasTextPart: boolean;
};

export async function prepareInboundEmail(input: {
  env: Env;
  mailboxId: string;
  job: PendingInbound;
  rawMime: ArrayBuffer;
  resolveParent: (inReplyTo: string[], references: string[]) => Email | null;
}): Promise<PreparedInboundEmail> {
  const { job } = input;
  const parsed = await parseMime(input.rawMime);
  const inReplyTo = messageIds(parsed.inReplyTo);
  const references = messageIds(parsed.references);
  const parent = input.resolveParent(inReplyTo, references);
  const recipient = normalizeMailboxAddress(job.envelopeTo);
  const from = flattenAddresses(parsed.from ? [parsed.from] : []);
  if (!from.length) from.push(address(job.envelopeFrom || "unknown@invalid"));
  const to = flattenAddresses(parsed.to);
  const cc = flattenAddresses(parsed.cc);
  const bcc = flattenAddresses(parsed.bcc);
  const replyTo = flattenAddresses(parsed.replyTo);
  const parsedListId = listId(parsed.headers);
  const parsedListPost = listPostAddress(
    headerValue(parsed.headers, "list-post"),
  );
  const detached = parent
    ? shouldDetachInboundReply({
        ownAddress: recipient,
        parent,
        from,
        to,
        cc,
        listId: parsedListId,
      })
    : false;
  const messageId = inboundMessageId(job.id);
  const plainBody = parsed.text?.trim()
    ? parsed.text
    : parsed.html
      ? convert(parsed.html, {
          wordwrap: false,
          selectors: [
            { selector: "img", format: "skip" },
            { selector: "style", format: "skip" },
          ],
        })
      : "";
  const replyText = parseReplyText(plainBody);
  const bodyHtmlR2Key = parsed.html
    ? `mailboxes/${input.mailboxId}/messages/${messageId}/body.html`
    : null;
  if (bodyHtmlR2Key && parsed.html) {
    await input.env.MAIL_STORAGE.put(bodyHtmlR2Key, parsed.html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  }

  const attachments: StoredAttachment[] = [];
  for (const [index, file] of parsed.attachments.entries()) {
    const id = `att_${messageId}_${index}`;
    const r2Key =
      `mailboxes/${input.mailboxId}/messages/${messageId}/attachments/${id}`;
    const bytes = attachmentBytes(file.content);
    await input.env.MAIL_STORAGE.put(r2Key, bytes, {
      httpMetadata: { contentType: file.mimeType },
    });
    attachments.push({
      id,
      r2Key,
      filename: file.filename || "attachment",
      contentType: file.mimeType,
      size: bytes.byteLength,
      contentId: file.contentId ?? null,
      disposition: file.disposition === "inline" ? "inline" : "attachment",
      delivery: "attached",
      downloadTokenHash: null,
      downloadExpiresAt: null,
    });
  }

  const email: NewEmail = {
    id: messageId,
    conversationId: parent && !detached ? parent.conversationId : createId("conv"),
    direction: "incoming",
    messageIdHeader: messageIds(parsed.messageId)[0] ?? null,
    inReplyToJson: inReplyTo,
    referencesJson: references,
    fromJson: from,
    replyToJson: replyTo,
    toJson: to,
    ccJson: cc,
    bccJson: bcc,
    subject: parsed.subject?.trim() || "(no subject)",
    preview: replyText.bodyText.replace(/\s+/gu, " ").trim().slice(0, 220),
    bodyText: replyText.bodyText,
    quotedText: replyText.quotedText,
    bodyHtmlR2Key,
    rawMimeR2Key: job.rawObjectKey,
    attachmentsJson: attachments,
    listId: parsedListId,
    listPostAddress: parsedListPost,
    timelineAt: job.receivedAt,
    transportState: "received",
    deliveryStatusJson: [],
  };
  return {
    email,
    html: parsed.html ?? null,
    hasTextPart: Boolean(parsed.text?.trim()),
  };
}
