import { expect, test } from "playwright/test";
import { z } from "zod";

const invitationSchema = z.object({
  accessLink: z.object({ url: z.string() }),
});

// Real passkey ceremonies, against Chromium's virtual authenticator: an
// invited person registers a passkey, then signs in with it.
test("an invited person registers a passkey and signs in with it", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "The virtual authenticator is Chromium's, set up once"
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page.getByRole("heading", { name: /^Hello,/u })).toBeVisible();

  const local = `pat.${Date.now().toString(36)}`;

  const invited = await page.request.post("/api/admin/invitations", {
    data: { name: "Pat Lee", email: `${local}@demo.example` },
  });

  expect(invited.status()).toBe(201);
  const { accessLink } = invitationSchema.parse(await invited.json());

  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });

  const guest = await context.newPage();
  const cdp = await context.newCDPSession(guest);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await guest.goto(new URL(accessLink.url).pathname);
  await guest.getByRole("button", { name: "Register passkey" }).click();
  await expect(
    guest.getByRole("heading", { name: "Hello, Pat Lee" })
  ).toBeVisible();

  await context.clearCookies();
  await guest.goto("/");
  await guest.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(
    guest.getByRole("heading", { name: "Hello, Pat Lee" })
  ).toBeVisible();

  await context.close();
});
