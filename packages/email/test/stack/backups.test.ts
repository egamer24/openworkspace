import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { required } from "@open-workspace/core/shared";
import { mcpAccessToken } from "@open-workspace/core/testing";
import { main } from "@open-workspace/create/import/cli.ts";
import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin } from "./mail-flow-helpers.ts";
import { env, hooks, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * Backups end to end: the hourly cron writes core's data and every
 * mailbox to BACKUP_STORAGE, the next snapshot stores only new mail, and
 * `import backup` puts back a deleted team, its address and its mail, and
 * a person, branding and a webhook.
 */

const origin = "http://example.test";
const orphan = `backups/objects/${"0".repeat(64)}.eml`;
const oldSnapshot = "2025-01-06T041700.000Z";
const webhookSecret = "whsec_backup_test_secret_value";
let cookie = "";
let adaId = "";
let bobId = "";
let teamId = "";
let kilnId = "";

const idRow = z.object({ id: z.string() });

/** An admin or mail request with a JSON body, already serialized; its JSON answer. */
async function call(path: string, method: string, body?: string) {
  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body,
    })
  );

  expect(response.status, path).toBeLessThan(300);

  return z.looseObject({}).parse(await response.json());
}

function raw(id: string, subject: string, inReplyTo?: string) {
  return [
    "From: Rosa Quill <rosa@fernhollow.example>",
    "To: kiln@example.test",
    `Subject: ${subject}`,
    "Date: Tue, 03 Mar 2026 10:00:00 +0000",
    `Message-ID: <${id}@fernhollow.example>`,
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}@fernhollow.example>`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${id}.`,
    "",
  ].join("\r\n");
}

async function importMessage(
  id: string,
  subject: string,
  options: Record<string, string>,
  inReplyTo?: string
) {
  const url = new URL(`${origin}/api/mail/import/mailboxes/${kilnId}/messages`);

  url.search = new URLSearchParams({ sourceId: id, ...options }).toString();

  const response = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { cookie, "content-type": "message/rfc822" },
      body: raw(id, subject, inReplyTo),
    })
  );

  expect(response.status).toBe(201);
  await response.json();
}

/** Each message of a mailbox with its place, folder and read state, in subject order. */
function messages(mailboxId: string) {
  return hooks.mailboxSql(
    mailboxId,
    `SELECT e.subject, e.direction, c.mailbox_state, f.name AS folder,
       exists(SELECT 1 FROM email_read_states r WHERE r.email_id = e.id) AS seen,
       (SELECT count(*) FROM emails o WHERE o.conversation_id = e.conversation_id) AS thread_size
     FROM emails e JOIN conversations c ON c.id = e.conversation_id
     LEFT JOIN folders f ON f.id = c.folder_id
     ORDER BY e.subject`
  );
}

const statusBody = z.object({
  enabled: z.boolean(),
  latest: z
    .object({
      id: z.string(),
      status: z.enum(["running", "completed"]),
      itemCount: z.number(),
      newObjectCount: z.number(),
      errors: z.array(z.string()),
    })
    .nullable(),
});

async function backupStatus() {
  return readJson(
    await worker.fetch(
      new Request(`${origin}/api/admin/backups`, { headers: { cookie } })
    ),
    statusBody
  );
}

async function keys(prefix: string) {
  return (await env.BACKUP_STORAGE.list({ prefix })).objects.map(
    (object) => object.key
  );
}

/** Copies every object of the backup bucket under `dir`, as rclone would. */
async function downloadBucket(dir: string) {
  for (const key of await keys("backups/")) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of small objects
    const body = required(await env.BACKUP_STORAGE.get(key), key);
    const path = join(dir, key);
    mkdirSync(dirname(path), { recursive: true });
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    writeFileSync(path, await body.bytes());
  }
}

