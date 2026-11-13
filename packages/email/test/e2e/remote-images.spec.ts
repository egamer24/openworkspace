import { expect, test } from "playwright/test";
import { z } from "zod";

/** A conversation as the API returns it: the messages' ids, every other field kept. */
const conversationBodySchema = z.looseObject({
  messages: z.array(
    z.looseObject({ id: z.string(), bodyHtml: z.string().nullish() })
  ),
});

// A sent message is shown in the app's own document, where only the proxy
// stands between an image and the sender's server: an srcset candidate that
// can't be proxied must not load.
test("a sent message's srcset never loads straight from the sender's server", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Covered once");
  const direct: string[] = [];

  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "tracker.invalid") {
      direct.push(request.url());
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.route("**/api/mail/conversations/*", async (route) => {
    const response = await route.fetch();

    const body = conversationBodySchema.parse(await response.json());

    const sent = body.messages.find((item) => item.id === "msg_demo_07");

    if (sent) {
      sent.bodyHtml =
        '<p>Plan attached</p><img alt="Plan" srcset="//tracker.invalid/p.png 2x, /tracker.png 1x">';
    }

    await route.fulfill({ response, json: body });
  });
  await page
    .getByRole("button", { name: "Open The craft behind fast software" })
    .click();

  const sent = page.locator('[data-message-id="msg_demo_07"]');

  await expect(sent.getByText("Plan attached")).toBeVisible();
  await expect(sent.locator('img[srcset*="tracker"]')).toHaveCount(0);
  expect(direct).toEqual([]);
});
