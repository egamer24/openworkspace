import { expect, test } from "playwright/test";
import type { Page } from "playwright/test";

async function openDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
}

async function openConversation(page: Page, subject: string) {
  await page.getByRole("button", { name: `Open ${subject}` }).click();
  await expect(
    page.getByRole("article").getByRole("heading", { name: subject })
  ).toBeVisible();
}

test("unsubscribes from a newsletter with RFC 8058 one-click", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Unsubscribe is covered once");
  await openDemo(page);
  await openConversation(page, "Issue 341 — tools for thought");
  const message = page.locator('[data-message-id="msg_demo_05"]');
  await message
    .getByRole("button", { name: "Unsubscribe", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByText("Unsubscribe from Margin Notes?")
  ).toBeVisible();
  await expect(dialog).toContainText("weekly.margin-notes.example");
  await dialog.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(
    page.getByText("Unsubscribed from Margin Notes", { exact: true })
  ).toBeVisible();
  await expect(message.getByTestId("unsubscribed-label")).toHaveText(
    /^Unsubscribed on /u
  );
  await expect(
    message.getByRole("button", { name: "Unsubscribe", exact: true })
  ).toHaveCount(0);
});

test("reports spam from a suspicious message", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Spam reports are covered once"
  );
  await openDemo(page);
  await openConversation(page, "Updated bank details for invoice INV-2207");
  const message = page.locator('[data-message-id="msg_demo_19"]');
  await expect(message.getByTestId("sender-security-banner")).toContainText(
    "Replies go to northwind.accounts@quickmail.example"
  );

  await message.getByRole("button", { name: "Reply to this message" }).click();
  await expect(page.getByTestId("reply-to-warning")).toContainText(
    "northwind.accounts@quickmail.example"
  );
  await page.getByRole("button", { name: "Discard reply" }).click();

  await message.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: /phishing/iu })).toHaveCount(
    0
  );
  await page.getByRole("menuitem", { name: "Report spam" }).click();
  await expect(
    page.getByText("Reported as spam", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open Updated bank details for invoice INV-2207",
    })
  ).toHaveCount(0);
});

test("blocks and unblocks a domain for the whole workspace", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Workspace blocks are covered once"
  );
  await openDemo(page);
  await page.goto("/admin/blocked-senders");
  await page
    .getByRole("textbox", { name: "Address or domain to block for everyone" })
    .fill("blocked-in-e2e.example");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(
    page.getByText("@blocked-in-e2e.example is blocked for everyone")
  ).toBeVisible();

  const blocks = page.getByRole("list", {
    name: "Senders blocked for everyone",
  });

  await expect(
    blocks.getByRole("listitem").filter({ hasText: "@blocked-in-e2e.example" })
  ).toContainText("Whole domain");
  await blocks
    .getByRole("button", { name: "Unblock @blocked-in-e2e.example" })
    .click();
  await expect(
    page.getByText("@blocked-in-e2e.example unblocked")
  ).toBeVisible();
  await expect(blocks.getByText("@blocked-in-e2e.example")).toHaveCount(0);
});

test("offers no filter rules in the message menu or the folder manager", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Menus are covered once");
  await openDemo(page);
  await openConversation(page, "Your October receipt");
  const message = page.locator('[data-message-id="msg_demo_18"]');
  await message.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Report spam" })
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /filter/iu })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: "Manage folders and AI sorting" })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Folders & AI sorting" });
  await expect(dialog.getByRole("tab")).toHaveText([
    "Folders",
    "Blocked",
    "AI sorting",
  ]);
});
