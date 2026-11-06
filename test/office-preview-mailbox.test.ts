import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { expect, it, vi } from "vitest";
import migrations from "../drizzle/mailbox/migrations.js";
import { inboundMessageId } from "../worker/mail/inbound";
import { mailboxStub } from "../worker/mailbox";
import type { NewEmail } from "../worker/mailbox/schema";

function emailFixture(): NewEmail {
  return {
    id: "msg_atomic_preview", conversationId: "conv_atomic_preview", direction: "incoming",
    fromJson: [{ address: "sender@example.test", name: null }],
    subject: "Office", timelineAt: new Date(), transportState: "received",
    attachmentsJson: [{
      id: "att_preview", r2Key: "test/atomic/office", filename: "report.docx", size: 5,
      contentType: "application/octet-stream", contentId: null, disposition: "attachment",
      delivery: "attached", downloadTokenHash: null, downloadExpiresAt: null,
    }],
  };
}

it("upgrades an existing mailbox once without rewriting its emails", async () => {
  const mailbox = mailboxStub(env, `mbx_preview_migration_${crypto.randomUUID()}`);
  await runInDurableObject(mailbox, async (instance, state) => {
    await state.storage.deleteAll();
    const db = drizzle(state.storage);
    await migrate(db, {
      ...migrations,
      journal: { entries: migrations.journal.entries.filter((entry) => entry.idx < 5) },
    });
    // Raw SQL: the current schema has columns later migrations add.
    state.storage.sql.exec(`insert into emails
      (id, conversation_id, direction, from_json, subject, timeline_at, transport_state)
      values ('msg_atomic_preview', 'conv_atomic_preview', 'incoming',
        '[{"address":"sender@example.test","name":null}]', 'Office', 1, 'received')`);
    const [before] = state.storage.sql.exec("select * from emails").toArray();
    await migrate(db, migrations);
    await migrate(db, migrations);
    expect(state.storage.sql.exec("select * from emails").toArray()).toMatchObject([before!]);
    expect(instance.getEmail("msg_atomic_preview")).toMatchObject({ subject: "Office", attachmentsJson: [] });
    expect(state.storage.sql.exec("select * from pending_office_previews").toArray()).toEqual([]);
    expect(state.storage.sql.exec("select * from __drizzle_migrations").toArray())
      .toHaveLength(migrations.journal.entries.length);
  });
});

it("rolls back email and conversation inserts if their preview task cannot be stored", async () => {
  const mailbox = mailboxStub(env, `mbx_preview_atomic_${crypto.randomUUID()}`);
  await runInDurableObject(mailbox, async (instance, state) => {
    // A SQLite failure inside the new raw-SQL insert must share Drizzle's transaction.
    state.storage.sql.exec(`create trigger fail_preview_insert before insert on pending_office_previews
      begin select raise(abort, 'preview write failed'); end`);
    try {
      await expect(instance.insertEmail(emailFixture())).rejects.toThrow("preview write failed");
      for (const table of ["emails", "conversations", "email_search", "pending_office_previews"]) {
        expect(state.storage.sql.exec(`select * from ${table}`).toArray()).toEqual([]);
      }
    } finally {
      state.storage.sql.exec("drop trigger fail_preview_insert");
    }
    await instance.insertEmail(emailFixture());
    expect(state.storage.sql.exec("select * from pending_office_previews").toArray()).toHaveLength(1);
  });
});

it("delivers inbound mail during a preview queue outage and retries the outbox without duplicating mail", async () => {
  const mailboxId = `mbx_preview_outage_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(env, mailboxId);
  const id = `delivery_${crypto.randomUUID()}`;
  const rawObjectKey = `test/${id}/raw.eml`;
  const input = {
    id, mailboxId, rawObjectKey, envelopeFrom: "sender@example.test",
    envelopeTo: "me@example.test", receivedAt: Date.now(),
  };
  await env.MAIL_STORAGE.put(rawObjectKey, [
    "From: sender@example.test", "To: me@example.test", "Subject: Queue outage",
    'Content-Type: multipart/mixed; boundary="preview-test"', "",
    "--preview-test", "Content-Type: text/plain", "", "Still delivered",
    "--preview-test", 'Content-Type: application/octet-stream; name="report.xlsx"',
    'Content-Disposition: attachment; filename="report.xlsx"',
    "Content-Transfer-Encoding: base64", "", "Ynl0ZXM=", "--preview-test--", "",
  ].join("\r\n"));
  await mailbox.enqueueInbound(input);
  await runInDurableObject(mailbox, async (instance, state) => {
    // Inject the queue outage on this mailbox's binding; RPC callers have a separate wrapper.
    const bindings = Reflect.get(instance, "bindings") as Env;
    const send = vi.spyOn(bindings.OFFICE_PREVIEWS, "sendBatch")
      .mockRejectedValue(new Error("Queue unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(send).toHaveBeenCalledOnce();
      expect(state.storage.sql.exec("select * from pending_inbound").toArray()).toEqual([]);
      expect(state.storage.sql.exec("select attempts from pending_office_previews").toArray())
        .toEqual([{ attempts: 1 }]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    } finally {
      send.mockRestore();
      errorLog.mockRestore();
    }
  });
  const email = await mailbox.getEmail(inboundMessageId(id));
  expect(email).toMatchObject({ transportState: "received", bodyText: "Still delivered" });
  expect(email?.attachmentsJson[0]?.pdfPreviewStatus).toBe("pending");
  expect(await mailbox.enqueueInbound(input)).toMatchObject({ queued: false });
  await runInDurableObject(mailbox, (_, state) => {
    state.storage.sql.exec("update pending_office_previews set next_attempt_at = 0");
  });
  await runDurableObjectAlarm(mailbox);
  await runInDurableObject(mailbox, (_, state) => {
    expect(state.storage.sql.exec("select * from pending_office_previews").toArray()).toEqual([]);
    expect(state.storage.sql.exec("select * from emails").toArray()).toHaveLength(1);
  });
});
