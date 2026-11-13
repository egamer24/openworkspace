import { expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) headers.set("content-type", "application/json");

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

function bootstrap(email: string) {
  return worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email }),
    })
  );
}

const refusal =
  "Use an address on one of the workspace's mail domains: example.test, secondary.test";

const adminState = z.object({
  mailDomains: z.array(z.string()),
  unlistedMailDomains: z.array(z.string()),
  mailboxes: z.array(z.object({ id: z.string(), address: z.string() })),
});

const errorBody = z.object({ error: z.object({ message: z.string() }) });

/** The first administrator's session, from the first test's setup. */
let cookie = "";

it("sets up on a configured mail domain only, the first one listed being primary", async () => {
  // Before setup, the screen learns the mail domains the first address may use, primary first.
  const before = await worker.fetch(new Request(`${origin}/api/bootstrap`));

  expect(await before.json()).toMatchObject({
    needsBootstrap: true,
    setupMailDomains: ["example.test", "secondary.test"],
  });

  const outside = await bootstrap("admin@elsewhere.test");
  expect(outside.status).toBe(400);
  expect(errorBody.parse(await outside.json()).error.message).toBe(refusal);

  // The second listed mail domain is allowed too; the config keeps the first primary.
  const setup = await bootstrap("Admin@Secondary.TEST");
  expect(setup.status).toBe(200);
  cookie = required(
    setup.headers.get("set-cookie")?.split(";", 1)[0],
    "setting up signs in"
  );
  await setup.body?.cancel();

  const after = await worker.fetch(new Request(`${origin}/api/bootstrap`));

  expect(await after.json()).toMatchObject({
    needsBootstrap: false,
    setupMailDomains: [],
  });

  // The mailbox keeps its domain as lowercase text; nothing copies the list into D1.
  const row = await env.DB.prepare(
    "SELECT local_part AS localPart, domain FROM mailboxes"
  ).first<{ localPart: string; domain: string }>();

  expect(row).toEqual({ localPart: "admin", domain: "secondary.test" });

  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domains'"
  ).all();

  expect(tables.results).toEqual([]);

  const state = adminState.parse(
    await (await call(cookie, "/api/admin/state")).json()
  );

  expect(state.mailDomains).toEqual(["example.test", "secondary.test"]);
  expect(state.unlistedMailDomains).toEqual([]);
});

it("keeps addresses on a domain the config dropped working, but creates none there", async () => {
  const admin = required(
    await env.DB.prepare("SELECT id FROM users").first<{ id: string }>(),
    "setup created the administrator"
  );

  // A shared address from when alchemy.run.ts still listed removed.test.
  await env.DB.prepare(
    `INSERT INTO mailboxes (id, local_part, domain, display_name, team_id, created_by_user_id)
     VALUES ('mbx_removed', 'sales', 'removed.test', 'Sales', 'team_everyone', ?)`
  )
    .bind(admin.id)
    .run();

  const state = adminState.parse(
    await (await call(cookie, "/api/admin/state")).json()
  );

  expect(state.mailDomains).toEqual(["example.test", "secondary.test"]);
  expect(state.unlistedMailDomains).toEqual(["removed.test"]);
  expect(state.mailboxes.map((mailbox) => mailbox.address)).toContain(
    "sales@removed.test"
  );

  // No new address on it: not a mailbox, not an invitation.
  const mailbox = await call(cookie, "/api/admin/mailboxes", {
    method: "POST",
    json: {
      address: "support@removed.test",
      displayName: "Support",
      ownerUserId: null,
      teamId: "team_everyone",
    },
  });

  expect(mailbox.status).toBe(400);
  expect(errorBody.parse(await mailbox.json()).error.message).toBe(refusal);

  const invitation = await call(cookie, "/api/admin/invitations", {
    method: "POST",
    json: { name: "Sam", email: "sam@removed.test" },
  });

  expect(invitation.status).toBe(400);
  expect(errorBody.parse(await invitation.json()).error.message).toBe(refusal);

  // The address that is there still changes and goes like any other.
  const renamed = await call(cookie, "/api/admin/mailboxes/mbx_removed", {
    method: "PATCH",
    json: { displayName: "Sales team" },
  });

  expect(renamed.status).toBe(200);
  await renamed.body?.cancel();

  const deleted = await call(cookie, "/api/admin/mailboxes/mbx_removed", {
    method: "DELETE",
  });

  expect(deleted.status).toBe(200);
  await deleted.body?.cancel();

  const cleared = adminState.parse(
    await (await call(cookie, "/api/admin/state")).json()
  );

  expect(cleared.unlistedMailDomains).toEqual([]);
});
