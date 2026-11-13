import { expect, test } from "playwright/test";
import type { Page } from "playwright/test";
import { z } from "zod";

const callback = "http://127.0.0.1:33418/callback";

/** What /oauth/register answers with, of what these tests use. */
const registrationResponse = z.object({ client_id: z.string() });

async function signIn(page: Page) {
  await page.goto("/");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/mock/login") && response.ok()
    ),
    page.getByRole("button", { name: "Open seeded local demo" }).click(),
  ]);
}

/** Registers an MCP client as one would, and opens its authorization for `scope`. */
async function authorize(page: Page, scope: string) {
  const { client_id: clientId } = registrationResponse.parse(
    await page.evaluate(async (redirectUri) => {
      const response = await fetch("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: [redirectUri],
        }),
      });

      return response.json();
    }, callback)
  );

  const url = new URL("/oauth/authorize", page.url());

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    scope,
  })) {
    url.searchParams.set(key, value);
  }

  await page.goto(url.toString());
  await expect(page).toHaveURL(/\/oidc\/consent\//u);
}

test("the consent screen lists each scope by area", async ({ page }) => {
  await signIn(page);
  await authorize(page, "people.read admin.teams offline_access");
  await expect(
    page.getByRole("heading", { name: "Allow Claude to use your account?" })
  ).toBeVisible();
  await expect(page.getByText("Returns you to")).toBeVisible();
  await expect(page.getByText("127.0.0.1:33418")).toBeVisible();
  const permissions = page.getByLabel("Requested permissions");
  await expect(
    permissions.getByRole("region", { name: "People" })
  ).toContainText("people.read");
  await expect(
    permissions.getByRole("region", { name: "Administration" })
  ).toContainText("admin.teams");
  await expect(
    permissions.getByRole("region", { name: "Your profile" })
  ).toContainText("offline_access");
  await expect(
    page.getByRole("note", { name: "Account takeover risk" })
  ).toHaveCount(0);

  // Approving sends the person back to the app with a code.
  await page.route(`${callback}**`, (route) =>
    route.fulfill({ body: "Connected" })
  );
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:33418\/callback\?code=/u);
});

test("the consent screen warns plainly about admin.access", async ({
  page,
}) => {
  await signIn(page);
  await authorize(page, "people.read admin.people admin.access");
  const warning = page.getByRole("note", { name: "Account takeover risk" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Full control over people's access");
  await expect(warning).toContainText("take over their accounts");
  // It is not listed among the ordinary administration scopes.
  await expect(
    page
      .getByLabel("Requested permissions")
      .getByRole("region", { name: "Administration" })
  ).not.toContainText("admin.access");

  await page.route(`${callback}**`, (route) =>
    route.fulfill({ body: "Denied" })
  );
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page).toHaveURL(/error=access_denied/u);
});

test("administrators see connected apps and can cut them off", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await signIn(page);
  await authorize(page, "people.read offline_access");
  await page.route(`${callback}**`, (route) =>
    route.fulfill({ body: "Connected" })
  );
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(/callback\?code=/u);

  await page.goto("/admin/connected-apps");
  await expect(
    page.getByRole("heading", { name: "Connected apps" })
  ).toBeVisible();
  const app = page.getByRole("region", { name: "Claude" }).first();
  await expect(app.getByText("127.0.0.1:33418")).toBeVisible();
  const people = app.getByRole("list", { name: "People who connected Claude" });
  await expect(people).toContainText("Sam Brooks");
  await expect(people.getByText("people.read")).toBeVisible();

  await app.getByRole("button", { name: "Disconnect" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(app.getByText("Nobody is connected.")).toBeVisible();

  await app.getByRole("button", { name: "Turn off for everyone" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Turn off" })
    .click();
  await expect(app.getByText("Turned off")).toBeVisible();
  await app.getByRole("button", { name: "Turn on" }).click();
  await expect(app.getByText("Turned off")).toHaveCount(0);

  const registration = page.getByRole("switch", {
    name: /Allow apps to register themselves/u,
  });

  await expect(registration).toBeChecked();
  await registration.click();
  await expect(registration).not.toBeChecked();

  const refused = await page.evaluate(
    async () =>
      (
        await fetch("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Late",
            redirect_uris: ["http://127.0.0.1:33418/callback"],
          }),
        })
      ).status
  );

  expect(refused).toBe(403);
  await registration.click();
  await expect(registration).toBeChecked();
});
