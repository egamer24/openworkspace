import { expect, test } from "playwright/test";
import { z } from "zod";

test("a mail webhook names its mailboxes and says when one stops", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Webhook administration is covered once"
  );
  await page.goto("/");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/mock/login") && response.ok()
    ),
    page.getByRole("button", { name: "Open seeded local demo" }).click(),
  ]);

  // A team address of its own, to remove later.
  const { mailboxId } = z.object({ mailboxId: z.string() }).parse(
    await page.evaluate(async () => {
      const created = await fetch("/api/admin/mailboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: "hooks@demo.example",
          displayName: "Hooks",
          ownerUserId: null,
          teamId: "team_demo_support",
        }),
      });

      return created.json();
    })
  );

  await page.goto("/admin/webhooks");
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Help desk");
  await page
    .getByLabel("Endpoint URL", { exact: true })
    .fill("https://desk.example.com/hooks");
  const events = page.getByRole("group", { name: "Events" });
  await events.getByRole("checkbox").first().uncheck();
  await events.getByText("Email received").click();
  const mailboxes = page.getByRole("group", { name: "Mailboxes" });
  await expect(mailboxes).toContainText("only while you can open them");
  const create = page.getByRole("button", { name: "Create webhook" });
  await expect(create).toBeDisabled();
  await mailboxes.getByText("hooks@demo.example").click();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("heading", { name: "Copy the signing secret" })
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // The mailbox goes away: its mail can no longer be delivered, and both views say so.
  expect(
    await page.evaluate(
      async (id) =>
        (await fetch(`/api/admin/mailboxes/${id}`, { method: "DELETE" }))
          .status,
      mailboxId
    )
  ).toBe(200);
  await page.goto("/admin/webhooks");
  const row = page.getByRole("button", { name: /Help desk/u });
  await expect(row.getByText("Partly unavailable")).toBeVisible();
  await expect(row).toContainText(
    "Mail from 1 of 1 mailboxes is not delivered"
  );
  await row.click();
  await expect(
    page.getByText("A mailbox it covered was deleted; remove it here.")
  ).toBeVisible();
});
