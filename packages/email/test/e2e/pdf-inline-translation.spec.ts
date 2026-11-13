import { readFile } from "node:fs/promises";

import { required } from "@open-workspace/core/shared";
import { expect, test } from "playwright/test";
import type { Locator } from "playwright/test";
import { z } from "zod";

/** Older, already-read messages start collapsed to a one-line summary. */
async function expandMessage(message: Locator) {
  await expect(message).toBeVisible();
  const toggle = message.getByRole("button", { name: /^Show message from/u });

  if (await toggle.isVisible()) await toggle.click();
}

test("translates PDF table text in place and restores the original on failure", async ({
  page,
  browser,
}, testInfo) => {
  const fixturePage = await browser.newPage();
  await fixturePage.setContent(`
    <style>body{font:16px Arial}td,th{border:1px solid black;padding:10px}table{border-collapse:collapse}</style>
    <h1>Statement</h1><table><tr><th>Account</th><th>Balance</th></tr><tr><td>123-456</td><td>500.00</td></tr></table>
    <p style="color:red">Pending payment</p><div style="width:80px;height:30px;background:blue"></div>`);

  // Optional private fixtures stay outside the repository and are never uploaded.
  const pdf = process.env.PDF_PREVIEW_TEST_FILE
    ? await readFile(process.env.PDF_PREVIEW_TEST_FILE)
    : await fixturePage.pdf();

  await fixturePage.close();

  const dictionary: Record<string, string> = process.env
    .PDF_PREVIEW_TRANSLATIONS
    ? JSON.parse(await readFile(process.env.PDF_PREVIEW_TRANSLATIONS, "utf-8"))
    : {
        Statement: "Банковская выписка",
        Account: "Номер\nбанковского счёта",
        Balance: "Остаток средств",
        "Pending payment": "Платёж в ожидании",
      };

  let fail = false;
  let requests = 0;
  let source: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.route("**/api/mail/conversations/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();

    // Neighbouring conversations are prefetched through here too.
    const message = body.messages.find(
      (item: { id: string }) => item.id === "msg_demo_01"
    );

    if (message) {
      message.attachments = [
        {
          id: "table_pdf",
          filename: "table.pdf",
          contentType: "application/pdf",
          size: pdf.length,
          contentId: null,
          disposition: "attachment",
        },
      ];
    }

    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/mail/messages/*/attachments/*/preview?*", (route) =>
    route.fulfill({ contentType: "application/pdf", body: pdf })
  );
  await page.route("**/api/mail/messages/*/translate?*", async (route) => {
    requests += 1;

    const request = z
      .object({ segments: z.array(z.string()) })
      .parse(route.request().postDataJSON());

    source = request.segments;
    await route.fulfill(
      fail
        ? { status: 503, json: { error: "Translation unavailable" } }
        : {
            json: {
              ok: true,
              translations: source.map((text) => dictionary[text] ?? text),
            },
          }
    );
  });
  await page
    .getByRole("button", { name: "Open The craft behind fast software" })
    .click();
  await expandMessage(page.locator('[data-message-id="msg_demo_01"]'));
  await page.getByRole("button", { name: "Preview table.pdf" }).click();
  const dialog = page.getByRole("dialog");

  const original = dialog.locator(
    '.page[data-page-number="1"] > .canvasWrapper'
  );

  const overlay = dialog.getByRole("region", {
    name: "PDF translation",
    exact: true,
  });

  await expect(original).toBeVisible();
  await dialog
    .getByRole("button", { name: /^PDF translation language/u })
    .click();
  await page.getByRole("menuitemradio", { name: "Russian" }).click();
  await dialog.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(overlay).toBeVisible();
  await expect(original).toBeHidden();
  expect(source.every((text) => /\p{L}/u.test(text))).toBe(true);

  if (!process.env.PDF_PREVIEW_TEST_FILE) {
    await expect(overlay).toContainText("Номер банковского счёта");
    await expect(overlay).toContainText("500.00");
  }

  // The background must retain graphics, while long translations fit their cells.
  expect(
    await overlay.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
      // Runs in the page: no helpers from the test's modules here.
      const context = canvas.getContext("2d");

      if (!context) throw new Error("The overlay canvas has no 2D context");
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

      let ink = 0;

      for (let i = 0; i < data.length; i += 4) {
        if (Math.min(data[i], data[i + 1], data[i + 2]) < 200) ink += 1;
      }

      return ink;
    })
  ).toBeGreaterThan(100);
  expect(
    await overlay
      .locator("span")
      .evaluateAll((spans) =>
        spans.every((span) => span.scrollWidth <= span.clientWidth + 1)
      )
  ).toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("inline-translation.png"),
  });

  const geometry = await overlay.evaluate((element) => {
    const layer = element.querySelector(".pdf-translated-text");

    if (!layer) throw new Error("The overlay has no translated text layer");
    const bounds = element.getBoundingClientRect();
    const textBounds = layer.getBoundingClientRect();

    return {
      width: bounds.width,
      height: bounds.height,
      textWidth: textBounds.width,
      textHeight: textBounds.height,
    };
  });

  expect(Math.abs(geometry.width - geometry.textWidth)).toBeLessThan(1);
  expect(Math.abs(geometry.height - geometry.textHeight)).toBeLessThan(1);

  const before = required(
    await overlay.boundingBox(),
    "the overlay's bounds before zooming"
  );

  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect
    .poll(async () => (await overlay.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before.width);
  await dialog.getByRole("button", { name: "Fit width" }).click();
  await expect
    .poll(async () => Math.round((await overlay.boundingBox())?.width ?? 0))
    .toBe(Math.round(before.width));
  expect(requests).toBe(1);
  await dialog.getByRole("button", { name: "Show original" }).click();
  await expect(overlay).toHaveCount(0);
  await expect(original).toBeVisible();
  await dialog.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(overlay).toBeVisible();
  expect(requests).toBe(1);

  if (
    await dialog
      .getByRole("button", { name: "Next page", exact: true })
      .isEnabled()
  ) {
    await dialog
      .getByRole("button", { name: "Next page", exact: true })
      .click();
    await expect(
      dialog.locator('.page[data-page-number="2"] .pdf-translation-overlay')
    ).toBeVisible();
    await dialog.screenshot({
      path: testInfo.outputPath("inline-translation-page-2.png"),
    });
    await dialog
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
    await expect(
      dialog.locator('.page[data-page-number="1"] .pdf-translation-overlay')
    ).toBeVisible();
  }

  fail = true;
  await dialog
    .getByRole("button", { name: /^PDF translation language/u })
    .click();
  await page.getByRole("menuitemradio", { name: "German" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(overlay).toHaveCount(0);
  await expect(original).toBeVisible();
  fail = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(overlay).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Find in PDF" }).fill(source[0]);
  await expect(overlay).toHaveCount(0);
  await expect(original).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Translate", exact: true })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(errors).toEqual([]);
});
