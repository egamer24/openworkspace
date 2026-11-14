import {
  createDb,
  mailboxAddressPredicate,
  mailboxAddressSql,
  mailboxes,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";
import type {
  BackupSnapshot,
  Database,
  ModuleBackup,
} from "@open-workspace/core/module";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import type { MailboxState } from "../../shared/mail";
import { importPlacements } from "../../shared/mail-import";
import type { ImportPlacement } from "../../shared/mail-import";
import { importRawMessage } from "../mail/import-routes";
import { prepareOutboundDelivery } from "../mail/outbound-delivery";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import { serializeEml } from "./eml";

/**
 * Mail's part of a backup snapshot: a folder per address that keeps mail,
 * with one line per message, and each message's `.eml` object stored once.
 * The mailbox keeps each stored message's hash, so later snapshots write
 * its line from the mailbox's rows alone, and read and store only new mail.
 */

/** Rows a batch lists; those with a stored hash cost nothing more. */
const BATCH_ROWS = 5000;

/** New messages a batch reads and stores, about 3 subrequests each. */
const BATCH_NEW = 100;

const EML = { extension: "eml", contentType: "message/rfc822" };

/** One message in a snapshot: what `import backup` sends back with it. */
type MailBackupLine = {
  /** The message's id in the mailbox, its source id on restore. */
  id: string;
  /** Its object, `<sha256>.eml`. */
  object: string;
  placement: ImportPlacement;
  /** The custom folder of a conversation in the Inbox. */
  folder: string | null;
  /** Read by anyone who can open the mailbox; sent mail is read. */
  seen: boolean;
  /** The conversation: messages with the same thread are restored as one. */
  thread: string;
  direction: "incoming" | "outgoing";
  received_at: string;
  subject: string;
};

/** Where a message goes on restore: the place, and the custom folder in the Inbox. */
type BackupPlace = { placement: ImportPlacement; folder: string | null };

/**
 * Where a message goes on restore, from its conversation's state: Archive,
 * Spam and Trash hold the whole conversation; in an active conversation,
 * received mail is in the Inbox (and its custom folder) and sent mail is
 * Sent, which leaves the conversation's place to the rest.
 */
function backupPlacement(input: {
  direction: "incoming" | "outgoing";
  mailboxState: MailboxState;
  folderName: string | null;
}): BackupPlace {
  if (input.mailboxState !== "active") {
    return { placement: input.mailboxState, folder: null };
  }

  if (input.direction === "outgoing") {
    return { placement: "sent", folder: null };
  }

  return { placement: "inbox", folder: input.folderName };
}

/** Outgoing mail as Email Sending got it (same body and attachments), as MIME. */
async function sentMessageBytes(
  env: Env,
  email: Email,
  error: (message: string) => void
) {
  let delivery: Awaited<ReturnType<typeof prepareOutboundDelivery>>;

  try {
    delivery = await prepareOutboundDelivery(env, email);
  } catch (cause) {
    // A missing attachment must not cost the backup the message itself.
    error(
      `${email.id}: ${cause instanceof Error ? cause.message : String(cause)}; kept without attachments`
    );
    delivery = await prepareOutboundDelivery(env, {
      ...email,
      attachmentsJson: [],
    });
  }

  return serializeEml({
    id: email.id,
    from: email.fromJson,
    to: email.toJson,
    cc: email.ccJson,
    bcc: email.bccJson,
    replyTo: email.replyToJson,
    subject: email.subject,
    date: email.timelineAt,
    messageId: email.messageIdHeader,
    inReplyTo: email.inReplyToJson,
    references: email.referencesJson,
    text: delivery.text,
    html: delivery.html,
    attachments: (delivery.attachments ?? []).map((attachment) => ({
      ...attachment,
      // SAFETY: prepareOutboundDelivery reads each attachment with R2's
      // arrayBuffer(); EmailAttachment's type only allows more.
      content: attachment.content as ArrayBuffer,
    })),
  });
}

async function messageBytes(
  env: Env,
  email: Email,
  error: (message: string) => void
) {
  if (email.rawMimeR2Key) {
    const object = await env.MAIL_STORAGE.get(email.rawMimeR2Key);

    if (object) return new Uint8Array(await object.arrayBuffer());
    error(`${email.id}: raw message is missing, rebuilt from its fields`);
  }

  return sentMessageBytes(env, email, error);
}

/** The next address after `afterId` that keeps mail (a mailing list keeps none). */
async function nextMailbox(db: Database, afterId: string | null) {
  const [row] = await db
    .select({ id: mailboxes.id, address: mailboxAddressSql })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.delivery, "inbox"),
        afterId ? gt(mailboxes.id, afterId) : undefined
      )
    )
    .orderBy(asc(mailboxes.id))
    .limit(1);

  return row ?? null;
}

