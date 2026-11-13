import { readFile } from "node:fs/promises";

import { required } from "@open-workspace/core/shared";
import { expect, test } from "playwright/test";
import { z } from "zod";

const uploadSchema = z.object({
  upload: z.object({
    id: z.string(),
    uploadUrl: z.string(),
    headers: z.record(z.string(), z.string()),
  }),
});

const sentSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
});

test("converts Word, Excel, and PowerPoint attachments and keeps originals", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Real container conversion is covered once"
  );
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);

  const mailboxId = required(
    new URL(page.url()).pathname.split("/")[2],
    "the mailbox in the URL"
  );

  const files = [
    [
      "document.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "workbook.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    [
      "slides.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  ];

  // Independent uploads, sent together; Promise.all keeps the files' order (att_1, att_2, att_3).
  const upload = async ([filename, contentType]: string[]) => {
    const bytes = await readFile(
      new URL(`fixtures/office/${filename}`, import.meta.url)
    );

    const created = await page.request.post(
      `/api/mail/uploads?mailboxId=${mailboxId}`,
      {
        data: { filename, contentType, size: bytes.length },
      }
    );

    expect(created.status()).toBe(201);

    const { upload: target } = uploadSchema.parse(await created.json());

    expect(
      (
        await page.request.put(target.uploadUrl, {
          headers: target.headers,
          data: bytes,
        })
      ).ok()
    ).toBe(true);
    expect(
      (
        await page.request.post(
          `/api/mail/uploads/${target.id}/complete?mailboxId=${mailboxId}`
        )
      ).ok()
    ).toBe(true);

    return { uploadId: target.id, disposition: "attachment" };
  };

  const attachments = await Promise.all(files.map(upload));

  const sent = await page.request.post("/api/mail/messages", {
    data: {
      mailboxId,
      requestId: crypto.randomUUID(),
      to: ["preview@example.test"],
      subject: "Office preview verification",
      bodyText: "Word, Excel, PowerPoint",
      attachments,
    },
  });

  expect(sent.status()).toBe(201);

  const { conversationId, messageId } = sentSchema.parse(await sent.json());

  await page.goto(`/mail/${mailboxId}/sent/${conversationId}`);
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  const checkPreview = async (filename: string, index: number) => {
    await page.getByRole("button", { name: `Preview ${filename}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.locator('.page[data-page-number="1"] canvas')
    ).toBeVisible({ timeout: 120_000 });
    const base = `/api/mail/messages/${messageId}/attachments/att_${index + 1}`;

    const pdf = await page.request.get(
      `${base}/preview?mailboxId=${mailboxId}`
    );

    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
    const original = await page.request.get(`${base}?mailboxId=${mailboxId}`);
    expect(await original.body()).toEqual(
      await readFile(new URL(`fixtures/office/${filename}`, import.meta.url))
    );
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  };

  for (const [index, [filename = ""]] of files.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one preview dialog at a time: each is opened, checked and closed in turn
    await checkPreview(filename, index);
  }

  expect(downloaded).toBe(false);
});
