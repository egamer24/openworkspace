import { expect, test } from "playwright/test";

// Core alone: no module provides a home, so a signed-in person gets core's.
test("signed-in home leads to settings and administration without modules", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Hello, Sam Brooks" })
  ).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/u);
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true })
  ).toBeVisible();
  await page.goto("/settings/sessions");
  await expect(
    page.getByRole("heading", { name: "Sessions", exact: true })
  ).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Administration" }).click();
  await expect(page).toHaveURL(/\/admin\/people$/u);
  await expect(
    page.getByRole("heading", { name: "People", exact: true })
  ).toBeVisible();
  await expect(page.getByText("sam@demo.example")).toBeVisible();

  // A module's route is not there: it falls back to the home.
  await page.goto("/mail");
  await expect(
    page.getByRole("heading", { name: "Hello, Sam Brooks" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" })
  ).toBeVisible();
});

test("a member's home has no administration", async ({ page }) => {
  await page.goto("/");

  const login = await page.request.post("/api/auth/mock/login", {
    data: { userId: "usr_demo_member" },
  });

  expect(login.ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Hello, Maya Chen" })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(
    0
  );
});
