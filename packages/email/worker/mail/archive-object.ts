import { serializeEml } from "../backups/eml";
import type { MailAddress } from "../mailbox/model";

/** The pure rules of the mail archive (worker/mail/archive.ts). */

export type ArchiveDirection = "incoming" | "outgoing";

const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;

/** `<year>/<month>/<direction>/<id>.eml`, by when the message arrived or was sent. */
export function archiveObjectKey(
  direction: ArchiveDirection,
  id: string,
  at: Date
) {
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");

  return `${at.getUTCFullYear()}/${month}/${direction}/${id}.eml`;
}

/** Where a copy that couldn't be archived right away waits in MAIL_STORAGE. */
export const ARCHIVE_STAGING_PREFIX = "archive-staging/";

export function archiveStagingKey(id: string) {
  return `${ARCHIVE_STAGING_PREFIX}${id}.eml`;
}

/**
 * Whether an open entry is due for another try: a fresh one a minute after
 * it was made (the request that made it is usually copying it), then after
 * 5 minutes, doubling up to 6 hours.
 */
export function archiveRetryDue(
  entry: { attempts: number; updatedAt: Date },
  now: number
) {
  const wait = entry.attempts
    ? Math.min(RETRY_BASE_MS * 2 ** (entry.attempts - 1), RETRY_MAX_MS)
    : 60_000;

  return now - entry.updatedAt.getTime() >= wait;
}

/**
 * What the workspace hands Email Sending: its structured message, with
 * addresses as plain strings and the sender as a name and address.
 */
export type SentMessage = EmailMessageBuilder & {
  from: EmailAddress;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
};

function mailAddresses(value: string | string[] | undefined) {
  return [value ?? []]
    .flat()
    .map((address): MailAddress => ({ address, name: null }));
}

/**
 * A sent message as the archive keeps it: MIME rebuilt from exactly what
 * Email Sending was given (it takes structured fields, not MIME) and the
 * Message-ID it returned. The bytes on the wire, and Cloudflare's DKIM
 * signature, are not in it. The same input always gives the same bytes.
 */
export function sentEml(
  sent: { id: string; date: Date; messageId: string },
  message: SentMessage
) {
  return serializeEml({
    id: sent.id,
    from: [{ address: message.from.email, name: message.from.name || null }],
    to: mailAddresses(message.to),
    cc: mailAddresses(message.cc),
    bcc: mailAddresses(message.bcc),
    replyTo: mailAddresses(message.replyTo),
    subject: message.subject,
    date: sent.date,
    messageId: sent.messageId,
    // Threading headers are among `headers`, written as given.
    inReplyTo: [],
    references: [],
    headers: message.headers,
    text: message.text,
    html: message.html,
    attachments: (message.attachments ?? []).map((attachment) => ({
      disposition: attachment.disposition,
      contentId: attachment.contentId,
      filename: attachment.filename,
      type: attachment.type,
      // SAFETY: every sender passes R2 objects' arrayBuffer() (outbound
      // delivery, auto-reply images); EmailAttachment's type allows more.
      content: attachment.content as ArrayBuffer,
    })),
  });
}