const cursorSchema = z.object({
  mailbox: z.string(),
  address: z.string(),
  after: z.string().nullable(),
});

/** One batch: a page of one mailbox's messages. */
async function exportMail(env: Env, snapshot: BackupSnapshot) {
  const db = createDb(env.DB);

  const position = snapshot.cursor
    ? cursorSchema.parse(JSON.parse(snapshot.cursor))
    : null;

  const mailbox = position
    ? { id: position.mailbox, address: position.address }
    : await nextMailbox(db, null);

  if (!mailbox) return null;
  const stub = mailboxStub(env, mailbox.id);

  const { rows, full, more } = await stub.listBackupEmails(
    position?.after ?? null,
    BATCH_ROWS,
    BATCH_NEW
  );

  const stored: { id: string; sha256: string }[] = [];
  const lines: MailBackupLine[] = [];

  for (const row of rows) {
    let sha256 = row.backupSha256;

    if (!sha256) {
      const email = full.find((candidate) => candidate.id === row.id);

      if (!email) continue;

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one message in memory at a time; a message may be 25 MiB
        const bytes = await messageBytes(env, email, snapshot.error);
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        sha256 = await snapshot.putObject(bytes, EML);
      } catch (cause) {
        // Left out of this snapshot; the next one tries again.
        snapshot.error(
          `${mailbox.address} ${row.id}: ${cause instanceof Error ? cause.message : String(cause)}`
        );
        continue;
      }

      stored.push({ id: row.id, sha256 });
    }

    lines.push({
      id: row.id,
      object: `${sha256}.${EML.extension}`,
      ...backupPlacement(row),
      seen: row.direction === "outgoing" || row.seen,
      thread: row.conversationId,
      direction: row.direction,
      received_at: row.timelineAt.toISOString(),
      subject: row.subject,
    });
  }

  // After the objects, so a hash the mailbox holds always names one.
  if (stored.length) await stub.setBackupHashes(stored);
  snapshot.writeLines(mailbox.address, lines);
  const last = rows.at(-1);

  if (more && last) {
    return JSON.stringify({ ...mailbox, after: last.id });
  }

  const next = await nextMailbox(db, mailbox.id);

  return next
    ? JSON.stringify({ mailbox: next.id, address: next.address, after: null })
    : null;
}

const restoreLineSchema = z.object({
  id: z.string().min(1).max(200),
  placement: z.enum(importPlacements),
  folder: z.string().trim().min(1).max(80).nullable(),
  seen: z.boolean(),
  thread: z.string().min(1).max(200),
  direction: z.enum(["incoming", "outgoing"]),
  received_at: z.iso.datetime(),
});

export const mailBackup: ModuleBackup = {
  export: exportMail,
  /** Adds a message to the mailbox at its folder's address, unless it is there. */
  async restore(c, { folder, line, object }) {
    const parsed = restoreLineSchema.safeParse(line);

    if (!parsed.success || !object) {
      return { status: "skipped", reason: "not a message line" };
    }

    const message = parsed.data;
    const address = normalizeMailboxAddress(folder);

    const [mailbox] = await createDb(c.env.DB)
      .select({ id: mailboxes.id, address: mailboxAddressSql })
      .from(mailboxes)
      .where(
        and(mailboxAddressPredicate(address), eq(mailboxes.delivery, "inbox"))
      )
      .limit(1);

    if (!mailbox) {
      return { status: "skipped", reason: `no mailbox ${address}` };
    }

    const result = await importRawMessage({
      env: c.env,
      mailbox,
      raw: object,
      importKey: `backup:${message.id}`,
      receivedAt: Date.parse(message.received_at),
      placement: message.placement,
      folderName: message.folder,
      seen: message.seen,
      thread: `backup:${message.thread}`,
      direction: message.direction,
    });

    if (result.status === "unprocessable") {
      return { status: "skipped", reason: result.reason };
    }

    return { status: result.status === "duplicate" ? "exists" : "restored" };
  },
};
