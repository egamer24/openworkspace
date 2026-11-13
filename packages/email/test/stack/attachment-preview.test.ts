import { expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin } from "./mail-flow-helpers.ts";
import {
  env,
  mailbox as mailboxStub,
  useFreshWorkspace,
  worker,
} from "./workspace.ts";

useFreshWorkspace();

const mailboxList = z.object({
  mailboxes: z.array(z.object({ id: z.string() })),
});

it("previews attachments inline with access checks, ranges, and inert text", async () => {
  const cookie = await bootstrapAdmin();

  const mailboxes = await worker.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie },
    })
  );

  const {
    mailboxes: [mailbox],
  } = await readJson(mailboxes, mailboxList);

  const mailboxId = required(mailbox, "the admin has a mailbox").id;

  const fixtures = [
    {
      id: "pdf",
      filename: "report.pdf",
      contentType: "application/octet-stream",
      body: "%PDF-1.7\npreview",
    },
    {
      id: "image",
      filename: "pixel.png",
      contentType: "image/png",
      body: "image bytes",
    },
    {
      id: "text",
      filename: "data.xml",
      contentType: "application/xml",
      body: '<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script>',
    },
    {
      id: "html",
      filename: "unsafe.pdf",
      contentType: "text/html",
      body: "<script>alert(1)</script>",
    },
    {
      id: "svg",
      filename: "unsafe.svg",
      contentType: "image/svg+xml",
      body: "<svg onload='alert(1)'/>",
    },
    {
      id: "office",
      filename: "report.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: "office bytes",
    },
  ];

  const attachments = fixtures.map((file) => ({
    ...file,
    r2Key: `preview/${file.id}`,
    size: new TextEncoder().encode(file.body).length,
    contentId: null,
    disposition: "attachment" as const,
    delivery: "attached" as const,
    downloadTokenHash: null,
    downloadExpiresAt: null,
  }));

  await Promise.all(
    attachments.map((file) => env.MAIL_STORAGE.put(file.r2Key, file.body))
  );

  // The test completes the Office preview itself; keep the job from the live converter.
  await mailboxStub(mailboxId).testFake({ officePreviews: "capture" });
  await mailboxStub(mailboxId).insertEmail({
    id: "msg_preview",
    conversationId: "conv_preview",
    direction: "incoming",
    fromJson: [{ address: "sender@example.net", name: null }],
    toJson: [{ address: "admin@example.test", name: null }],
    subject: "Previews",
    timelineAt: new Date(),
    transportState: "received",
    attachmentsJson: attachments,
  });

  const url = (id: string, selectedMailbox = mailboxId) =>
    `http://example.test/api/mail/messages/msg_preview/attachments/${id}/preview?mailboxId=${selectedMailbox}`;

  const anonymous = await worker.fetch(url("pdf"));
  expect(anonymous.status).toBe(401);
  await anonymous.json();

  const forbidden = await worker.fetch(
    new Request(url("pdf", "mbx_other"), { headers: { cookie } })
  );

  expect(forbidden.status).toBe(403);
  await forbidden.json();

  await Promise.all(
    [
      { id: "pdf", contentType: "application/pdf" },
      { id: "image", contentType: "image/png" },
      { id: "text", contentType: "text/plain; charset=utf-8" },
    ].map(async ({ id, contentType }) => {
      const response = await worker.fetch(
        new Request(url(id), { headers: { cookie } })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("inline;");
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
        required(
          fixtures.find((file) => file.id === id),
          `a fixture ${id}`
        ).body
      );
    })
  );

  const partial = await worker.fetch(
    new Request(url("pdf"), {
      headers: { cookie, range: "bytes=0-7" },
    })
  );

  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe("bytes 0-7/16");
  expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe(
    "%PDF-1.7"
  );

  await Promise.all(
    ["html", "svg"].map(async (id) => {
      const response = await worker.fetch(
        new Request(url(id), { headers: { cookie } })
      );

      expect(response.status).toBe(422);
      await response.json();
    })
  );

  const pending = await worker.fetch(
    new Request(url("office"), { headers: { cookie } })
  );

  expect(pending.status).toBe(409);
  await pending.json();
  await env.MAIL_STORAGE.put(
    "preview/office.preview.pdf",
    "%PDF-1.7\nconverted"
  );
  await mailboxStub(mailboxId).completeOfficePreview(
    "msg_preview",
    "office",
    "preview/office",
    "ready"
  );

  const converted = await worker.fetch(
    new Request(url("office"), { headers: { cookie } })
  );

  expect(converted.status).toBe(200);
  expect(converted.headers.get("content-type")).toBe("application/pdf");
  expect(converted.headers.get("content-disposition")).toContain(
    "report.docx.pdf"
  );
  expect(new TextDecoder().decode(await converted.arrayBuffer())).toBe(
    "%PDF-1.7\nconverted"
  );

  const original = await worker.fetch(
    new Request(url("office").replace("/preview?", "?"), {
      headers: { cookie },
    })
  );

  expect(original.headers.get("content-disposition")).toContain("attachment;");
  expect(new TextDecoder().decode(await original.arrayBuffer())).toBe(
    "office bytes"
  );
  await env.MAIL_STORAGE.delete("preview/pdf");

  const missing = await worker.fetch(
    new Request(url("pdf"), { headers: { cookie } })
  );

  expect(missing.status).toBe(404);
  await missing.json();
});
