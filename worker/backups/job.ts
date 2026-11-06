import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { createDb, type Database } from "../db/client";
import {
  backupObjects,
  backupRuns,
  domains,
  mailboxMembers,
  mailboxes,
  users,
} from "../db/schema";
import { mailboxAddressSql } from "../db/mailboxes";
import type { BackupBindings } from "../env";
import {
  htmlWithQuotedContext,
  textWithQuotedContext,
} from "../mail/outbound-content";
import { mailboxStub } from "../mailbox";
import { systemFolderDefinitions, type MailboxState } from "../mailbox/folder-model";
import type { Email } from "../mailbox/schema";
import { serializeEml } from "./eml";

export const BACKUP_PREFIX = "backups";
export const BACKUP_RETENTION = { daily: 14, weekly: 8 };
/** Messages per step: keeps memory and subrequests per step small. */
export const BACKUP_BATCH_SIZE = 50;
/** Steps per cron invocation: ~5 subrequests per message keeps 1,000 messages well under the 10,000 paid-plan limit. */
export const MAX_STEPS_PER_INVOCATION = 20;
const LEASE_MS = 15 * 60 * 1000;
const MAX_RECORDED_ERRORS = 20;

type BackupEnv = Env & BackupBindings;
type BackupRun = typeof backupRuns.$inferSelect;

export type FolderRole = "inbox" | "sent" | "archive" | "spam" | "trash" | "custom";

export type ManifestLine = {
  file: string;
  sha256: string;
  mailbox_address: string;
  folder_role: FolderRole;
  folder_name: string;
  seen: boolean;
  received_at: string;
  size: number;
  subject: string;
};

const systemFolderNames = Object.fromEntries(
  systemFolderDefinitions.map((folder) => [folder.id, folder.name]),
) as Record<Exclude<FolderRole, "custom">, string>;

export function backupObjectKey(sha256: string) {
  return `${BACKUP_PREFIX}/objects/${sha256}.eml`;
}

function mailboxPrefix(runId: string, address: string) {
  return `${BACKUP_PREFIX}/${runId}/${address}`;
}

/**
 * Conversation state wins (it is what an import restores); within active
 * conversations, outgoing mail is Sent and incoming mail is Inbox or the
 * custom classification folder.
 */
export function folderPlacement(input: {
  direction: Email["direction"];
  mailboxState: MailboxState;
  folderName: string | null;
}): { role: FolderRole; name: string } {
  if (input.mailboxState !== "active") {
    return { role: input.mailboxState, name: systemFolderNames[input.mailboxState] };
  }
  if (input.direction === "outgoing") return { role: "sent", name: systemFolderNames.sent };
  if (input.folderName) return { role: "custom", name: input.folderName };
  return { role: "inbox", name: systemFolderNames.inbox };
}

/** Keep the newest `daily` snapshots plus the newest snapshot of each of the newest `weekly` ISO weeks. */
export function retainedBackupIds(
  ids: string[],
  retention: { daily: number; weekly: number } = BACKUP_RETENTION,
) {
  const newestFirst = [...ids].sort().reverse();
  const keep = new Set(newestFirst.slice(0, retention.daily));
  const weeks = new Set<string>();
  for (const id of newestFirst) {
    const date = new Date(`${id}T00:00:00Z`);
    const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000);
    const week = monday.toISOString().slice(0, 10);
    if (weeks.has(week)) continue;
    if (weeks.size >= retention.weekly) break;
    weeks.add(week);
    keep.add(id);
  }
  return keep;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function emlFromStoredFields(env: Env, email: Email, errors: string[]) {
  const html = email.bodyHtmlR2Key
    ? await env.MAIL_STORAGE.get(email.bodyHtmlR2Key).then((object) => object?.text())
    : undefined;
  const attachments = [];
  for (const attachment of email.attachmentsJson) {
    const object = await env.MAIL_STORAGE.get(attachment.r2Key);
    if (!object) {
      errors.push(`${email.id}: attachment ${attachment.filename} is missing`);
      continue;
    }
    attachments.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      disposition: attachment.disposition,
      contentId: attachment.contentId,
      content: new Uint8Array(await object.arrayBuffer()),
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
    text: textWithQuotedContext(email.bodyText ?? "", email.quotedText),
    html: html === undefined ? undefined : htmlWithQuotedContext(html, email.quotedText),
    attachments,
  });
}

