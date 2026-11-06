import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/mailbox/migrations.js";
import { mailboxStub } from "../worker/mailbox";
import type { NewEmail } from "../worker/mailbox/schema";

const DAY_MS = 24 * 60 * 60 * 1_000;

function email(id: string, conversationId = `conv_${id}`, timelineAt = new Date()): NewEmail {
  return {
    id: `msg_${id}`,
    conversationId,
    direction: "incoming",
    fromJson: [{ address: "sender@example.test", name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: id,
    timelineAt,
    transportState: "received",
    attachmentsJson: [],
  };
}

async function seed(mailbox: ReturnType<typeof mailboxStub>, ids: string[], state: "trash" | "spam") {
  for (const id of ids) await mailbox.insertEmail(email(id));
  expect(await mailbox.bulkUpdateConversations(
    ids.map((id) => `conv_${id}`),
    "inbox",
    { mailboxState: state },
  )).toBe(ids.length);
}

function stateRows(mailbox: ReturnType<typeof mailboxStub>) {
  return runInDurableObject(mailbox, (_, state) => state.storage.sql
    .exec<{ id: string; mailbox_state: string; state_changed_at: number | null }>(
      "select id, mailbox_state, state_changed_at from conversations order by id",
    ).toArray());
}

describe("Trash and Spam retention", () => {
  it("backfills existing Trash and Spam at deploy time so nothing is deleted at once", async () => {
    const mailbox = mailboxStub(env, `mbx_retention_upgrade_${crypto.randomUUID()}`);
    await runInDurableObject(mailbox, async (instance, state) => {
      await state.storage.deleteAll();
      const db = drizzle(state.storage);
      await migrate(db, {
        ...migrations,
        journal: { entries: migrations.journal.entries.filter((entry) => entry.idx < 6) },
      });
      await instance.insertEmail(email("old_trash"));
      await instance.insertEmail(email("old_inbox"));
      state.storage.sql.exec("update conversations set mailbox_state = 'trash' where id = 'conv_old_trash'");
      const before = Date.now();
      await migrate(db, migrations);
      const rows = state.storage.sql
        .exec<{ id: string; state_changed_at: number | null }>(
          "select id, state_changed_at from conversations order by id",
        ).toArray();
      expect(rows.find((row) => row.id === "conv_old_inbox")?.state_changed_at).toBeNull();
      expect(rows.find((row) => row.id === "conv_old_trash")?.state_changed_at)
        .toBeGreaterThanOrEqual(Math.floor(before / 1_000) * 1_000);
    });
  });

  it("stamps every state change, including new mail reactivating a thread", async () => {
    const mailbox = mailboxStub(env, `mbx_retention_trigger_${crypto.randomUUID()}`);
    await seed(mailbox, ["a"], "trash");
    const [trashed] = await stateRows(mailbox);
    expect(trashed).toMatchObject({ mailbox_state: "trash" });
    expect(trashed!.state_changed_at).toEqual(expect.any(Number));

    await runInDurableObject(mailbox, (_, state) => {
      state.storage.sql.exec("update conversations set state_changed_at = 1");
    });
    // A reply in the same thread reactivates it through the emails_after_insert upsert.
    await mailbox.insertEmail(email("a_reply", "conv_a", new Date(Date.now() + 1_000)));
    const [reactivated] = await stateRows(mailbox);
    expect(reactivated).toMatchObject({ mailbox_state: "active" });
    expect(reactivated!.state_changed_at).toBeGreaterThan(1);
  });

  it("empties Trash or Spam in batches without touching the other folder", async () => {
    const mailbox = mailboxStub(env, `mbx_retention_empty_${crypto.randomUUID()}`);
    const spam = Array.from({ length: 105 }, (_, index) => `spam_${index}`);
    await seed(mailbox, spam, "spam");
    await seed(mailbox, ["kept"], "trash");

    expect(await mailbox.emptyFolder("spam")).toEqual({ deleted: 100, remaining: 5 });
    expect(await mailbox.emptyFolder("spam")).toEqual({ deleted: 5, remaining: 0 });
    expect(await mailbox.emptyFolder("spam")).toEqual({ deleted: 0, remaining: 0 });
    expect(await stateRows(mailbox)).toMatchObject([{ id: "conv_kept", mailbox_state: "trash" }]);
    expect(await mailbox.getEmail("msg_spam_0")).toBeNull();
  });

  it("deletes only conversations past their retention and schedules the next expiry", async () => {
    const mailbox = mailboxStub(env, `mbx_retention_alarm_${crypto.randomUUID()}`);
    await seed(mailbox, ["expired", "fresh"], "trash");
    await seed(mailbox, ["spam_expired"], "spam");
    const now = Date.now();
    await runInDurableObject(mailbox, (_, state) => {
      state.storage.sql.exec(
        "update conversations set state_changed_at = ? where id in ('conv_expired', 'conv_spam_expired')",
        now - 8 * DAY_MS,
      );
      state.storage.sql.exec(
        "update conversations set state_changed_at = ? where id = 'conv_fresh'",
        now - 2 * DAY_MS,
      );
    });

    // Spam retention off: only Trash is cleaned.
    await mailbox.setRetention({ trashDays: 7, spamDays: null }, "usr_test");
    await runInDurableObject(mailbox, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
      const alarm = await state.storage.getAlarm();
      // Next expiry: conv_fresh, five days from now.
      expect(alarm).toBeGreaterThan(now + 4 * DAY_MS);
      expect(alarm).toBeLessThan(now + 6 * DAY_MS);
    });
    expect((await stateRows(mailbox)).map((row) => row.id))
      .toEqual(["conv_fresh", "conv_spam_expired"]);

    await mailbox.setRetention({ trashDays: 7, spamDays: 7 }, "usr_test");
    await runInDurableObject(mailbox, async (instance) => instance.alarm());
    expect((await stateRows(mailbox)).map((row) => row.id)).toEqual(["conv_fresh"]);
  });

  it("schedules cleanup when mail is moved to Trash after retention is set", async () => {
    const mailbox = mailboxStub(env, `mbx_retention_schedule_${crypto.randomUUID()}`);
    await mailbox.setRetention({ trashDays: 30, spamDays: null }, "usr_test");
    await runInDurableObject(mailbox, (_, state) => state.storage.deleteAlarm());
    const before = Date.now();
    await seed(mailbox, ["later"], "trash");
    await expect.poll(() => runInDurableObject(mailbox, (_, state) => state.storage.getAlarm()))
      .toBeGreaterThanOrEqual(before + 30 * DAY_MS - 1_000);
  });
});

describe("retention API", () => {
  it("validates days, requires a mailbox, and empties folders", async () => {
    const bootstrap = await exports.default.fetch(new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }));
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await exports.default.fetch(new Request(`http://example.test${path}`, {
        ...init,
        headers: { cookie, "content-type": "application/json" },
      }));
      return { status: response.status, body: await response.json<Record<string, any>>() };
    };
    const { body: { mailboxes: [mailbox] } } = await call("/api/mail/mailboxes");
    const base = `/api/mail/mailboxes/${mailbox.id}`;

    expect(await call(`${base}/retention`)).toMatchObject({
      status: 200,
      body: { retention: { trashDays: null, spamDays: null } },
    });
    const put = (body: unknown) => call(`${base}/retention`, { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ trashDays: 0, spamDays: null })).status).toBe(400);
    expect((await put({ trashDays: 366, spamDays: null })).status).toBe(400);
    expect(await put({ trashDays: 30, spamDays: 14 })).toMatchObject({
      status: 200,
      body: { retention: { trashDays: 30, spamDays: 14 } },
    });

    await seed(mailboxStub(env, mailbox.id), ["api_trash"], "trash");
    expect(await call(`${base}/folders/trash/empty`, { method: "POST" })).toMatchObject({
      status: 200,
      body: { deleted: 1, remaining: 0 },
    });
    expect((await call(`${base}/folders/inbox/empty`, { method: "POST" })).status).toBe(400);
    expect((await call("/api/mail/mailboxes/mbx_missing/folders/trash/empty", { method: "POST" })).status)
      .toBe(403);
  });
});
