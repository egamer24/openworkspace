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

/** Connects an app the way an MCP client does: it registers itself, and the person approves `scope`. */
async function connect(page: Page, name: string, scope: string) {
  const { client_id: clientId } = registrationResponse.parse(
    await page.evaluate(
      async ({ clientName, redirectUri }) => {
        const response = await fetch("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: clientName,
            redirect_uris: [redirectUri],
          }),
        });

        return response.json();
      },
      { clientName: name, redirectUri: callback }
    )
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
  await page.route(`${callback}**`, (route) =>
    route.fulfill({ body: "Connected" })
  );
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(/callback\?code=/u);
}

test("Settings → Connected apps lists the apps you approved and disconnects them", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const name = `Test editor ${testInfo.project.name}`;
  await connect(page, name, "people.read admin.teams offline_access");

  await page.goto("/settings/connected-apps");
  await expect(
    page.getByRole("heading", { name: "Connected apps" })
  ).toBeVisible();

  const app = page
    .getByRole("list", { name: "Connected apps" })
    .getByRole("listitem", { name, exact: true });

  await expect(app).toContainText("127.0.0.1:33418");
  await expect(app).toContainText("Connected");
  await expect(app).toContainText("Not used yet");

  // What it may do, in plain words and by area.
  const granted = app.getByLabel(`What ${name} may do`);
  await expect(granted.getByRole("term")).toHaveText([
    "People",
    "Administration",
    "Your profile",
  ]);
  await expect(granted).toContainText(
    "See the people, teams and mailboxes in the workspace"
  );
  await expect(granted).toContainText("Stay connected while you are away");

  // Administrators are pointed to the workspace-wide list.
  await expect(
    page.getByRole("link", { name: "Administration → Connected apps" })
  ).toBeVisible();

  await app.getByRole("button", { name: `Disconnect ${name}` }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(
    `${name} loses access to your account at once.`
  );
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText(`${name} disconnected`)).toBeVisible();
  await expect(page.getByRole("listitem", { name, exact: true })).toHaveCount(
    0
  );

  // With every app disconnected, the page says how one gets here.
  const { apps } = z
    .object({ apps: z.array(z.object({ clientId: z.string() })) })
    .parse(
      await page.evaluate(async () =>
        (await fetch("/api/auth/connected-apps")).json()
      )
    );

  await page.evaluate(
    (clientIds) =>
      Promise.all(
        clientIds.map((clientId) =>
          fetch(`/api/auth/connected-apps/${encodeURIComponent(clientId)}`, {
            method: "DELETE",
          })
        )
      ).then(() => undefined),
    apps.map((connected) => connected.clientId)
  );
  await page.reload();
  await expect(page.getByText("No apps connected")).toBeVisible();
  await page.getByRole("link", { name: "Connect an AI agent" }).click();
  await expect(page).toHaveURL(/\/settings\/mcp$/u);
});