async function messageBytes(env: Env, email: Email, errors: string[]) {
  if (email.rawMimeR2Key) {
    const object = await env.MAIL_STORAGE.get(email.rawMimeR2Key);
    if (object) return new Uint8Array(await object.arrayBuffer());
    errors.push(`${email.id}: raw MIME is missing, rebuilt from stored fields`);
  }
  return emlFromStoredFields(env, email, errors);
}

/** Restorable account records. Secrets, token hashes, passkeys and sessions are never selected. */
export async function accountExport(db: Database) {
  const [userRows, domainRows, mailboxRows, memberRows] = await Promise.all([
    db.select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    }).from(users).orderBy(asc(users.id)),
    db.select({
      id: domains.id,
      name: domains.name,
      cloudflareZoneId: domains.cloudflareZoneId,
      isPrimary: domains.isPrimary,
      createdByUserId: domains.createdByUserId,
      createdAt: domains.createdAt,
      updatedAt: domains.updatedAt,
    }).from(domains).orderBy(asc(domains.id)),
    db.select({
      id: mailboxes.id,
      address: mailboxAddressSql,
      localPart: mailboxes.localPart,
      domainId: mailboxes.domainId,
      displayName: mailboxes.displayName,
      ownerUserId: mailboxes.ownerUserId,
      isPrimary: mailboxes.isPrimary,
      createdByUserId: mailboxes.createdByUserId,
      createdAt: mailboxes.createdAt,
      updatedAt: mailboxes.updatedAt,
    }).from(mailboxes).innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .orderBy(asc(mailboxes.id)),
    db.select({
      mailboxId: mailboxMembers.mailboxId,
      userId: mailboxMembers.userId,
      canSend: mailboxMembers.canSend,
      createdAt: mailboxMembers.createdAt,
    }).from(mailboxMembers).orderBy(asc(mailboxMembers.mailboxId), asc(mailboxMembers.userId)),
  ]);
  return {
    version: 1,
    users: userRows,
    domains: domainRows,
    mailboxes: mailboxRows,
    mailboxMembers: memberRows,
  };
}

async function nextMailbox(db: Database, afterId: string | null) {
  const [row] = await db
    .select({ id: mailboxes.id, address: mailboxAddressSql })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(afterId ? gt(mailboxes.id, afterId) : undefined)
    .orderBy(asc(mailboxes.id))
    .limit(1);
  return row ?? null;
}

function utcDate(now: Date) {
  return now.toISOString().slice(0, 10);
}

/**
 * Starts (or restarts) the snapshot for today's UTC date. Returns null when a
 * run is already in progress, or when `onlyIfMissing` and today exists.
 */
