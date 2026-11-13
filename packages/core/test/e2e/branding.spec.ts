import { expect, test } from "playwright/test";
import { z } from "zod";

// A 4x4 PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGMwjbkCRwzEcQA6ghZRqGlkLwAAAABJRU5ErkJggg==",
  "base64"
);

test("an administrator's logo shows on the sign-in screen", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await page.goto("/");
  await expect(page.getByRole("img", { name: "Workspace logo" })).toHaveCount(
    0
  );
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("link", { name: "Branding" }).click();
  await expect(page).toHaveURL(/\/admin\/branding$/u);
  await expect(page.getByText("No logo yet")).toBeVisible();

  await page
    .getByLabel("Logo image")
    .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("Logo updated")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Replace logo" })
  ).toBeVisible();

  // The Worker, not the static app, answers for the manifest and the favicon.
  const manifest = z
    .object({ icons: z.array(z.object({ src: z.string() })) })
    .parse(await (await page.request.get("/manifest.webmanifest")).json());

  expect(manifest.icons[0]?.src).toMatch(
    /^\/api\/workspace-logo\/[0-9a-f]{32}\?size=192$/u
  );
  const favicon = await page.request.get("/api/workspace-logo/icon/64");
  expect(favicon.ok()).toBe(true);
  expect(favicon.url()).toMatch(
    /\/api\/workspace-logo\/[0-9a-f]{32}\?size=64$/u
  );

  // Someone signed out sees it above the sign-in heading.
  const visitor = await browser.newContext();
  const signIn = await visitor.newPage();
  await signIn.goto(new URL("/", page.url()).toString());
  await expect(
    signIn.getByRole("heading", { name: "Sign in to your workspace" })
  ).toBeVisible();
  const logo = signIn.getByRole("img", { name: "Workspace logo" });
  await expect(logo).toBeVisible();
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(4);

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Logo removed")).toBeVisible();
  await signIn.reload();
  await expect(
    signIn.getByRole("heading", { name: "Sign in to your workspace" })
  ).toBeVisible();
  await expect(signIn.getByRole("img", { name: "Workspace logo" })).toHaveCount(
    0
  );
  await visitor.close();
});

test("the workspace name replaces the product's in the header and the tab", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.goto("/admin/branding");
  const name = page.getByLabel("Workspace name");
  await expect(name).toHaveValue("");
  await expect(
    page.getByRole("complementary").getByText("OpenWorkspace", { exact: true })
  ).toBeVisible();

  await name.fill("Northwind Studio");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Name saved")).toBeVisible();
  await expect(
    page
      .getByRole("complementary")
      .getByText("Northwind Studio", { exact: true })
  ).toBeVisible();
  await expect(page).toHaveTitle("Northwind Studio");

  await name.fill("");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Name removed")).toBeVisible();
  await expect(page).toHaveTitle("OpenWorkspace");
});

test("the branding section opens on phones", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile navigation assertion");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.goto("/admin/branding");
  await expect(page.getByRole("heading", { name: "Branding" })).toBeVisible();
  await expect(page.getByLabel("Workspace name")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload logo" })).toBeVisible();
});

test("the service worker gives notifications the workspace icon and keeps the default badge", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Service worker assertion");
  await page.goto("/");
  // The worker installs and takes the page without a reload.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;

        return registration.active?.scriptURL ?? null;
      })
    )
    .toMatch(/\/sw\.js$/u);

  const script = await (await page.request.get("/sw.js")).text();
  expect(script).toContain(
    'const NOTIFICATION_ICON = "/api/workspace-logo/icon/192"'
  );
  expect(script).toContain(
    'const NOTIFICATION_BADGE = "/icons/app-icon-192.png"'
  );
  // Without a logo the stable icon URL lands on the OpenWorkspace icon.
  const icon = await page.request.get("/api/workspace-logo/icon/192");
  expect(icon.ok()).toBe(true);
  expect(icon.url()).toMatch(/\/icons\/app-icon-192\.png$/u);
  expect(icon.headers()["content-type"]).toBe("image/png");
});
