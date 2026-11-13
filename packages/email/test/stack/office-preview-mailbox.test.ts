import { expect, it } from "bun:test";

import { inboundMessageId } from "@open-workspace/email/worker/mail/inbound.ts";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";

import {
  env,
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
} from "./workspace.ts";

useFreshWorkspace();

function emailFixture(): NewEmail {
  return {
    id: "msg_atomic_preview",
    conversationId: "conv_atomic_preview",
    direction: "incoming",
    fromJson: [{ address: "sender@example.test", name: null }],
    subject: "Office",
    timelineAt: new Date(),
    transportState: "received",
    attachmentsJson: [
      {
        id: "att_preview",
        r2Key: "test/atomic/office",
        filename: "report.docx",
        size: 5,
        contentType: "application/octet-stream",
        contentId: null,
        disposition: "attachment",
        delivery: "attached",
        downloadTokenHash: null,
        downloadExpiresAt: null,
      },
    ],
  };
}

it("rolls back email and conversation inserts if their preview task cannot be stored", async () => {
  const mailboxId = `mbx_preview_atomic_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(mailboxId);
  // Preview jobs stay in this mailbox rather than reaching the live converter.
  await mailbox.testFake({ officePreviews: "capture" });
  // A SQLite failure inside the new raw-SQL insert must share Drizzle's transaction.
  await mailbox.testSql(`create trigger fail_preview_insert before insert on pending_office_previews
    begin select raise(abort, 'preview write failed'); end`);

  try {
    await expect(mailbox.insertEmail(emailFixture())).rejects.toThrow(
      "preview write failed"
    );

    // Nothing of the email was written, in any of its tables.
    expect(
      await Promise.all(
        [
          "emails",
          "conversations",
          "email_search",
          "pending_office_previews",
        ].map((table) => mailbox.testSql(`select * from ${table}`))
      )
    ).toEqual([[], [], [], []]);
  } finally {
    await mailbox.testSql("drop trigger fail_preview_insert");
  }

  await mailbox.insertEmail(emailFixture());
  expect(
    await mailbox.testSql("select * from pending_office_previews")
  ).toHaveLength(1);
});

it("delivers inbound mail during a preview queue outage and retries the outbox without duplicating mail", async () => {
  const mailboxId = `mbx_preview_outage_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(mailboxId);
  const id = `delivery_${crypto.randomUUID()}`;
  const rawObjectKey = `test/${id}/raw.eml`;

  const input = {
    id,
    mailboxId,
    rawObjectKey,
    envelopeFrom: "sender@example.test",
    envelopeTo: "me@example.test",
    receivedAt: Date.now(),
  };

  await env.MAIL_STORAGE.put(
    rawObjectKey,
    [
      "From: sender@example.test",
      "To: me@example.test",
      "Subject: Queue outage",
      'Content-Type: multipart/mixed; boundary="preview-test"',
      "",
      "--preview-test",
      "Content-Type: text/plain",
      "",
      "Still delivered",
      "--preview-test",
      'Content-Type: application/octet-stream; name="report.xlsx"',
      'Content-Disposition: attachment; filename="report.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      "Ynl0ZXM=",
      "--preview-test--",
      "",
    ].join("\r\n")
  );
  // The preview queue is down for this mailbox, before its alarm can fire.
  await mailbox.testFake({ officePreviews: "fail" });
  await mailbox.enqueueInbound(input);
  expect(await hooks.runAlarm(mailboxId)).toBe(true);
  expect(
    (await mailbox.testCalls()).filter(
      (call) => call.kind === "OFFICE_PREVIEWS.sendBatch"
    )
  ).toHaveLength(1);
  expect(await mailbox.testSql("select * from pending_inbound")).toEqual([]);
  expect(
    await mailbox.testSql("select attempts from pending_office_previews")
  ).toEqual([{ attempts: 1 }]);
  expect(await mailbox.testAlarm()).not.toBeNull();
  // The queue is back; jobs are recorded rather than converted.
  await mailbox.testFake({ officePreviews: "capture" });

  const email = await mailbox.getEmail(inboundMessageId(id));
  expect(email).toMatchObject({
    transportState: "received",
    bodyText: "Still delivered",
  });
  expect(email?.attachmentsJson[0]?.pdfPreviewStatus).toBe("pending");
  expect(await mailbox.enqueueInbound(input)).toMatchObject({ queued: false });
  await mailbox.testSql(
    "update pending_office_previews set next_attempt_at = 0"
  );
  await hooks.runAlarm(mailboxId);
  expect(
    await mailbox.testSql("select * from pending_office_previews")
  ).toEqual([]);
  expect(await mailbox.testSql("select * from emails")).toHaveLength(1);
  expect(
    (await mailbox.testCalls()).filter(
      (call) => call.kind === "OFFICE_PREVIEWS.sendBatch"
    )
  ).toHaveLength(2);
});
