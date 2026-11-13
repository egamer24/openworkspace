import { expect, test } from "playwright/test";

test("Settings → Mail apps explains how to connect a JMAP app", async ({
  page,
}) => {
  await page.goto("/");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/mock/login") && response.ok()
    ),
    page.getByRole("button", { name: "Open seeded local demo" }).click(),
  ]);
  await page.goto("/settings/mail-apps");

  const sessionUrl = page.getByLabel("JMAP session URL");
  await expect(sessionUrl).toHaveValue(
    new URL("/.well-known/jmap", page.url()).toString()
  );
  await expect(sessionUrl).toHaveJSProperty("readOnly", true);
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();

  // What an app may be given, by the mail scopes' own words.
  const scopes = page.getByRole("list", { name: "What an app may be given" });
  await expect(scopes.getByRole("listitem")).toHaveCount(3);
  await expect(scopes).toContainText("Send mail as you");

  // Each mailbox the demo administrator can open is an account in the app.
  const accounts = page.getByRole("list", { name: "Accounts a mail app sees" });
  await expect(accounts.getByRole("listitem").first()).toBeVisible();
  await expect(accounts).toContainText("@demo.example");

  await expect(
    page.getByText("Apple Mail, Outlook and Gmail can't connect")
  ).toBeVisible();

  // Every approved app, mail apps included, is listed in one place.
  await page.getByRole("link", { name: "Manage connected apps" }).click();
  await expect(page).toHaveURL(/\/settings\/connected-apps$/u);
  await expect(page.getByText("Apps you approved")).toBeVisible();
});