export async function startBackupRun(
  env: BackupEnv,
  now = new Date(),
  { onlyIfMissing = false } = {},
) {
  const bucket = env.BACKUP_STORAGE;
  if (!bucket) return null;
  const db = createDb(env.DB);
  const id = utcDate(now);
  const [running] = await db.select({ id: backupRuns.id }).from(backupRuns)
    .where(eq(backupRuns.status, "running")).limit(1);
  if (running) return null;
  if (onlyIfMissing) {
    const [existing] = await db.select({ id: backupRuns.id }).from(backupRuns)
      .where(eq(backupRuns.id, id)).limit(1);
    if (existing) return null;
  }

  await bucket.put(
    `${BACKUP_PREFIX}/${id}/account.json`,
    JSON.stringify(await accountExport(db), null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
  const first = await nextMailbox(db, null);
  const values = {
    status: "running" as const,
    mailboxId: first?.id ?? null,
    mailboxAddress: first?.address ?? null,
    emailCursor: null,
    part: 0,
    messageCount: 0,
    byteCount: 0,
    newObjectCount: 0,
    errorsJson: [],
    leaseUntil: null,
    startedAt: now,
    finishedAt: null,
  };
  await db.insert(backupRuns).values({ id, ...values })
    .onConflictDoUpdate({ target: backupRuns.id, set: values });
  return id;
}

async function storeObject(env: BackupEnv, db: Database, runId: string, bytes: Uint8Array<ArrayBuffer>) {
  const sha256 = await sha256Hex(bytes);
  const [known] = await db.select({ sha256: backupObjects.sha256 }).from(backupObjects)
    .where(eq(backupObjects.sha256, sha256)).limit(1);
  if (!known) {
    await env.BACKUP_STORAGE!.put(backupObjectKey(sha256), bytes, {
      httpMetadata: { contentType: "message/rfc822" },
      sha256,
    });
  }
  // Written after the object so a crash can only cause a harmless re-upload.
  await db.insert(backupObjects)
    .values({ sha256, size: bytes.byteLength, lastRunId: runId })
    .onConflictDoUpdate({ target: backupObjects.sha256, set: { lastRunId: runId } });
  return { sha256, isNew: !known };
}

/** Assembles the mailbox manifest from its parts and returns the part keys to delete. */
async function writeManifest(bucket: R2Bucket, prefix: string) {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${prefix}/.parts/`, cursor });
    parts.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  parts.sort();
  // ponytail: whole manifest assembled in memory (~300 B/message); stream parts if a mailbox outgrows ~100k messages.
  let manifest = "";
  for (const key of parts) manifest += await bucket.get(key).then((object) => object?.text() ?? "");
  await bucket.put(`${prefix}/manifest.jsonl`, manifest, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  return parts;
}

/** One bounded unit of work. Safe to repeat after an interruption. */
async function backupStep(env: BackupEnv, db: Database, run: BackupRun): Promise<BackupRun> {
  const bucket = env.BACKUP_STORAGE!;
  if (!run.mailboxId) return pruneStep(env, db, run);

  const address = run.mailboxAddress!;
  const prefix = mailboxPrefix(run.id, address);
  const rows = await mailboxStub(env, run.mailboxId)
    .listBackupEmails(run.emailCursor, BACKUP_BATCH_SIZE);
  const errors: string[] = [];
  let lines = "";
  let lineCount = 0;
  let bytesWritten = 0;
  let newObjects = 0;
  for (const row of rows) {
    const email = row.email as Email;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await messageBytes(env, email, errors);
    } catch (error) {
      errors.push(`${email.id}: ${errorMessage(error)}`);
      continue;
    }
    const { sha256, isNew } = await storeObject(env, db, run.id, bytes);
    if (isNew) newObjects += 1;
    bytesWritten += bytes.byteLength;
    const folder = folderPlacement({
      direction: email.direction,
      mailboxState: row.mailboxState,
      folderName: row.folderName,
    });
    const line: ManifestLine = {
      file: `../../objects/${sha256}.eml`,
      sha256,
      mailbox_address: address,
      folder_role: folder.role,
      folder_name: folder.name,
      seen: email.direction === "outgoing" || row.seen,
      received_at: new Date(email.timelineAt).toISOString(),
      size: bytes.byteLength,
      subject: email.subject,
    };
    lines += `${JSON.stringify(line)}\n`;
    lineCount += 1;
  }
  if (lines) {
    await bucket.put(`${prefix}/.parts/${String(run.part).padStart(6, "0")}.jsonl`, lines);
  }

  const counters = {
    messageCount: run.messageCount + lineCount,
    byteCount: run.byteCount + bytesWritten,
    newObjectCount: run.newObjectCount + newObjects,
    errorsJson: [...run.errorsJson, ...errors].slice(-MAX_RECORDED_ERRORS),
  };
  let cursor: Partial<BackupRun>;
  let finishedParts: string[] = [];
  if (rows.length === BACKUP_BATCH_SIZE) {
    cursor = { emailCursor: rows.at(-1)!.email.id, part: run.part + 1 };
  } else {
    finishedParts = await writeManifest(bucket, prefix);
    const next = await nextMailbox(db, run.mailboxId);
    cursor = {
      mailboxId: next?.id ?? null,
      mailboxAddress: next?.address ?? null,
      emailCursor: null,
      part: 0,
    };
  }
  const [updated] = await db.update(backupRuns).set({ ...counters, ...cursor })
    .where(eq(backupRuns.id, run.id)).returning();
  // Parts are removed only after the cursor moved on, so a retried step can always rebuild the manifest.
  for (let index = 0; index < finishedParts.length; index += 1000) {
    await bucket.delete(finishedParts.slice(index, index + 1000));
  }
  return updated!;
}

/**
 * Deletes snapshots outside the retention window one page at a time, then
 * objects whose newest reference predates the oldest kept snapshot.
 */
async function pruneStep(env: BackupEnv, db: Database, run: BackupRun): Promise<BackupRun> {
  const bucket = env.BACKUP_STORAGE!;
  const ids = (await db.select({ id: backupRuns.id }).from(backupRuns)).map((row) => row.id);
  const keep = retainedBackupIds(ids);
  const expired = ids.filter((id) => !keep.has(id)).sort()[0];
  if (expired) {
    const page = await bucket.list({ prefix: `${BACKUP_PREFIX}/${expired}/`, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    if (!page.truncated) await db.delete(backupRuns).where(eq(backupRuns.id, expired));
    return run;
  }

  const oldestKept = [...keep].sort()[0]!;
  const unreferenced = await db.select({ sha256: backupObjects.sha256 }).from(backupObjects)
    .where(lt(backupObjects.lastRunId, oldestKept)).limit(1000);
  if (unreferenced.length) {
    await bucket.delete(unreferenced.map((row) => backupObjectKey(row.sha256)));
    for (let index = 0; index < unreferenced.length; index += 90) {
      await db.delete(backupObjects).where(inArray(
        backupObjects.sha256,
        unreferenced.slice(index, index + 90).map((row) => row.sha256),
      ));
    }
    return run;
  }

  const [completed] = await db.update(backupRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(backupRuns.id, run.id)).returning();
  return completed!;
}

/**
 * Cron entry point: continues the running snapshot, or starts today's when
 * none exists. A lease keeps overlapping invocations from sharing a cursor.
 */
export async function runBackupTick(
  env: BackupEnv,
  now = new Date(),
  maxSteps = MAX_STEPS_PER_INVOCATION,
) {
  if (!env.BACKUP_STORAGE) return;
  const db = createDb(env.DB);
  await startBackupRun(env, now, { onlyIfMissing: true });
  const [leased] = await db.update(backupRuns)
    .set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(and(
      eq(backupRuns.status, "running"),
      or(isNull(backupRuns.leaseUntil), lt(backupRuns.leaseUntil, now)),
    ))
    .returning();
  if (!leased) return;

  let run = leased;
  try {
    for (let step = 0; step < maxSteps && run.status === "running"; step += 1) {
      run = await backupStep(env, db, run);
    }
  } catch (error) {
    console.error("Backup step failed", error);
    run = { ...run, errorsJson: [...run.errorsJson, errorMessage(error)].slice(-MAX_RECORDED_ERRORS) };
    await db.update(backupRuns).set({ errorsJson: run.errorsJson })
      .where(eq(backupRuns.id, run.id));
  } finally {
    await db.update(backupRuns).set({ leaseUntil: null }).where(eq(backupRuns.id, run.id));
  }
}

export async function backupStatus(env: BackupEnv) {
  const [latest] = await createDb(env.DB).select().from(backupRuns)
    .orderBy(desc(backupRuns.startedAt)).limit(1);
  return {
    enabled: Boolean(env.BACKUP_STORAGE),
    latest: latest
      ? {
          id: latest.id,
          status: latest.status,
          startedAt: latest.startedAt.getTime(),
          finishedAt: latest.finishedAt?.getTime() ?? null,
          currentMailbox: latest.mailboxAddress,
          messageCount: latest.messageCount,
          byteCount: latest.byteCount,
          newObjectCount: latest.newObjectCount,
          errors: latest.errorsJson,
        }
      : null,
  };
}
