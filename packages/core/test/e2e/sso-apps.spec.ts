import { expect, test } from "playwright/test";
import type { Page } from "playwright/test";
import { z } from "zod";

async function openAdminApps(page: Page) {
  await page.goto("/");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/mock/login") && response.ok()
    ),
    page.getByRole("button", { name: "Open seeded local demo" }).click(),
  ]);
  await page.goto("/admin/sso-applications");
  await expect(
    page.getByRole("heading", { name: "Single sign-on apps" })
  ).toBeVisible();
}

test("adds an OpenID Connect app and shows what to give it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The wizard is covered once");
  await openAdminApps(page);
  await page.getByRole("button", { name: "Add an app" }).click();
  await expect(page.getByRole("heading", { name: "Add an app" })).toBeVisible();

  const add = page.getByRole("button", { name: "Add app", exact: true });
  await expect(
    page.getByText("To continue: Choose how the app signs people in")
  ).toBeVisible();
  await page.getByRole("radio", { name: /OpenID Connect/u }).check();
  await page.getByLabel("Name", { exact: true }).fill("Grafana");
  await expect(
    page.getByText(/Also called the redirect URI, callback URL/u)
  ).toBeVisible();
  await page
    .getByLabel("Redirect URL", { exact: true })
    .fill("https://grafana.example.com/login/generic_oauth");

  // Nobody may sign in until a team is picked.
  await expect(page.getByText("Nobody can sign in yet")).toBeVisible();
  await expect(add).toBeDisabled();
  await page.getByRole("checkbox", { name: /Customer care/u }).click();
  await expect(page.getByText("Nobody can sign in yet")).toHaveCount(0);
  await add.click();

  const details = page.getByRole("region", { name: "Give these to the app" });
  await expect(details.getByText(/^owsec_/u)).toBeVisible();
  await expect(details.getByText(/Shown once/u)).toBeVisible();
  await expect(
    details.getByText(/\/\.well-known\/openid-configuration$/u)
  ).toBeVisible();
  await expect(details.getByText(/\/oauth\/token$/u)).toBeVisible();
  await expect(
    details.getByText(/Also called the issuer URL, authority/u)
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Test sign-in" })
  ).toHaveAttribute("href", "https://grafana.example.com");
  await page.getByRole("button", { name: "Open app settings" }).click();

  await expect(page.getByRole("heading", { name: "Grafana" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Give these to the app" })
  ).toBeVisible();
  await page.getByRole("tab", { name: "Access" }).click();
  await expect(
    page.getByRole("button", { name: "Save changes" })
  ).toBeDisabled();
  await expect(page.getByText("To save: make a change first.")).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /Customer care/u })
  ).toBeChecked();
  const sendTeams = page.getByRole("checkbox", { name: /^groups/u });
  await expect(sendTeams).not.toBeChecked();
  await expect(
    page.getByRole("textbox", { name: /sent to the app as/u })
  ).toHaveCount(0);
  await sendTeams.click();
  // With the groups scope, each team can carry a value; only teams with one are sent.
  await page.getByRole("checkbox", { name: /^Everyone/u }).click();
  await expect(
    page.getByText("A team without a value is not sent.")
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Customer care: sent to the app as" })
    .fill("Editor");
  await page
    .getByRole("textbox", { name: "Everyone: sent to the app as" })
    .fill("Viewer");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved")).toBeVisible();

  await page.getByRole("button", { name: "Back to list" }).click();
  const row = page.getByRole("button", { name: /Grafana/u }).first();
  await expect(row).toContainText("OIDC");
});

