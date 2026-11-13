import { expect, test } from "playwright/test";

import { required } from "../../shared/invariant.ts";

// A 4x4 PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGMwjbkCRwzEcQA6ghZRqGlkLwAAAABJRU5ErkJggg==",
  "base64"
);

test("a profile photo is served by the workspace, resized, and removed", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop settings assertion");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.goto("/settings/profile");
  await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled();

  await page
    .getByLabel("Profile photo image")
    .setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("Photo updated")).toBeVisible();

  // Once uploaded, the preview gives way to the Worker's 256px WebP.
  const photo = page.getByRole("img", { name: "Profile photo" });
  await expect(photo).toHaveAttribute(
    "src",
    /^\/api\/avatars\/usr_demo_admin\/[0-9a-f]{32}\?size=256$/u
  );
  await expect
    .poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(256);

  const src = required(
    await photo.getAttribute("src"),
    "the profile photo has a src"
  );

  const served = await page.request.get(src);
  expect(served.headers()["content-type"]).toBe("image/webp");
  expect(served.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable"
  );

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Photo removed")).toBeVisible();
  await expect(photo).toHaveCount(0);
  expect((await page.request.get(src)).status()).toBe(404);
});
