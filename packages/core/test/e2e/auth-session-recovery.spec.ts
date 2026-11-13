import { expect, test } from "playwright/test";

import { required } from "../../shared/invariant.ts";

for (const failure of ["server", "network"] as const) {
  test(`keeps a session recoverable after an initial ${failure} error`, async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open seeded local demo" }).click();
    await expect(
      page.getByRole("heading", { name: "Hello, Sam Brooks" })
    ).toBeVisible();

    const cookie = required(
      (await context.cookies()).find((item) => item.name === "op_session_dev"),
      "the demo sign-in sets the session cookie"
    );

    let failing = true;
    let attempts = 0;
    await page.route(/\/api\/bootstrap(?:\?|$)/u, async (route) => {
      if (!failing) return route.continue();
      attempts += 1;

      if (failure === "network") return route.abort("failed");
      await route.fulfill({
        status: 503,
        json: { ok: false, error: { message: "Temporarily unavailable" } },
      });
    });
    await page.goto("/settings/sessions");
    await expect(
      page.getByRole("heading", { name: "Could not check session" })
    ).toBeVisible();
    expect(attempts).toBeGreaterThanOrEqual(2);
    await expect(
      page.getByRole("button", { name: "Continue with passkey" })
    ).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/sessions$/u);
    expect(
      (await context.cookies()).find((item) => item.name === "op_session_dev")
        ?.value
    ).toBe(cookie.value);

    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sessions", exact: true })
    ).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/sessions$/u);
    expect(
      (await context.cookies()).find((item) => item.name === "op_session_dev")
        ?.value
    ).toBe(cookie.value);

    // A confirmed missing session must still lead to sign-in, unlike a failed check.
    await context.clearCookies({ name: "op_session_dev" });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Continue with passkey" })
    ).toBeVisible();
  });
}
