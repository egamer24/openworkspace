import { normalizeEmail } from "@open-workspace/core/module";

import type { AutoReplyStatus, MailboxState } from "../../shared/mail";
import type { AutoReplySettings, Email } from "../mailbox/schema";
import { replyThreadHeaders } from "./rfc";

/** Replies a mailbox may send in one hour, whatever else allows them. */
export const AUTO_REPLY_HOURLY_CAP = 50;

/** Only the start of a message is read for its headers; bodies never are. */
const HEADER_SCAN_BYTES = 64 * 1024;

/** Where a mailbox's auto-reply images live; they go with the mailbox's objects. */
export function autoReplyImagePrefix(mailboxId: string) {
  return `mailboxes/${mailboxId}/auto-reply/`;
}

export function autoReplyStatus(
  settings: Pick<AutoReplySettings, "enabled" | "startsAt" | "endsAt"> | null,
  now: Date
): AutoReplyStatus {
  if (!settings?.enabled) return "off";

  if (settings.startsAt && now < settings.startsAt) return "scheduled";

  if (settings.endsAt && now >= settings.endsAt) return "ended";

  return "active";
}

/**
 * The top-level header block, names lowercased and repeated headers joined
 * with ", ". At most HEADER_SCAN_BYTES are decoded.
 */
export function parseHeaderBlock(raw: ArrayBuffer) {
  const text = new TextDecoder("latin1").decode(
    raw.slice(0, HEADER_SCAN_BYTES)
  );

  const end = text.search(/\r?\n\r?\n/u);

  const block = (end === -1 ? text : text.slice(0, end)).replaceAll(
    /\r?\n[ \t]+/gu,
    " "
  );

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

const SYSTEM_LOCAL_PART =
  /^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?(?:[+._-].*)?)$/iu;

/**
 * RFC 3834 and common-practice checks that depend only on the message and
 * how it was delivered: why it gets no reply, or null when it may get one.
 * Mail delivered to the mailbox directly, through an alias, a plus address
 * or the catch-all may be answered; a copy of a workspace mailing list's
 * post (`listAddress`) never is.
 */
export function messageSkipReason(input: {
  headers: Map<string, string>;
  envelopeFrom: string;
  /** The mailbox's address and its aliases, lowercased. */
  ownAddresses: readonly string[];
  listAddress: string | null;
  /** Where its conversation is now. */
  mailboxState: MailboxState | undefined;
  email: Pick<Email, "attachmentsJson">;
}): string | null {
  const { headers } = input;

  // Spam, and mail a rule discarded; Archive and folders still get a reply.
  if (input.mailboxState === "spam" || input.mailboxState === "trash") {
    return input.mailboxState;
  }

  if (input.listAddress) return "mailing list copy";

  const autoSubmitted = headers
    .get("auto-submitted")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();

  if (autoSubmitted && autoSubmitted !== "no") return "auto-submitted";

  const precedence = headers.get("precedence")?.trim().toLowerCase();

  if (precedence && ["bulk", "list", "junk"].includes(precedence)) {
    return "precedence";
  }

  if (headers.has("list-id") || headers.has("list-unsubscribe")) {
    return "mailing list";
  }

  const suppress = headers.get("x-auto-response-suppress")?.toLowerCase() ?? "";

  if (/\b(?:oof|all)\b/u.test(suppress)) return "x-auto-response-suppress";

  const contentType = headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.startsWith("multipart/report")) return "delivery report";

  // Calendar invitations and responses are machine-generated; an .ics part
  // inside multipart mail counts as well.
  if (
    contentType.startsWith("text/calendar") ||
    input.email.attachmentsJson.some(
      (file) =>
        /^(?:text\/calendar|application\/ics)\b/iu.test(file.contentType) ||
        /\.ics$/iu.test(file.filename)
    )
  ) {
    return "calendar message";
  }

  const sender = input.envelopeFrom.trim().replaceAll(/^<|>$/gu, "");

  if (!sender) return "empty envelope sender";

  if (SYSTEM_LOCAL_PART.test(sender.split("@", 1)[0] ?? "")) {
    return "system sender";
  }

  return input.ownAddresses.includes(sender.toLowerCase())
    ? "own address"
    : null;
}

/** The reply goes to the envelope sender (Return-Path), per RFC 3834. */
export function autoReplyRecipient(envelopeFrom: string) {
  return normalizeEmail(envelopeFrom.trim().replaceAll(/^<|>$/gu, ""));
}

/** Header values here come from other people's mail; keep each on one line. */
function oneLine(value: string) {
  return value.replaceAll(/[\r\n]+/gu, " ");
}

/** The message `EMAIL.send` gets: never stored, and marked as automatic. */
export function buildAutoReply(input: {
  from: { address: string; name: string };
  recipient: string;
  original: Pick<
    Email,
    "subject" | "messageIdHeader" | "inReplyToJson" | "referencesJson"
  >;
  message: { subject: string | null; html: string; text: string };
  /** The images the HTML shows, loaded from R2. */
  images?: {
    contentId: string;
    filename: string;
    type: string;
    content: ArrayBuffer;
  }[];
}) {
  const thread = replyThreadHeaders(input.original);

  // Every one of these is on Email Sending's header allowlist.
  const headers = Object.fromEntries(
    [
      ["Auto-Submitted", "auto-replied"],
      ["X-Auto-Response-Suppress", "All"],
      ["In-Reply-To", oneLine(thread.inReplyTo.join(" "))],
      ["References", oneLine(thread.references.join(" "))],
    ].filter(([, value]) => value)
  );

  return {
    from: { name: oneLine(input.from.name), email: input.from.address },
    to: input.recipient,
    subject: oneLine(
      input.message.subject?.trim() || `Auto: ${input.original.subject}`
    ),
    text: input.message.text,
    html: input.message.html,
    attachments: (input.images ?? []).map((image) => ({
      disposition: "inline" as const,
      ...image,
    })),
    headers,
  };
}