beforeAll(async () => {
  cookie = await bootstrapAdmin("ada@example.test", "Ada Moss");
  adaId = idRow.parse(await env.DB.prepare("SELECT id FROM users").first()).id;

  await call(
    "/api/admin/invitations",
    "POST",
    JSON.stringify({
      name: "Bob Reed",
      email: "bob@example.test",
    })
  );
  bobId = idRow.parse(
    await env.DB.prepare("SELECT id FROM users WHERE name = 'Bob Reed'").first()
  ).id;

  const team = await call(
    "/api/admin/teams",
    "POST",
    JSON.stringify({
      name: "Kiln",
      slug: "kiln",
      description: null,
      members: [{ userId: adaId, canSend: true }],
    })
  );

  teamId = idRow.parse(
    await env.DB.prepare("SELECT id FROM teams WHERE slug = 'kiln'").first()
  ).id;
  expect(team.ok).toBe(true);

  kilnId = z.object({ mailboxId: z.string() }).parse(
    await call(
      "/api/admin/mailboxes",
      "POST",
      JSON.stringify({
        address: "kiln@example.test",
        displayName: "Kiln",
        ownerUserId: null,
        teamId,
      })
    )
  ).mailboxId;

  await importMessage("m1", "Kiln schedule", {
    placement: "inbox",
    folder: "Clients",
    seen: "1",
    thread: "t1",
  });
  await importMessage(
    "m2",
    "Re: Kiln schedule",
    { placement: "inbox", folder: "Clients", thread: "t1" },
    "m1"
  );
  await importMessage("m3", "Your receipt", {
    placement: "archive",
    seen: "1",
  });
  await importMessage("m4", "You won a tractor", { placement: "spam" });
  await importMessage("m5", "Old newsletter", { placement: "trash" });

  // Sent mail has no stored MIME; the backup writes it from its fields.
  await call(
    "/api/mail/messages",
    "POST",
    JSON.stringify({
      requestId: crypto.randomUUID(),
      mailboxId: kilnId,
      to: ["rosa@fernhollow.example"],
      subject: "Glaze order – Grüße",
      bodyText: "Two kilos of celadon, please.",
    })
  );

  await call(
    "/api/admin/branding/name",
    "PUT",
    JSON.stringify({ name: "Fern Hollow" })
  );
  await env.DB.prepare(
    `INSERT INTO webhook_endpoints (id, name, url, events, signing_secret, created_by_user_id)
     VALUES ('whk_backup', 'Orders', 'https://hooks.fernhollow.example/in', '["user.created"]', ?, ?)`
  )
    .bind(webhookSecret, adaId)
    .run();

  // An object no snapshot names, and a snapshot older than retention.
  await env.BACKUP_STORAGE.put(orphan, "stray");
  await env.BACKUP_STORAGE.put(`backups/${oldSnapshot}/core.json`, "{}");
  await env.DB.prepare(
    `INSERT INTO backup_runs (id, status, started_at, finished_at, swept)
     VALUES (?, 'completed', 1736137020000, 1736137080000, 1)`
  )
    .bind(oldSnapshot)
    .run();
});

