import { expect, test } from "playwright/test";

test("Settings → MCP shows how to connect a client, and points to Connected apps", async ({
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
  await page.goto("/settings/mcp");

  const endpoint = new URL("/mcp", page.url()).toString();
  await expect(page.getByLabel("Server URL")).toHaveValue(endpoint);
  await expect(
    page.getByRole("button", { name: "Copy server URL" })
  ).toBeVisible();

  // Each client gets its own snippet and, where it needs one, a sign-in step.
  const clients = page.getByRole("tablist", { name: "MCP clients" });
  await expect(
    clients.getByRole("tab", { name: "Claude Code" })
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText(`claude mcp add --transport http openworkspace ${endpoint}`)
  ).toBeVisible();
  await expect(
    page.getByText("Then run /mcp in Claude Code and choose Authenticate.")
  ).toBeVisible();
  await clients.getByRole("tab", { name: "Codex" }).click();
  await expect(page.getByText("[mcp_servers.openworkspace]")).toBeVisible();
  await expect(
    page.getByText("Then run codex mcp login openworkspace.")
  ).toBeVisible();

  // Approved apps are no longer listed here.
  await expect(page.getByRole("button", { name: /Disconnect/u })).toHaveCount(
    0
  );
  await page
    .getByText("Clients you approve are listed under")
    .getByRole("link", { name: "Connected apps" })
    .click();
  await expect(page).toHaveURL(/\/settings\/connected-apps$/u);
});
