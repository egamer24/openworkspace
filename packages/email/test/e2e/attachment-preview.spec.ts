import { required } from "@open-workspace/core/shared";
import { expect, test } from "playwright/test";
import type { Locator } from "playwright/test";
import { z } from "zod";

/** A conversation as the API returns it: the messages' ids, every other field kept. */
const conversationBodySchema = z.looseObject({
  messages: z.array(z.looseObject({ id: z.string() })),
});

const translateRequestSchema = z.object({
  language: z.string(),
  segments: z.array(z.string()),
});

/** Older, already-read messages start collapsed to a one-line summary. */
async function expandMessage(message: Locator) {
  await expect(message).toBeVisible();
  const toggle = message.getByRole("button", { name: /^Show message from/u });

  if (await toggle.isVisible()) await toggle.click();
}

test("previews, searches and translates PDF pages without downloading", async ({
  page,
  browser,
}, testInfo) => {
  const pdfPage = await browser.newPage();
  await pdfPage.setContent(
    '<h1>Attachment preview</h1><p>First page text</p><h1 style="break-before:page">Second page</h1><p>Second page text</p><div style="break-before:page;width:100px;height:100px;background:blue"></div>'
  );
  const pdf = await pdfPage.pdf();
  await pdfPage.close();

  const files = [
    {
      id: "preview_pdf",
      filename: "report.pdf",
      contentType: "application/pdf",
      body: pdf,
    },
    {
      id: "preview_text",
      filename: "notes.txt",
      contentType: "text/plain; charset=utf-8",
      body: Buffer.from(
        "Preview text <script>parent.document.body.dataset.unsafe = 'yes'</script>"
      ),
    },
    {
      id: "preview_image",
      filename: "pixel.png",
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
        "base64"
      ),
    },
    {
      id: "preview_office",
      filename: "report.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: Buffer.from("Office document"),
    },
    {
      id: "preview_broken",
      filename: "broken.pdf",
      contentType: "application/pdf",
      body: Buffer.from("not a PDF"),
    },
  ];

  const attachments = files.map((file) => ({
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    size: file.body.length,
    contentId: null,
    disposition: "attachment",
  }));

  let downloadCount = 0;
  let previewRequests = 0;
  const translations: { language: string; segments: string[] }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.route("**/api/mail/conversations/*", async (route) => {
    const response = await route.fetch();

    const body = conversationBodySchema.parse(await response.json());

    // Neighbouring conversations are prefetched through here too.
    const message = body.messages.find((item) => item.id === "msg_demo_01");

    if (message) message.attachments = attachments;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/mail/messages/*/attachments/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    const file = required(
      files.find((item) => pathname.includes(`/${item.id}`)),
      `a test file for ${pathname}`
    );

    const preview = pathname.endsWith("/preview");

    if (preview) previewRequests += 1;
    await route.fulfill({
      contentType: file.contentType,
      headers: {
        "content-disposition": `${preview ? "inline" : "attachment"}; filename="${file.filename}"`,
        "x-content-type-options": "nosniff",
      },
      body: file.body,
    });
  });
  await page.route("**/api/mail/messages/*/translate?*", async (route) => {
    const request = translateRequestSchema.parse(
      route.request().postDataJSON()
    );

    translations.push(request);
    await route.fulfill({
      json: {
        ok: true,
        translations: request.segments.map(
          (segment) => `${request.language}: ${segment}`
        ),
      },
    });
  });
  await page
    .getByRole("button", { name: "Open The craft behind fast software" })
    .click();
  await expandMessage(page.locator('[data-message-id="msg_demo_01"]'));
  expect(previewRequests).toBe(0);
  const dialog = page.getByRole("dialog");

  await page.getByRole("button", { name: "Preview notes.txt" }).click();
  await expect(dialog).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="Preview of notes.txt"]').locator("body")
  ).toContainText("Preview text <script>");
  expect(await page.locator("body").getAttribute("data-unsafe")).toBeNull();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Preview pixel.png" }).click();
  const image = dialog.getByRole("img", { name: "pixel.png" });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth)
    )
    .toBe(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Preview report.pdf" }).click();
  await expect(
    dialog.getByRole("heading", { name: "report.pdf" })
  ).toBeVisible();
  await expect(
    dialog.locator('.page[data-page-number="1"] canvas')
  ).toBeVisible();
  await expect(
    dialog.locator('.page[data-page-number="1"] .textLayer')
  ).toContainText("Attachment preview");
  await expect.poll(() => previewRequests).toBe(3);
  expect(translations).toHaveLength(0);
  const zoom = dialog.getByLabel("Zoom level");

  const originalZoom = required(
    await zoom.textContent(),
    "the zoom level's text"
  );

  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(zoom).not.toHaveText(originalZoom);
  await dialog.getByRole("button", { name: "Fit width" }).click();
  await expect(zoom).toHaveText(originalZoom);
  await dialog
    .getByRole("searchbox", { name: "Find in PDF" })
    .fill("Second page text");
  await expect(dialog.getByRole("search").getByRole("status")).toHaveText(
    "1 / 1"
  );
  await expect(
    dialog.getByRole("textbox", { name: "Page number" })
  ).toHaveValue("2");
  await expect(
    dialog.locator(".textLayer .highlight.selected").first()
  ).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Find in PDF" }).fill("");
  await dialog
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: /^PDF translation language/u })
    .click();
  await page.getByRole("menuitemradio", { name: "Russian" }).click();
  await dialog.getByRole("button", { name: "Translate", exact: true }).click();

  const translation = dialog.getByRole("region", {
    name: "PDF translation",
    exact: true,
  });

  await expect(translation).toContainText("ru: Attachment preview");
  expect(translations).toHaveLength(1);
  await dialog.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(translation).toContainText("ru: Second page");
  expect(translations).toHaveLength(2);
  await dialog
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await expect(translation).toContainText("ru: Attachment preview");
  expect(translations).toHaveLength(2);
  await dialog
    .getByRole("button", { name: /^PDF translation language/u })
    .click();
  await page.getByRole("menuitemradio", { name: "German" }).click();
  await expect(translation).toContainText("de: Attachment preview");
  expect(translations).toHaveLength(3);
  await dialog.screenshot({ path: testInfo.outputPath("pdf-translation.png") });
  const pageNumber = dialog.getByRole("textbox", { name: "Page number" });
  await pageNumber.fill("3");
  await pageNumber.press("Enter");
  await expect(dialog.getByRole("status")).toContainText(
    "No selectable text on this page"
  );
  expect(translations).toHaveLength(3);
  await dialog.getByRole("button", { name: "Show original" }).click();
  await expect(translation).toHaveCount(0);
  const bounds = await dialog.boundingBox();
  expect(required(bounds, "the dialog's bounds").width).toBeLessThanOrEqual(
    required(page.viewportSize(), "the viewport size").width
  );
  expect(downloadCount).toBe(0);
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("report.pdf");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview report.pdf" })
  ).toBeFocused();
  await page.getByRole("button", { name: "Preview report.pdf" }).click();
  await expect(
    dialog.locator('.page[data-page-number="1"] canvas')
  ).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Page number" })
  ).toHaveValue("1");
  await expect(
    dialog.getByRole("region", { name: "PDF translation", exact: true })
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Preview broken.pdf" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Could not open this PDF"
  );
  await expect(
    dialog.getByRole("link", { name: "Download", exact: true })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const officeDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: /report.docx/u }).click();
  expect((await officeDownload).suggestedFilename()).toBe("report.docx");
  expect(errors).toEqual([]);
});