describe("backups", () => {
  it("snapshots the workspace and every mailbox on the hourly cron, without secrets", async () => {
    await hooks.scheduled({ scheduledTime: Date.now() });

    const status = await backupStatus();
    expect(status).toMatchObject({
      enabled: true,
      latest: { status: "completed", errors: [] },
    });
    const { id } = required(status.latest, "a snapshot ran");

    const files = await keys(`backups/${id}/email/kiln@example.test/`);
    expect(files.length).toBeGreaterThan(0);

    const lines = (
      await Promise.all(
        files.map(async (key) =>
          required(await env.BACKUP_STORAGE.get(key), key).text()
        )
      )
    )
      .join("")
      .trim()
      .split("\n")
      .map((line) =>
        z
          .looseObject({
            subject: z.string(),
            placement: z.string(),
            object: z.string(),
          })
          .parse(JSON.parse(line))
      );

    expect(
      lines.map((line) => `${line.subject}: ${line.placement}`).toSorted()
    ).toEqual([
      "Glaze order – Grüße: sent",
      "Kiln schedule: inbox",
      "Old newsletter: trash",
      "Re: Kiln schedule: inbox",
      "You won a tractor: spam",
      "Your receipt: archive",
    ]);

    const objects = await Promise.all(
      lines.map((line) =>
        env.BACKUP_STORAGE.head(`backups/objects/${line.object}`)
      )
    );

    expect(objects).not.toContain(null);

    // The mailbox keeps each message's hash, so the next snapshot reads none again.
    expect(
      await hooks.mailboxSql(
        kilnId,
        "SELECT count(*) AS missing FROM emails WHERE backup_sha256 IS NULL"
      )
    ).toEqual([{ missing: 0 }]);

    const core = await required(
      await env.BACKUP_STORAGE.get(`backups/${id}/core.json`),
      "core.json"
    ).text();

    for (const text of [
      "bob@example.test",
      "kiln@example.test",
      "Fern Hollow",
      "hooks.fernhollow.example",
    ]) {
      expect(core).toContain(text);
    }

    // Session ids, token hashes, signing secrets and passkeys are never exported.
    const secrets = await env.DB.prepare(
      "SELECT id AS value FROM sessions UNION ALL SELECT token_hash FROM sessions"
    ).all<{ value: string }>();

    expect(secrets.results.length).toBeGreaterThan(0);

    for (const { value } of [...secrets.results, { value: webhookSecret }]) {
      expect(core).not.toContain(value);
    }

    expect(core).not.toMatch(/hash|secret|token|passkey|public_?key/iu);

    // Retention dropped the old snapshot, and the weekly sweep the stray object.
    expect(await keys(`backups/${oldSnapshot}/`)).toEqual([]);
    expect(await env.BACKUP_STORAGE.head(orphan)).toBeNull();

    // The next tick finds today's snapshot done.
    await hooks.scheduled({ scheduledTime: Date.now() });
    expect((await backupStatus()).latest?.id).toBe(id);
  });

  it("reads and stores only new mail in the next snapshot", async () => {
    await importMessage("m6", "Firing log", {
      placement: "archive",
      seen: "1",
    });

    // A known message is listed from the mailbox's rows: its raw message is not read again.
    const [known] = await hooks.mailboxSql<{ raw_mime_r2_key: string }>(
      kilnId,
      "SELECT raw_mime_r2_key FROM emails WHERE subject = 'Kiln schedule'"
    );

    await env.MAIL_STORAGE.delete(required(known, "m1").raw_mime_r2_key);

    const run = await hooks.fetchAndWait(
      new Request(`${origin}/api/admin/backups/run`, {
        method: "POST",
        headers: { cookie, origin },
      })
    );

    expect(run.status).toBe(202);
    await run.json();
    // Run now works for a while; the cron finishes what is left.
    await hooks.scheduled({ scheduledTime: Date.now() });

    expect((await backupStatus()).latest).toMatchObject({
      status: "completed",
      itemCount: 7,
      newObjectCount: 1,
      errors: [],
    });
  });

  it("restores a deleted team, its address and mail, a person, branding and a webhook", async () => {
    const before = await messages(kilnId);
    const dir = mkdtempSync(join(tmpdir(), "ow-backup-"));
    await downloadBucket(dir);
    const { id } = required((await backupStatus()).latest, "a snapshot");

    // What a bad day takes: the team, its address and mail, a person, the name, a webhook.
    await call(`/api/admin/mailboxes/${kilnId}`, "DELETE");
    await call("/api/admin/branding/name", "PUT", JSON.stringify({ name: "" }));

    for (const statement of [
      ["DELETE FROM teams WHERE id = ?", teamId],
      ["DELETE FROM access_links WHERE user_id = ?", bobId],
      ["DELETE FROM mailboxes WHERE owner_user_id = ?", bobId],
      ["DELETE FROM users WHERE id = ?", bobId],
      ["DELETE FROM webhook_endpoints WHERE id = ?", "whk_backup"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- in order, for the foreign keys
      await env.DB.prepare(statement[0]).bind(statement[1]).run();
    }

    const { accessToken } = await mcpAccessToken(cookie, {
      scope: "admin.workspace",
    });

    const restore = async (stateDir: string) => {
      const log: string[] = [];

      const code = await main(
        [
          "backup",
          join(dir, "backups", id),
          "--workspace",
          origin,
          "--token",
          accessToken,
          "--state-dir",
          join(dir, stateDir),
        ],
        {
          fetch: (input: string, init?: RequestInit) =>
            worker.fetch(new Request(input, init)),
          credentialsPath: null,
          log: (line) => log.push(line),
          progress: () => {},
        }
      );

      expect(code, log.join("\n")).toBe(0);

      return log.join("\n");
    };

    const log = await restore("state");
    expect(log).toContain("people 1, teams 1, addresses 2");
    expect(log).toContain("7 restored");

    const restoredId = idRow.parse(
      await env.DB.prepare(
        "SELECT id FROM mailboxes WHERE local_part = 'kiln' AND team_id = ?"
      )
        .bind(teamId)
        .first()
    ).id;

    expect(await messages(restoredId)).toEqual(before);
    expect(
      await env.DB.prepare(
        `SELECT u.status, m.local_part, m.is_primary FROM users u
         JOIN mailboxes m ON m.owner_user_id = u.id WHERE u.id = ?`
      )
        .bind(bobId)
        .all()
    ).toMatchObject({
      results: [{ status: "invited", local_part: "bob", is_primary: 1 }],
    });
    expect(
      await env.DB.prepare("SELECT user_id FROM team_members WHERE team_id = ?")
        .bind(teamId)
        .all()
    ).toMatchObject({ results: [{ user_id: adaId }] });

    // A restored webhook is off, with a secret of its own.
    const webhook = await env.DB.prepare(
      "SELECT enabled, signing_secret FROM webhook_endpoints WHERE id = 'whk_backup'"
    ).first<{ enabled: number; signing_secret: string }>();

    expect(webhook?.enabled).toBe(0);
    expect(webhook?.signing_secret).not.toBe(webhookSecret);
    expect(
      await env.DB.prepare(
        "SELECT value FROM settings WHERE key = 'workspace_name'"
      ).first()
    ).toEqual({ value: "Fern Hollow" });

    // Again: everything is there already.
    const again = await restore("state-again");
    expect(again).toContain("people 0, teams 0, addresses 0");
    expect(again).toContain("0 restored, 7 already there");
  });

  it("is for administrators only", async () => {
    const { accessToken } = await mcpAccessToken(cookie, {
      scope: "mail.read",
    });

    const refused = await worker.fetch(
      new Request(`${origin}/api/admin/backups`, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    );

    expect(refused.status).toBe(403);
    await refused.text();
  });
});
