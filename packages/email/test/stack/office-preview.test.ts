import { expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import {
  MAX_OFFICE_PREVIEW_BYTES,
  officePreviewKey,
} from "@open-workspace/email/shared/office-preview.ts";
import type { OfficePreviewJob } from "@open-workspace/email/shared/office-preview.ts";
import { inboundMessageId } from "@open-workspace/email/worker/mail/inbound.ts";

import { emailQueueRoles } from "../../shared/module.ts";
import { runAlarmUntil } from "./mailbox-helpers.ts";
import {
  env,
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
} from "./workspace.ts";

useFreshWorkspace();

/*
 * The mailboxes here record their Office preview jobs (`testFake`) instead
 * of queueing them: the tests hand jobs to the queue handler themselves,
 * and the live consumer must not convert them in the background. Conversions use a stand-in converter; the real
 * container is exercised by test/e2e/office-preview.spec.ts.
 */

async function insertOffice(filename = "report.xlsx", size = 5) {
  const mailboxId = `mbx_preview_${crypto.randomUUID()}`;
  const sourceKey = `test/${mailboxId}/attachment`;
  const mailbox = mailboxStub(mailboxId);
  await mailbox.testFake({ officePreviews: "capture" });
  await env.MAIL_STORAGE.put(sourceKey, "bytes");
  await mailbox.insertEmail({
    id: "msg_preview",
    conversationId: "conv_preview",
    direction: "incoming",
    fromJson: [{ address: "sender@example.test", name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: "Office",
    timelineAt: new Date(),
    transportState: "received",
    attachmentsJson: [
      {
        id: "att_preview",
        r2Key: sourceKey,
        filename,
        size,
        contentType: "application/octet-stream",
        contentId: null,
        disposition: "attachment",
        delivery: "attached",
        downloadTokenHash: null,
        downloadExpiresAt: null,
      },
    ],
  });

  const job: OfficePreviewJob = {
    mailboxId,
    messageId: "msg_preview",
    attachmentId: "att_preview",
    sourceKey,
  };

  return { mailboxId, mailbox, job };
}

/** One job through the Worker's queue handler, as one delivery attempt. */
async function consume(job: OfficePreviewJob, attempts = 1) {
  const { outcomes, error } = await hooks.queue(
    emailQueueRoles.officePreviews,
    [{ body: job, attempts }]
  );

  expect(error).toBeUndefined();

  const [outcome] = outcomes;

  return required(outcome, "the queue handler answers for the job");
}

it("persists preview work with the email, reuses PDFs on redelivery, and deletes both objects", async () => {
  const { mailboxId, mailbox, job } = await insertOffice();
  expect(
    (await mailbox.getAttachment(job.messageId, job.attachmentId))
      ?.pdfPreviewStatus
  ).toBe("pending");
  expect(
    await mailbox.testSql("select * from pending_office_previews")
  ).toHaveLength(1);
  expect(await mailbox.testAlarm()).not.toBeNull();
  await runAlarmUntil(
    mailboxId,
    async () =>
      (await mailbox.testSql("select * from pending_office_previews"))
        .length === 0
  );
  expect(
    (await mailbox.testCalls()).filter(
      (call) => call.kind === "OFFICE_PREVIEWS.sendBatch"
    )
  ).toEqual([{ kind: "OFFICE_PREVIEWS.sendBatch", data: [job] }]);
  // The PDF exists, so the converter reuses it without starting a container.
  await env.MAIL_STORAGE.put(
    officePreviewKey(job.sourceKey),
    "%PDF-1.7\nready"
  );
  expect(await consume(job)).toMatchObject({ ack: true, retry: false });
  expect(
    (await mailbox.getAttachment(job.messageId, job.attachmentId))
      ?.pdfPreviewStatus
  ).toBe("ready");
  expect(await consume(job)).toMatchObject({ ack: true, retry: false });
  await mailbox.bulkUpdateConversations(["conv_preview"], "inbox", {
    mailboxState: "trash",
  });
  await mailbox.permanentlyDeleteConversations(["conv_preview"]);
  await runAlarmUntil(
    mailboxId,
    async () =>
      !(await env.MAIL_STORAGE.head(job.sourceKey)) &&
      !(await env.MAIL_STORAGE.head(officePreviewKey(job.sourceKey)))
  );
  expect(await env.MAIL_STORAGE.head(job.sourceKey)).toBeNull();
  expect(
    await env.MAIL_STORAGE.head(officePreviewKey(job.sourceKey))
  ).toBeNull();
  expect(
    await mailbox.completeOfficePreview(
      job.messageId,
      job.attachmentId,
      job.sourceKey,
      "ready"
    )
  ).toBe(false);
  expect(await consume(job)).toMatchObject({ ack: true });
});

it("retries temporary converter failures and eventually leaves the original downloadable", async () => {
  const { mailbox, job } = await insertOffice("slides.pptx");

  // A converter that cannot start: the infrastructure error path.
  type Outcome = { ack: boolean; retry?: { delaySeconds?: number } };

  const [first] = await hooks.call<Outcome[]>(
    "mailbox.consumeOfficePreviewsWithoutContainer",
    [{ body: job, attempts: 1 }]
  );

  const firstOutcome = required(first, "the first attempt has an outcome");
  expect(firstOutcome.retry).toEqual({ delaySeconds: 30 });
  expect(firstOutcome.ack).toBe(false);

  const [last] = await hooks.call<Outcome[]>(
    "mailbox.consumeOfficePreviewsWithoutContainer",
    [{ body: job, attempts: 3 }]
  );

  expect(required(last, "the last attempt has an outcome").ack).toBe(true);
  expect(
    (await mailbox.getAttachment(job.messageId, job.attachmentId))
      ?.pdfPreviewStatus
  ).toBe("failed");
  expect(await (await env.MAIL_STORAGE.get(job.sourceKey))?.text()).toBe(
    "bytes"
  );
});

it("cleans up a late PDF on redelivery after the email and its original cleanup are gone", async () => {
  const { mailboxId, mailbox, job } = await insertOffice();
  await mailbox.bulkUpdateConversations(["conv_preview"], "inbox", {
    mailboxState: "trash",
  });
  await mailbox.permanentlyDeleteConversations(["conv_preview"]);
  await runAlarmUntil(
    mailboxId,
    async () => !(await env.MAIL_STORAGE.head(job.sourceKey))
  );
  // Conversion finished after deletion, then the consumer lost its cleanup attempt.
  await env.MAIL_STORAGE.put(officePreviewKey(job.sourceKey), "%PDF-1.7\nlate");
  // R2 deletes fail inside this mailbox, before the redelivery schedules its cleanup.
  await mailbox.testFake({
    officePreviews: "capture",
    mailStorage: { delete: "fail" },
  });
  expect(await consume(job, 2)).toMatchObject({ ack: true });
  expect(await hooks.runAlarm(mailboxId)).toBe(true);
  expect(
    (await mailbox.testCalls()).filter(
      (call) => call.kind === "MAIL_STORAGE.delete"
    )
  ).toHaveLength(1);
  expect(
    await mailbox.testSql(
      "select object_key, attempts from pending_object_deletions"
    )
  ).toEqual([{ object_key: officePreviewKey(job.sourceKey), attempts: 1 }]);
  expect(await mailbox.testAlarm()).not.toBeNull();
  await mailbox.testFake({ officePreviews: "capture" });
  await mailbox.testSql(
    "update pending_object_deletions set next_attempt_at = 0"
  );
  await runAlarmUntil(
    mailboxId,
    async () => !(await env.MAIL_STORAGE.head(officePreviewKey(job.sourceKey)))
  );
  expect(
    await env.MAIL_STORAGE.head(officePreviewKey(job.sourceKey))
  ).toBeNull();
});

it("does not reset preview, delivery, conversation or read state on duplicate insertion and completion", async () => {
  const { mailboxId, mailbox, job } = await insertOffice();
  const original = await mailbox.getEmail(job.messageId);

  if (!original) throw new Error("Missing fixture email");
  await mailbox.setMessageRead("usr_preview", job.messageId, true);
  await runAlarmUntil(
    mailboxId,
    async () =>
      (await mailbox.testSql("select * from pending_office_previews"))
        .length === 0
  );

  const before = await mailbox.getConversationPageSnapshot(
    "conv_preview",
    "usr_preview",
    10,
    null
  );

  await mailbox.completeOfficePreview(
    job.messageId,
    job.attachmentId,
    job.sourceKey,
    "ready"
  );
  await mailbox.insertEmail(original);
  await mailbox.completeOfficePreview(
    job.messageId,
    job.attachmentId,
    job.sourceKey,
    "failed"
  );

  const after = await mailbox.getConversationPageSnapshot(
    "conv_preview",
    "usr_preview",
    10,
    null
  );

  const snapshot = required(before, "the conversation exists before");

  expect(after).toEqual({
    ...snapshot,
    messages: snapshot.messages.map((email) => ({
      ...email,
      attachmentsJson: email.attachmentsJson.map((file) => ({
        ...file,
        pdfPreviewStatus: "ready",
      })),
    })),
  });
  expect(
    await mailbox.testSql("select * from pending_office_previews")
  ).toHaveLength(0);
});

it("does not queue oversized Office attachments", async () => {
  const { mailbox, job } = await insertOffice(
    "large.docx",
    MAX_OFFICE_PREVIEW_BYTES + 1
  );

  expect(
    (await mailbox.getAttachment(job.messageId, job.attachmentId))
      ?.pdfPreviewStatus
  ).toBe("failed");
  expect(
    await mailbox.testSql("select * from pending_office_previews")
  ).toHaveLength(0);
});

it("queues previews when an incoming MIME attachment is processed", async () => {
  const mailboxId = `mbx_incoming_preview_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(mailboxId);
  await mailbox.testFake({ officePreviews: "capture" });
  const id = `delivery_${crypto.randomUUID()}`;
  const rawObjectKey = `test/${id}/raw.eml`;
  await env.MAIL_STORAGE.put(
    rawObjectKey,
    [
      "From: sender@example.test",
      "To: me@example.test",
      "Subject: Incoming Office",
      'Content-Type: multipart/mixed; boundary="preview-test"',
      "",
      "--preview-test",
      "Content-Type: text/plain",
      "",
      "An Office attachment",
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
  await mailbox.enqueueInbound({
    id,
    mailboxId,
    rawObjectKey,
    envelopeFrom: "sender@example.test",
    envelopeTo: "me@example.test",
    receivedAt: Date.now(),
  });

  const email = await runAlarmUntil(mailboxId, () =>
    mailbox.getEmail(inboundMessageId(id))
  );

  expect(email?.attachmentsJson[0]).toMatchObject({
    filename: "report.xlsx",
    pdfPreviewStatus: "pending",
  });
});

it("uploads Office bytes, persists PDF output, and rejects invalid conversion responses", async () => {
  const key = `test/convert/${crypto.randomUUID()}`;
  await env.MAIL_STORAGE.put(key, "Office bytes");

  type Conversion = {
    result?: string;
    error?: string;
    upload?: {
      pathname: string;
      isFile: boolean;
      name?: string;
      text?: string;
    };
  };

  const converted = await hooks.call<Conversion>(
    "mailbox.convertOfficeDocument",
    key,
    "ok"
  );

  expect(converted.upload).toEqual({
    pathname: "/forms/libreoffice/convert",
    isFile: true,
    name: "document.xlsx",
    text: "Office bytes",
  });
  expect(converted.result).toBe("ready");

  const pdf = required(
    await env.MAIL_STORAGE.get(officePreviewKey(key)),
    "the converted PDF is stored"
  );

  expect(new TextDecoder().decode(await pdf.arrayBuffer())).toBe(
    "%PDF-1.7\nconverted"
  );
  expect(
    (await hooks.call<Conversion>("mailbox.convertOfficeDocument", key, "503"))
      .error
  ).toContain("503");
  expect(
    (
      await hooks.call<Conversion>(
        "mailbox.convertOfficeDocument",
        key,
        "not-pdf"
      )
    ).error
  ).toContain("did not return a PDF");
  expect(
    (await hooks.call<Conversion>("mailbox.convertOfficeDocument", key, "400"))
      .result
  ).toBe("failed");
});
