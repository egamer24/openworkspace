import {
  createDb,
  mailboxAddressSql,
  mailboxes,
} from "@open-workspace/core/module";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { mailArchiveEntries } from "../db/schema";
import { mailboxStub } from "../mailbox";
import {
  ARCHIVE_STAGING_PREFIX,
  archiveObjectKey,
  archiveRetryDue,
  archiveStagingKey,
  sentEml,
} from "./archive-object";
import type { ArchiveDirection, SentMessage } from "./archive-object";
import { prepareOutboundDelivery } from "./outbound-delivery";

/**
 * The optional write-once mail archive (`Email({ archive })`): every
 * received and sent message is copied as .eml to MAIL_ARCHIVE, a separate
 * bucket with a lock rule, and journaled in D1. Archiving never holds up or
 * fails mail: what can't be copied right away is retried hourly, and a copy
 * with nowhere else to come from is staged in MAIL_STORAGE first.
 */

type Entry = typeof mailArchiveEntries.$inferSelect;

type Bytes = Uint8Array<ArrayBuffer>;

type NewEntry = {
  id: string;
  mailboxId: string;
  direction: ArchiveDirection;
  sourceKey: string | null;
  createdAt: Date;
};

const OPEN = ["pending", "failed"] as const;

/** Copies per cron run; about 4 subrequests each. */
const RETRY_BATCH = 100;

/** D1 binds at most 100 parameters a statement. */
const SQL_CHUNK = 50;

function chunks<T>(items: T[], size = SQL_CHUNK) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );
}

async function sha256Hex(bytes: Bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** Records messages to archive; idempotent. */
async function registerArchiveEntries(env: Env, entries: NewEntry[]) {
  const db = createDb(env.DB);
  const updatedAt = new Date();

  // 9 columns a row keeps 10 rows under the parameter limit.
  await Promise.all(
    chunks(entries, 10).map((part) =>
      db
        .insert(mailArchiveEntries)
        .values(
          part.map((entry) => ({
            ...entry,
            archiveKey: archiveObjectKey(
              entry.direction,
              entry.id,
              entry.createdAt
            ),
            updatedAt,
          }))
        )
        .onConflictDoNothing()
    )
  );
}

/** Records one message; false when the archive is off or D1 refused. Never throws. */
async function recordEntry(env: Env, entry: NewEntry) {
  if (!env.MAIL_ARCHIVE) return false;

  try {
    await registerArchiveEntries(env, [entry]);

    return true;
  } catch (error) {
    // The hourly pass finds a staged copy without a row (adoptStaged).
    console.error(`Could not record ${entry.id} for the mail archive`, error);

    return false;
  }
}

/** Writes the object once; an object already there must be this one. */
async function writeArchive(
  bucket: R2Bucket,
  target: { archiveKey: string; mailboxId: string; direction: string },
  bytes: Bytes
) {
  const sha256 = await sha256Hex(bytes);

  const written = await bucket.put(target.archiveKey, bytes, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      sha256,
      mailboxId: target.mailboxId,
      direction: target.direction,
    },
    sha256,
    onlyIf: { etagDoesNotMatch: "*" },
  });

  // Already there, e.g. an earlier try stored it before it could record so.
  if (!written) {
    const existing = await bucket.head(target.archiveKey);

    if (existing?.customMetadata?.sha256 !== sha256) {
      throw new Error(
        `${target.archiveKey} is already archived with different content`
      );
    }
  }

  return sha256;
}

/** Sent mail without a staged copy, rebuilt from the mailbox as it was sent. */
async function rebuiltSent(env: Env, entry: Entry): Promise<Bytes> {
  const email = await mailboxStub(env, entry.mailboxId).getEmail(entry.id);

  if (!email?.messageIdHeader || email.transportState !== "submitted") {
    throw new Error("The sent message is gone and no copy was staged");
  }

  return sentEml(
    { id: email.id, date: email.timelineAt, messageId: email.messageIdHeader },
    await prepareOutboundDelivery(env, email)
  );
}

async function storedBytes(env: Env, entry: Entry): Promise<Bytes> {
  if (entry.sourceKey) {
    const object = await env.MAIL_STORAGE.get(entry.sourceKey);

    if (!object) throw new Error("The message is missing from mail storage");

    return new Uint8Array(await object.arrayBuffer());
  }

  if (entry.direction === "outgoing") return rebuiltSent(env, entry);
  throw new Error("The received message has no stored copy");
}

/**
 * Copies one recorded message. Never throws: a failure is recorded for
 * Administration → Mail archive and retried. `load` defaults to the stored
 * copy.
 */
