import { normalizeEmail } from "../lib/ids";
import type { Email } from "../mailbox/schema";
import { replyThreadHeaders } from "./rfc";

export const autoReplyAudiences = ["everyone", "knownSenders"] as const;
export type AutoReplyAudience = (typeof autoReplyAudiences)[number];

export const AUTO_REPLY_HOURLY_CAP = 50;
const HEADER_SCAN_BYTES = 64 * 1024;

export type AutoReplyWindow = {
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type AutoReplyStatus = "off" | "scheduled" | "active" | "ended";

export function autoReplyStatus(settings: AutoReplyWindow | null, now: Date): AutoReplyStatus {
  if (!settings?.enabled) return "off";
  if (settings.startsAt && now < settings.startsAt) return "scheduled";
  if (settings.endsAt && now >= settings.endsAt) return "ended";
  return "active";
}

/**
 * Reads the top-level header block only. Bodies are never decoded, so a large
 * message costs at most HEADER_SCAN_BYTES. Names are lowercased; repeated
 * headers are joined with ", ".
 */
export function parseHeaderBlock(raw: ArrayBuffer) {
  const text = new TextDecoder("latin1").decode(raw.slice(0, HEADER_SCAN_BYTES));
  const end = text.search(/\r?\n\r?\n/u);
  const block = (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/gu, " ");
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const previous = headers.get(name);
    headers.set(name, previous === undefined ? value : `${previous}, ${value}`);
  }
  return headers;
}

const SYSTEM_LOCAL_PART = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?(?:[+._-].*)?)$/iu;

/**
 * RFC 3834 and common-practice checks that depend only on the message.
 * Returns why no reply should be sent, or null if the message qualifies.
 */
export function messageSkipReason(input: {
  headers: Map<string, string>;
  envelopeFrom: string;
  mailboxAddress: string;
  email: Pick<Email, "toJson" | "ccJson" | "fromJson">;
}): string | null {
  const { headers } = input;
  const autoSubmitted = headers.get("auto-submitted")?.split(";", 1)[0]?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return "auto-submitted";
  const precedence = headers.get("precedence")?.trim().toLowerCase();
  if (precedence && ["bulk", "list", "junk"].includes(precedence)) return "precedence";
  if (headers.has("list-id") || headers.has("list-unsubscribe")) return "mailing list";
  const suppress = headers.get("x-auto-response-suppress")?.toLowerCase() ?? "";
  if (/\b(oof|all)\b/u.test(suppress)) return "x-auto-response-suppress";
  if (headers.get("content-type")?.toLowerCase().startsWith("multipart/report")) {
    return "delivery report";
  }
  // iTIP responses carry no Auto-Submitted header but are machine generated.
  if (/method\s*=\s*"?(reply|cancel)/iu.test(headers.get("content-type") ?? "")) {
    return "calendar response";
  }

  const sender = input.envelopeFrom.trim().replace(/^<|>$/gu, "");
  if (!sender) return "empty envelope sender";
  const localPart = sender.split("@", 1)[0] ?? "";
  if (SYSTEM_LOCAL_PART.test(localPart)) return "system sender";

  const own = input.mailboxAddress.toLowerCase();
  if (sender.toLowerCase() === own) return "own address";
  const addressed = [...input.email.toJson, ...input.email.ccJson]
    .some((item) => item.address.toLowerCase() === own);
  if (!addressed) return "not addressed directly";
  return null;
}

/** The reply goes to the envelope sender (Return-Path), per RFC 3834. */
export function autoReplyRecipient(envelopeFrom: string) {
  return normalizeEmail(envelopeFrom.trim().replace(/^<|>$/gu, ""));
}

export function buildAutoReply(input: {
  mailboxAddress: string;
  mailboxName: string;
  recipient: string;
  original: Pick<Email, "subject" | "messageIdHeader" | "inReplyToJson" | "referencesJson">;
  subject: string | null;
  bodyText: string;
}) {
  const thread = replyThreadHeaders(input.original);
  return {
    from: { name: input.mailboxName, email: input.mailboxAddress },
    to: input.recipient,
    subject: input.subject?.trim() || `Auto: ${input.original.subject}`,
    text: input.bodyText,
    headers: {
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
      ...(thread.inReplyTo.length ? { "In-Reply-To": thread.inReplyTo.join(" ") } : {}),
      ...(thread.references.length ? { References: thread.references.join(" ") } : {}),
    },
  };
}
