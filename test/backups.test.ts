import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_BATCH_SIZE,
  backupObjectKey,
  type ManifestLine,
  retainedBackupIds,
  runBackupTick,
} from "../worker/backups/job";
import { createDb } from "../worker/db/client";
import {
  accountApiTokens,
  backupObjects,
  backupRuns,
  domains,
  mailboxMembers,
  mailboxes,
  passkeyCredentials,
  sessions,
  users,
} from "../worker/db/schema";
import { mailboxStub } from "../worker/mailbox";
import type { NewEmail } from "../worker/mailbox/schema";

const db = createDb(env.DB);
const bucket = env.BACKUP_STORAGE;
const DAY = new Date("2026-03-10T03:00:00Z");

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bucketKeys(prefix = "backups/") {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function runToCompletion(now: Date) {
  for (let tick = 0; tick < 50; tick += 1) {
    await runBackupTick(env, now);
    const [run] = await db.select().from(backupRuns).where(eq(backupRuns.id, now.toISOString().slice(0, 10)));
    if (run?.status === "completed") return run;
  }
  throw new Error("Backup did not complete");
}

async function manifest(runId: string, address: string) {
  const object = await bucket.get(`backups/${runId}/${address}/manifest.jsonl`);
  const text = await object!.text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ManifestLine);
}

async function seedWorkspace() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `usr_backup_${suffix}`;
  const domainId = `dom_backup_${suffix}`;
  const mailboxId = `mbx_backup_${suffix}`;
  const domain = `backup-${suffix}.example`;
  const now = new Date();
  await db.batch([
    db.insert(users).values({ id: userId, name: "Backup Owner", role: "admin", status: "active" }),
    db.insert(domains).values({ id: domainId, name: domain, createdByUserId: userId }),
    db.insert(mailboxes).values({
      id: mailboxId,
      localPart: "team",
      domainId,
      displayName: "Team",
      ownerUserId: null,
      createdByUserId: userId,
    }),
    db.insert(mailboxMembers).values({ mailboxId, userId, canSend: true }),
    db.insert(sessions).values({
      id: `ses_secret_${suffix}`,
      userId,
      tokenHash: `session-hash-secret-${suffix}`,
      expiresAt: new Date(now.getTime() + 86_400_000),
    }),
    db.insert(accountApiTokens).values({
      id: `tok_secret_${suffix}`,
      userId,
      name: "CLI",
      tokenHash: `api-token-hash-secret-${suffix}`,
      tokenPrefix: "owk_secret",
    }),
    db.insert(passkeyCredentials).values({
      credentialId: `passkey-credential-secret-${suffix}`,
      userId,
      publicKey: `passkey-public-key-secret-${suffix}`,
      deviceType: "multiDevice",
    }),
  ] as const);
  return {
    userId,
    mailboxId,
    address: `team@${domain}`,
    secrets: [
      `ses_secret_${suffix}`,
      `session-hash-secret-${suffix}`,
      `api-token-hash-secret-${suffix}`,
      `passkey-credential-secret-${suffix}`,
      `passkey-public-key-secret-${suffix}`,
    ],
  };
}

function email(id: string, overrides: Partial<NewEmail> = {}): NewEmail {
  return {
    id,
    conversationId: `conv_${id}`,
    direction: "incoming",
    fromJson: [{ address: "sender@example.net", name: "Sender" }],
    toJson: [{ address: "team@example.test", name: null }],
    subject: `Subject ${id}`,
    bodyText: `Body ${id}`,
    timelineAt: new Date("2026-03-01T12:00:00Z"),
    transportState: "received",
    ...overrides,
  };
}

beforeEach(async () => {
  await db.delete(backupRuns);
  await db.delete(backupObjects);
  await db.delete(mailboxMembers);
  await db.delete(mailboxes);
  const keys = await bucketKeys();
  for (let index = 0; index < keys.length; index += 1000) {
    await bucket.delete(keys.slice(index, index + 1000));
  }
});