async function archiveEntry(env: Env, id: string, load?: () => Promise<Bytes>) {
  const bucket = env.MAIL_ARCHIVE;

  if (!bucket) return false;
  const db = createDb(env.DB);

  try {
    const [entry] = await db
      .select()
      .from(mailArchiveEntries)
      .where(eq(mailArchiveEntries.id, id))
      .limit(1);

    if (!entry) throw new Error("The message is not recorded for archiving");

    if (entry.status === "archived") return true;
    const bytes = await (load ? load() : storedBytes(env, entry));
    const sha256 = await writeArchive(bucket, entry, bytes);
    const now = new Date();

    await db
      .update(mailArchiveEntries)
      .set({
        status: "archived",
        sha256,
        size: bytes.byteLength,
        lastError: null,
        archivedAt: now,
        updatedAt: now,
      })
      .where(eq(mailArchiveEntries.id, id));

    if (entry.sourceKey?.startsWith(ARCHIVE_STAGING_PREFIX)) {
      await env.MAIL_STORAGE.delete(entry.sourceKey).catch(() => undefined);
    }

    return true;
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 500);

    console.error("Mail archive copy failed", id, message);

    await db
      .update(mailArchiveEntries)
      .set({
        status: "failed",
        attempts: sql`${mailArchiveEntries.attempts} + 1`,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailArchiveEntries.id, id),
          inArray(mailArchiveEntries.status, OPEN)
        )
      )
      .then(
        () => undefined,
        () => console.error("Could not record the archive failure", id)
      );

    return false;
  }
}

const stagedMetadata = z.object({
  mailboxId: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
  createdAt: z.coerce.number(),
});

/**
 * Archives a message as it is received or sent. Never throws. A copy that
 * fails with nowhere to retry from (sent mail, or a message D1 couldn't
 * record) is staged in MAIL_STORAGE, where the hourly pass finds it.
 */
async function archiveNow(
  env: Env,
  entry: NewEntry,
  bytes: Bytes,
  recorded: boolean
) {
  const bucket = env.MAIL_ARCHIVE;

  if (!bucket) return;

  if (recorded) {
    if (await archiveEntry(env, entry.id, () => Promise.resolve(bytes))) {
      return;
    }

    if (entry.sourceKey) return;
  } else {
    try {
      const archiveKey = archiveObjectKey(
        entry.direction,
        entry.id,
        entry.createdAt
      );

      await writeArchive(bucket, { ...entry, archiveKey }, bytes);

      return;
    } catch (error) {
      console.error(`Mail archive copy of ${entry.id} failed`, error);
    }
  }

  const stagingKey = archiveStagingKey(entry.id);

  try {
    await env.MAIL_STORAGE.put(stagingKey, bytes, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        mailboxId: entry.mailboxId,
        direction: entry.direction,
        createdAt: String(entry.createdAt.getTime()),
      },
    });

    if (recorded) {
      await createDb(env.DB)
        .update(mailArchiveEntries)
        .set({ sourceKey: stagingKey })
        .where(eq(mailArchiveEntries.id, entry.id));
    }
  } catch (error) {
    // ponytail: R2 and D1 failing together loses a sent message's retry source (received mail keeps its raw copy); rebuiltSent covers stored sent mail.
    console.error(`Could not stage ${entry.id} for the mail archive`, error);
  }
}

/**
 * Received mail: recorded before the delivery is stored, so a retry finds
 * its raw copy and the purge keeps that copy until it's archived, then
 * copied. `store` stores it; only its errors reach the caller.
 */
export async function receiveArchived(
  env: Env,
  delivery: {
    id: string;
    mailboxId: string;
    sourceKey: string;
    receivedAt: number;
  },
  raw: ArrayBuffer,
  store: () => Promise<void>
) {
  const entry: NewEntry = {
    id: delivery.id,
    mailboxId: delivery.mailboxId,
    direction: "incoming",
    sourceKey: delivery.sourceKey,
    createdAt: new Date(delivery.receivedAt),
  };

  const recorded = await recordEntry(env, entry);
  await store();
  await archiveNow(env, entry, new Uint8Array(raw), recorded);
}

/**
 * Every message the workspace sends goes through here: it hands `message`
 * to Email Sending and archives exactly that, with the Message-ID it got
 * back (`sentEml`). Archiving never fails the send. `sent.id` names the
 * copy: the stored message's id, or any unique id for mail that isn't
 * stored (e.g. an auto-reply).
 */
export async function sendArchived(
  env: Env,
  sent: { id: string; mailboxId: string; date: Date },
  message: SentMessage
) {
  const result = await env.EMAIL.send(message);

  if (!env.MAIL_ARCHIVE) return result;

  const entry: NewEntry = {
    id: sent.id,
    mailboxId: sent.mailboxId,
    direction: "outgoing",
    sourceKey: null,
    createdAt: sent.date,
  };

  try {
    const bytes = sentEml({ ...sent, messageId: result.messageId }, message);
    await archiveNow(env, entry, bytes, await recordEntry(env, entry));
  } catch (error) {
    console.error(`Could not archive sent message ${sent.id}`, error);
  }

  return result;
}

/** Raw copies that must outlive object cleanup until they are archived. */
export async function keysAwaitingArchive(env: Env, keys: string[]) {
  if (!env.MAIL_ARCHIVE || !keys.length) return new Set<string>();
  const db = createDb(env.DB);

  const pages = await Promise.all(
    chunks(keys).map((part) =>
      db
        .select({ key: mailArchiveEntries.sourceKey })
        .from(mailArchiveEntries)
        .where(
          and(
            inArray(mailArchiveEntries.sourceKey, part),
            inArray(mailArchiveEntries.status, OPEN)
          )
        )
    )
  );

  return new Set(pages.flat().flatMap((row) => (row.key ? [row.key] : [])));
}