test("adds a SAML app from pasted metadata and reopens it from its link", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The wizard is covered once");
  await openAdminApps(page);
  await page.getByRole("button", { name: "Add an app" }).click();
  await page.getByRole("radio", { name: /^SAML/u }).check();
  await page.getByLabel("Name", { exact: true }).fill("Metadata wiki");
  await page.getByRole("checkbox", { name: /^Everyone/u }).click();
  await expect(
    page.getByText("Paste the app's metadata URL or upload its XML")
  ).toBeVisible();
  await page.getByLabel("Metadata XML file").setInputFiles({
    name: "metadata.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:example:wiki">` +
        `<md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
        `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://wiki.example.test/saml/acs" index="0"/>` +
        `</md:SPSSODescriptor></md:EntityDescriptor>`
    ),
  });
  await expect(page.getByLabel("App's entity ID")).toHaveValue(
    "urn:example:wiki"
  );
  await expect(page.getByLabel("App's ACS URL")).toHaveValue(
    "https://wiki.example.test/saml/acs"
  );
  await page.getByRole("button", { name: "Add app", exact: true }).click();
  await expect(page.getByText("Metadata wiki added")).toBeVisible();
  const details = page.getByRole("region", { name: "Give these to the app" });
  await expect(details.getByText(/\/saml\/sso$/u)).toBeVisible();
  await expect(details.getByText(/BEGIN CERTIFICATE/u)).toBeVisible();
  await expect(
    details.getByRole("link", { name: "Download .pem" })
  ).toHaveAttribute("href", /idp-certificate\?format=pem$/u);
  await expect(
    details.getByRole("link", { name: "Download .cer" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Test sign-in" })
  ).toHaveAttribute("href", /\/saml\/launch\//u);
  await page.getByRole("button", { name: "Open app settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Metadata wiki" })
  ).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1);

  await page.getByRole("tab", { name: "Advanced" }).click();
  await page.getByRole("button", { name: "Use Microsoft-style names" }).click();
  await expect(page.getByLabel("Email address")).toHaveValue(
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
  );

  await page.goto(`/admin/sso-applications/${id}`);
  await expect(
    page.getByRole("heading", { name: "Metadata wiki" })
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Provisioning" })).toBeVisible();
});

test("serves direct SAML login links through the SPA", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Direct route is covered once"
  );
  const response = await page.goto("/saml/login/missing-request");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Sign-in request expired" })
  ).toBeVisible();
});

test("an app manager cannot let an app skip consent or reach mail", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await openAdminApps(page);

  const created = await page.evaluate(async () => {
    const response = await fetch("/api/admin/oidc-clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Delegated wiki",
        clientType: "public",
        accessTeams: [{ teamId: "team_everyone", sentAs: null }],
        redirectUris: ["https://wiki.example.com/callback"],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        allowedScopes: ["openid", "profile"],
        trusted: false,
        enabled: true,
      }),
    });

    await fetch("/api/admin/users/usr_demo_member", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: ["manage_apps"] }),
    });

    return response.json();
  });

  const { clientId } = z.object({ clientId: z.string() }).parse(created);

  const signIn = (userId: string) =>
    page.evaluate(
      async (id) =>
        (
          await fetch("/api/auth/mock/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: id }),
          })
        ).status,
      userId
    );

  try {
    expect(await signIn("usr_demo_member")).toBe(200);
    await page.goto(`/admin/sso-applications/${clientId}`);
    await expect(
      page.getByRole("heading", { name: "Delegated wiki" })
    ).toBeVisible();
    await page.getByRole("tab", { name: "Access" }).click();
    await expect(
      page.getByRole("checkbox", { name: /^people\.read/u })
    ).toBeDisabled();
    await expect(
      page.getByText(/Only administrators can allow it/u)
    ).toBeVisible();
    await page.getByRole("tab", { name: "Advanced" }).click();
    await expect(
      page.getByRole("switch", { name: /Skip the consent screen/u })
    ).toBeDisabled();
    await expect(
      page.getByText(/Only administrators can turn this on/u)
    ).toBeVisible();
  } finally {
    expect(await signIn("usr_demo_admin")).toBe(200);
    await page.evaluate(async () => {
      await fetch("/api/admin/users/usr_demo_member", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: [] }),
      });
    });
  }
});