describe("scheduled backups", () => {
  it("writes a complete manifest, raw and rebuilt .eml objects, and a secret-free account export", async () => {
    const workspace = await seedWorkspace();
    const raw = "From: Sender <sender@example.net>\r\nTo: team@example.test\r\nSubject: Raw hello\r\nMessage-ID: <raw@example.net>\r\n\r\nHello raw\r\n";
    await env.MAIL_STORAGE.put(`mailboxes/${workspace.mailboxId}/raw/raw.eml`, raw);
    await env.MAIL_STORAGE.put(`mailboxes/${workspace.mailboxId}/attachments/report`, "report-bytes");
    const mailbox = mailboxStub(env, workspace.mailboxId);
    await mailbox.seedMailbox(
      [{ id: "fld_receipts", name: "Receipts" }],
      [
        email("msg_a_raw", {
          subject: "Raw hello",
          rawMimeR2Key: `mailboxes/${workspace.mailboxId}/raw/raw.eml`,
        }),
        email("msg_b_folder"),
        email("msg_c_spam"),
        email("msg_d_sent", {
          direction: "outgoing",
          fromJson: [{ address: workspace.address, name: "Team" }],
          toJson: [{ address: "client@example.net", name: "Client Ü" }],
          subject: "Quarterly report ✓",
          bodyText: "See attached.",
          messageIdHeader: "<sent@example.test>",
          transportState: "submitted",
          attachmentsJson: [{
            id: "att_1",
            r2Key: `mailboxes/${workspace.mailboxId}/attachments/report`,
            filename: "report.txt",
            contentType: "text/plain",
            size: 12,
            contentId: null,
            disposition: "attachment",
            delivery: "attached",
            downloadTokenHash: "attachment-download-hash-secret",
            downloadExpiresAt: null,
          }],
        }),
      ],
      [
        { id: "conv_msg_b_folder", folderId: "fld_receipts" },
        { id: "conv_msg_c_spam", mailboxState: "spam" },
      ],
    );
    await mailbox.setMessageRead(workspace.userId, "msg_a_raw", true);

    const run = await runToCompletion(DAY);
    expect(run.messageCount).toBe(4);
    expect(run.newObjectCount).toBe(4);
    expect(run.errorsJson).toEqual([]);

    const lines = await manifest("2026-03-10", workspace.address);
    expect(lines.map((line) => [line.subject, line.folder_role, line.folder_name, line.seen])).toEqual([
      ["Raw hello", "inbox", "Inbox", true],
      ["Subject msg_b_folder", "custom", "Receipts", false],
      ["Subject msg_c_spam", "spam", "Spam", false],
      ["Quarterly report ✓", "sent", "Sent", true],
    ]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        "file", "folder_name", "folder_role", "mailbox_address", "received_at", "seen", "sha256", "size", "subject",
      ]);
      expect(line.mailbox_address).toBe(workspace.address);
      expect(line.received_at).toBe("2026-03-01T12:00:00.000Z");
      expect(line.file).toBe(`../../objects/${line.sha256}.eml`);
      const object = await bucket.get(backupObjectKey(line.sha256));
      const bytes = await object!.arrayBuffer();
      expect(bytes.byteLength).toBe(line.size);
      expect(await sha256Hex(bytes)).toBe(line.sha256);
    }

    const rawCopy = await bucket.get(backupObjectKey(lines[0]!.sha256));
    expect(await rawCopy!.text()).toBe(raw);
    const rebuilt = await PostalMime.parse(
      await (await bucket.get(backupObjectKey(lines[3]!.sha256)))!.arrayBuffer(),
    );
    expect(rebuilt.subject).toBe("Quarterly report ✓");
    expect(rebuilt.messageId).toBe("<sent@example.test>");
    expect(rebuilt.to?.[0]).toMatchObject({ address: "client@example.net", name: "Client Ü" });
    expect(rebuilt.text?.trim()).toBe("See attached.");
    expect(rebuilt.attachments).toHaveLength(1);
    expect(rebuilt.attachments[0]).toMatchObject({ filename: "report.txt", mimeType: "text/plain" });
    expect(new TextDecoder().decode(rebuilt.attachments[0]!.content as ArrayBuffer)).toBe("report-bytes");

    const account = JSON.parse(await (await bucket.get("backups/2026-03-10/account.json"))!.text());
    expect(account.users).toContainEqual(expect.objectContaining({ id: workspace.userId, name: "Backup Owner" }));
    expect(account.mailboxes).toContainEqual(expect.objectContaining({ id: workspace.mailboxId, address: workspace.address }));
    expect(account.mailboxMembers).toContainEqual(expect.objectContaining({ mailboxId: workspace.mailboxId, userId: workspace.userId }));

    const keys = await bucketKeys();
    expect(keys.some((key) => key.includes("/.parts/"))).toBe(false);
    const everything = (await Promise.all(keys
      .filter((key) => !key.startsWith("backups/objects/"))
      .map(async (key) => (await bucket.get(key))!.text()))).join("\n");
    for (const secret of [...workspace.secrets, "attachment-download-hash-secret"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("copies unchanged messages only once across runs", async () => {
    const workspace = await seedWorkspace();
    const mailbox = mailboxStub(env, workspace.mailboxId);
    await mailbox.seedMailbox([], [email("msg_1"), email("msg_2")]);

    await runToCompletion(DAY);
    const objectsAfterFirst = await bucketKeys("backups/objects/");
    expect(objectsAfterFirst).toHaveLength(2);

    await mailbox.seedMailbox([], [email("msg_3")]);
    const second = await runToCompletion(new Date("2026-03-11T03:00:00Z"));
    expect(second.messageCount).toBe(3);
    expect(second.newObjectCount).toBe(1);
    expect(await bucketKeys("backups/objects/")).toHaveLength(3);

    const first = await manifest("2026-03-10", workspace.address);
    const next = await manifest("2026-03-11", workspace.address);
    expect(next.slice(0, 2).map((line) => line.file)).toEqual(first.map((line) => line.file));
  });

  it("resumes an interrupted batch without losing or duplicating manifest lines", async () => {
    const workspace = await seedWorkspace();
    const total = BACKUP_BATCH_SIZE * 2 + 7;
    await mailboxStub(env, workspace.mailboxId).seedMailbox([], Array.from(
      { length: total },
      (_, index) => email(`msg_${String(index).padStart(4, "0")}`),
    ));

    await runBackupTick(env, DAY, 1);
    let [run] = await db.select().from(backupRuns);
    expect(run).toMatchObject({ status: "running", part: 1, messageCount: BACKUP_BATCH_SIZE, leaseUntil: null });

    // The second batch fails while writing its manifest part.
    const put = bucket.put.bind(bucket);
    const spy = vi.spyOn(bucket, "put").mockImplementation((key, ...rest) => {
      if (key.includes("/.parts/")) throw new Error("R2 unavailable");
      return put(key, ...rest);
    });
    await runBackupTick(env, DAY, 1);
    spy.mockRestore();
    [run] = await db.select().from(backupRuns);
    expect(run).toMatchObject({ status: "running", part: 1, messageCount: BACKUP_BATCH_SIZE, leaseUntil: null });
    expect(run!.errorsJson).toEqual(["R2 unavailable"]);

    run = await runToCompletion(DAY);
    expect(run.messageCount).toBe(total);
    const lines = await manifest("2026-03-10", workspace.address);
    expect(lines).toHaveLength(total);
    expect(new Set(lines.map((line) => line.subject)).size).toBe(total);
  });

  it("prunes snapshots outside retention and garbage-collects unreferenced objects", async () => {
    const workspace = await seedWorkspace();
    await mailboxStub(env, workspace.mailboxId).seedMailbox([], [email("msg_kept")]);
    const oldIds = Array.from({ length: 30 }, (_, index) =>
      new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));
    for (const id of oldIds) {
      await db.insert(backupRuns).values({ id, status: "completed", startedAt: new Date(id) });
      await bucket.put(`backups/${id}/${workspace.address}/manifest.jsonl`, "");
    }
    await db.insert(backupObjects).values({ sha256: "f".repeat(64), size: 1, lastRunId: "2026-01-01" });
    await bucket.put(backupObjectKey("f".repeat(64)), "stale");

    await runToCompletion(DAY);
    const keep = retainedBackupIds([...oldIds, "2026-03-10"]);
    const remaining = (await db.select({ id: backupRuns.id }).from(backupRuns)).map((row) => row.id).sort();
    expect(remaining).toEqual([...keep].sort());
    for (const id of oldIds) {
      expect((await bucketKeys(`backups/${id}/`)).length > 0).toBe(keep.has(id));
    }
    expect(await bucket.head(backupObjectKey("f".repeat(64)))).toBeNull();
    const [line] = await manifest("2026-03-10", workspace.address);
    expect(await bucket.head(backupObjectKey(line!.sha256))).not.toBeNull();
  });
});

describe("retainedBackupIds", () => {
  it("keeps 14 daily snapshots and the newest snapshot of 8 weeks", () => {
    const ids = Array.from({ length: 90 }, (_, index) =>
      new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));
    const keep = [...retainedBackupIds(ids)].sort();
    // 2026-03-31 is a Tuesday: 14 dailies reach back to Wednesday 03-18,
    // and the weekly picks add the Sundays ending the five weeks before that.
    expect(keep).toEqual([
      "2026-02-15", "2026-02-22", "2026-03-01", "2026-03-08", "2026-03-15",
      ...Array.from({ length: 14 }, (_, index) =>
        new Date(Date.UTC(2026, 2, 18 + index)).toISOString().slice(0, 10)),
    ]);
  });
});