/** Tries a mailbox's open entries now; the raw copies that still aren't archived. */
export async function archiveMailboxNow(env: Env, mailboxId: string) {
  if (!env.MAIL_ARCHIVE) return new Set<string>();
  const db = createDb(env.DB);

  const open = await db
    .select({ id: mailArchiveEntries.id })
    .from(mailArchiveEntries)
    .where(
      and(
        eq(mailArchiveEntries.mailboxId, mailboxId),
        inArray(mailArchiveEntries.status, OPEN)
      )
    );

  for (const { id } of open) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one message in memory at a time
    await archiveEntry(env, id);
  }

  const left = await db
    .select({ key: mailArchiveEntries.sourceKey })
    .from(mailArchiveEntries)
    .where(
      and(
        eq(mailArchiveEntries.mailboxId, mailboxId),
        inArray(mailArchiveEntries.status, OPEN)
      )
    );

  return new Set(left.flatMap((row) => (row.key ? [row.key] : [])));
}

/** Staged copies D1 has no row for, or a row that doesn't point at them yet. */
async function adoptStaged(env: Env) {
  const db = createDb(env.DB);

  const page = await env.MAIL_STORAGE.list({
    prefix: ARCHIVE_STAGING_PREFIX,
    limit: RETRY_BATCH,
    include: ["customMetadata"],
  });

  for (const object of page.objects) {
    const metadata = stagedMetadata.safeParse(object.customMetadata);

    if (!metadata.success) continue;
    const id = object.key.slice(ARCHIVE_STAGING_PREFIX.length, -".eml".length);

    // oxlint-disable-next-line eslint/no-await-in-loop -- a few staged copies, rarely any
    await registerArchiveEntries(env, [
      {
        id,
        mailboxId: metadata.data.mailboxId,
        direction: metadata.data.direction,
        sourceKey: object.key,
        createdAt: new Date(metadata.data.createdAt),
      },
    ]);

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    const [row] = await db
      .select({
        status: mailArchiveEntries.status,
        sourceKey: mailArchiveEntries.sourceKey,
      })
      .from(mailArchiveEntries)
      .where(eq(mailArchiveEntries.id, id));

    // Archived some other way (e.g. the copy landed but D1 didn't hear of it).
    if (row?.status === "archived") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above
      await env.MAIL_STORAGE.delete(object.key);
    } else if (row && !row.sourceKey) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above
      await db
        .update(mailArchiveEntries)
        .set({ sourceKey: object.key })
        .where(eq(mailArchiveEntries.id, id));
    }
  }
}

/** The hourly cron and "Archive now": retries open entries; `force` skips the backoff. */
export async function runArchiveTick(
  env: Env,
  now = new Date(),
  force = false
) {
  if (!env.MAIL_ARCHIVE) return;

  try {
    await adoptStaged(env);
  } catch (error) {
    // The retries below don't depend on it.
    console.error("Mail archive could not adopt staged copies", error);
  }

  const open = await createDb(env.DB)
    .select()
    .from(mailArchiveEntries)
    .where(inArray(mailArchiveEntries.status, OPEN))
    .orderBy(asc(mailArchiveEntries.createdAt))
    .limit(RETRY_BATCH * 3);

  const due = open
    .filter((entry) => force || archiveRetryDue(entry, now.getTime()))
    .slice(0, RETRY_BATCH);

  for (const entry of due) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one message in memory at a time
    await archiveEntry(env, entry.id);
  }
}

/** Administration → Mail archive. */
export async function archiveStatus(env: Env) {
  const db = createDb(env.DB);

  const [counts, open] = await Promise.all([
    db
      .select({
        status: mailArchiveEntries.status,
        count: sql<number>`count(*)`,
      })
      .from(mailArchiveEntries)
      .groupBy(mailArchiveEntries.status),
    db
      .select({
        id: mailArchiveEntries.id,
        mailbox: mailboxAddressSql,
        direction: mailArchiveEntries.direction,
        status: mailArchiveEntries.status,
        attempts: mailArchiveEntries.attempts,
        lastError: mailArchiveEntries.lastError,
        createdAt: mailArchiveEntries.createdAt,
      })
      .from(mailArchiveEntries)
      .leftJoin(mailboxes, eq(mailboxes.id, mailArchiveEntries.mailboxId))
      .where(inArray(mailArchiveEntries.status, OPEN))
      .orderBy(desc(mailArchiveEntries.createdAt))
      .limit(20),
  ]);

  const count = (status: Entry["status"]) =>
    Number(counts.find((row) => row.status === status)?.count ?? 0);

  return {
    enabled: Boolean(env.MAIL_ARCHIVE),
    years: env.MAIL_ARCHIVE_YEARS ? Number(env.MAIL_ARCHIVE_YEARS) : null,
    archived: count("archived"),
    pending: count("pending"),
    failed: count("failed"),
    open: open.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.getTime(),
    })),
  };
}
