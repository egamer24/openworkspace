import { createId, normalizeMailboxAddress } from "@open-workspace/core/module";
import type { Address, Email as ParsedEmail } from "postal-mime";

import { headerValues } from "../../shared/mail-headers";
import type { MailAddress, StoredAttachment } from "../mailbox/model";
import type { Email, NewEmail, PendingInbound } from "../mailbox/schema";
import { inboundHeaderMetadata } from "./auth-headers";
import { shouldDetachInboundReply } from "./inbound-threading";
import { linkDomains, MAX_LINK_DOMAINS } from "./link-domains";
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
        : []
  );
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string) {
  if (content instanceof Uint8Array) return content;

  if (content instanceof ArrayBuffer) return new Uint8Array(content);

  return new TextEncoder().encode(content);
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

const MAX_HEADER_SCAN_BYTES = 256 * 1024;

/** The header section of a raw message as text; bodies are never needed here. */
export function rawHeaderText(rawMime: ArrayBuffer | Uint8Array) {
  const bytes =
    rawMime instanceof Uint8Array ? rawMime : new Uint8Array(rawMime);

  return new TextDecoder().decode(bytes.subarray(0, MAX_HEADER_SCAN_BYTES));
}

/** The Message-ID of a raw message, read from its headers alone. */
export function rawMessageId(rawMime: ArrayBuffer | Uint8Array) {
  return (
    messageIds(headerValues(rawHeaderText(rawMime), "message-id")[0])[0] ?? null
  );
}

/** RFC 2919 list identifier: design@example.com is design.example.com. */
export function listIdFor(listAddress: string) {
  return normalizeMailboxAddress(listAddress).replace("@", ".");
}

export function inboundMessageId(deliveryId: string) {
  return `msg_${deliveryId.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}`;
}

/**
 * MIME parsing and HTML-to-text conversion load with the first delivery a
 * Worker instance processes; the code is large and most requests do not.
 */
const postalMime = () => import("postal-mime").then((module) => module.default);

async function parseMime(bytes: ArrayBuffer): Promise<ParsedEmail> {
  const PostalMime = await postalMime();

  try {
    return await PostalMime.parse(bytes);
  } catch (error) {
    throw new UnprocessableInboundEmailError(
      "The original message could not be parsed",
      { cause: error }
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
    envelopeFrom: input.job.envelopeFrom || null,
    envelopeTo: input.job.envelopeTo || null,
    timelineAt: input.job.receivedAt,
    transportState: "received",
    deliveryStatusJson: [],
  };
}

/** What parsing a delivery reads of it: a queued delivery, or an imported message. */
export type InboundMessageSource = Pick<
  PendingInbound,
  | "id"
  | "rawObjectKey"
  | "envelopeFrom"
  | "envelopeTo"
  | "listAddress"
  | "receivedAt"
>;

export async function prepareInboundEmail(input: {
  env: Env;
  mailboxId: string;
  job: InboundMessageSource;
  rawMime: ArrayBuffer;
  resolveParent: (inReplyTo: string[], references: string[]) => Email | null;
}): Promise<{ email: NewEmail; linkDomains: string[] }> {
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

  // A workspace mailing list is the latest list hop, so it names the list.
  const parsedListId = job.listAddress
    ? listIdFor(job.listAddress)
    : listId(parsed.headers);

  const parsedListPost =
    job.listAddress ??
    listPostAddress(headerValue(parsed.headers, "list-post"));

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
      ? (await import("html-to-text")).convert(parsed.html, {
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

  // Each attachment is its own R2 object, so they are stored concurrently.
  const attachments = await Promise.all(
    parsed.attachments.map(async (file, index): Promise<StoredAttachment> => {
      const id = `att_${messageId}_${index}`;
      const r2Key = `mailboxes/${input.mailboxId}/messages/${messageId}/attachments/${id}`;
      const bytes = attachmentBytes(file.content);
      await input.env.MAIL_STORAGE.put(r2Key, bytes, {
        httpMetadata: { contentType: file.mimeType },
      });

      return {
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
      };
    })
  );

  const email: NewEmail = {
    id: messageId,
    conversationId:
      parent && !detached ? parent.conversationId : createId("conv"),
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
    preview: replyText.bodyText.replaceAll(/\s+/gu, " ").trim().slice(0, 220),
    bodyText: replyText.bodyText,
    quotedText: replyText.quotedText,
    bodyHtmlR2Key,
    rawMimeR2Key: job.rawObjectKey,
    attachmentsJson: attachments,
    listId: parsedListId,
    listPostAddress: parsedListPost,
    ...inboundHeaderMetadata({
      rawHeaders: rawHeaderText(input.rawMime),
      fromAddress: from[0]?.address ?? null,
      envelopeFrom: job.envelopeFrom || null,
    }),
    envelopeFrom: job.envelopeFrom || null,
    envelopeTo: job.envelopeTo || null,
    timelineAt: job.receivedAt,
    transportState: "received",
    deliveryStatusJson: [],
  };

  return {
    email,
    // Over-collect: workspace domains are filtered out once D1 has been read.
    linkDomains: linkDomains({
      html: parsed.html,
      text: [parsed.text],
      limit: MAX_LINK_DOMAINS * 2,
    }),
  };
}
