import { expect, test } from "playwright/test";
import { z } from "zod";

import { required } from "../../shared/invariant.ts";

test("admin can edit an existing user and create recovery", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("link", { name: "Administration" }).click();
  await expect(page).toHaveURL(/\/admin\/people$/u);
  await expect(
    page.getByRole("button", { name: "Invite person" })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Invite person" })).toHaveCount(
    0
  );
  await expect(page.getByRole("link", { name: "Mailboxes" })).toHaveCount(0);
  await page.getByRole("link", { name: "Teams" }).click();
  await page.getByRole("button", { name: /Customer care/u }).click();
  await expect(page.getByText("support@demo.example")).toBeVisible();
  await page.getByRole("button", { name: "Back to list" }).click();
  await page.getByRole("link", { name: "People" }).click();
  await page.getByRole("textbox", { name: "Search people" }).fill("sam");
  await expect(
    page.getByRole("button", { name: "Manage Maya Chen" })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Manage Sam Brooks" }).click();
  await expect(page.getByText("sam@demo.example").first()).toBeVisible();
  await page.getByRole("button", { name: "Back to list" }).click();
  await page.getByRole("button", { name: "Manage Maya Chen" }).click();
  await expect(page.getByRole("heading", { name: "Person" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save changes" })
  ).toBeVisible();
  // Team membership is edited from the person too.
  const careTeam = page.getByRole("checkbox", { name: /Customer care/u });
  const wasOnTeam = await careTeam.isChecked();
  await careTeam.click();
  await page.getByRole("button", { name: "Save teams" }).click();
  await expect(page.getByText("Teams updated")).toBeVisible();
  await expect(careTeam).toBeChecked({ checked: !wasOnTeam });
  await careTeam.click();
  await page.getByRole("button", { name: "Save teams" }).click();
  await expect(careTeam).toBeChecked({ checked: wasOnTeam });
  await page.getByRole("button", { name: "Recovery link" }).click();
  await expect(page.locator("input[readonly]")).toHaveValue(/\/recover\//u);
  await page.goBack();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Save changes" })
  ).toBeVisible();
  await expect(page.locator("input[readonly]")).toHaveCount(0);
});

test("direct admin links select loaded SSO and team records", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await page.goto("/");
  // API calls below need the session cookie the login response sets.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/mock/login") && response.ok()
    ),
    page.getByRole("button", { name: "Open seeded local demo" }).click(),
  ]);

  const state = z
    .object({ users: z.array(z.object({ id: z.string() })) })
    .parse(
      await page.evaluate(async () => (await fetch("/api/admin/state")).json())
    );

  const userId = required(state.users[0], "the demo has users").id;

  const responses = await page.evaluate(async (memberId) => {
    const [clientResponse, groupResponse] = await Promise.all([
      fetch("/api/admin/oidc-clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Direct-link application",
          clientType: "public",
          accessTeams: [{ teamId: "team_everyone" }],
          redirectUris: ["https://direct.example.test/callback"],
          postLogoutRedirectUris: [],
          allowedOrigins: [],
          allowedScopes: ["openid"],
          trusted: true,
          enabled: true,
        }),
      }),
      fetch("/api/admin/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Direct-link team",
          slug: "direct-link-team",
          description: null,
          members: [{ userId: memberId, canSend: true }],
        }),
      }),
    ]);

    return {
      clientStatus: clientResponse.status,
      groupStatus: groupResponse.status,
      client: await clientResponse.json(),
      group: await groupResponse.json(),
    };
  }, userId);

  expect(responses.clientStatus).toBe(201);
  expect(responses.groupStatus).toBe(201);

  const created = {
    clientId: z.object({ clientId: z.string() }).parse(responses.client)
      .clientId,
    teamId: z.object({ teamId: z.string() }).parse(responses.group).teamId,
  };

  await page.goto(`/admin/sso-applications/${created.clientId}`);
  await expect(
    page.getByRole("heading", { name: "Direct-link application" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to list" })
  ).toBeVisible();
  await page.goto(`/admin/teams/${created.teamId}`);
  await expect(
    page.getByRole("heading", { name: "Direct-link team" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to list" })
  ).toBeVisible();
});

test("admin sections have their own paths", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Hello, Sam Brooks" })
  ).toBeVisible();

  // /admin and unknown sections open the first section.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/people$/u);
  await expect(
    page.getByRole("heading", { name: "People", exact: true })
  ).toBeVisible();
  await page.goto("/admin/nope");
  await expect(page).toHaveURL(/\/admin\/people$/u);

  await page.goto("/admin/teams");
  await expect(
    page.getByRole("heading", { name: "Teams", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Teams" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await page.getByRole("link", { name: "Webhooks" }).click();
  await expect(page).toHaveURL(/\/admin\/webhooks$/u);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Teams", exact: true })
  ).toBeVisible();

  await page.goto("/admin/people/invite");
  await expect(
    page.getByRole("heading", { name: "Invite person" })
  ).toBeVisible();
});

test("webhooks offer only the events this workspace sends", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Hello, Sam Brooks" })
  ).toBeVisible();
  await page.goto("/admin/webhooks");
  await page.getByRole("button", { name: "Add endpoint" }).click();
  const events = page.getByRole("group", { name: "Events" });
  await expect(events.getByRole("checkbox")).toHaveCount(5);
  // Without the mail module there is no mail to report.
  await expect(events.getByText("Email received")).toHaveCount(0);
  await expect(events.getByRole("checkbox").first()).toBeChecked();
  await expect(events.getByText("User joined")).toBeVisible();
});

test("a people manager sees who only an administrator can manage", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Desktop administration assertion"
  );
  await page.goto("/");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/mock/login") && response.ok()
    ),
    page.getByRole("button", { name: "Open seeded local demo" }).click(),
  ]);

  const patch = (permissions: string[]) =>
    page.evaluate(async (granted) => {
      const response = await fetch("/api/admin/users/usr_demo_member", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: granted }),
      });

      return response.status;
    }, permissions);

  expect(await patch(["manage_people"])).toBe(200);

  try {
    // Signed in as Maya, who may manage people but is no administrator.
    expect(
      await page.evaluate(
        async () =>
          (
            await fetch("/api/auth/mock/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ userId: "usr_demo_member" }),
            })
          ).status
      )
    ).toBe(200);
    await page.goto("/admin/people/usr_demo_admin");
    await expect(
      page.getByText("Only an administrator can manage this person")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Recovery link" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Save changes" })
    ).toHaveCount(0);
    // A person with no more permissions than hers is hers to manage.
    await page.goto("/admin/people/usr_demo_invited");
    await expect(
      page.getByRole("button", { name: "Save changes" })
    ).toBeVisible();
  } finally {
    expect(
      await page.evaluate(
        async () =>
          (
            await fetch("/api/auth/mock/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ userId: "usr_demo_admin" }),
            })
          ).status
      )
    ).toBe(200);
    expect(await patch([])).toBe(200);
  }
});
