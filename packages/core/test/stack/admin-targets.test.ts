import { beforeAll, describe, expect, it } from "bun:test";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";
import { anotherActiveAdministratorRemains } from "../../worker/admin/records.ts";
import { createDb } from "../../worker/db/client.ts";
import { users } from "../../worker/db/schema.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let adminId = "";

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

/** That a request gets `status`; its body is not needed. */
async function expectStatus(
  status: number,
  ...request: Parameters<typeof call>
) {
  const response = await call(...request);
  expect(response.status, `${request[2]?.method ?? "GET"} ${request[1]}`).toBe(
    status
  );
  await response.body?.cancel();
}

const invitation = z.object({ accessLink: z.object({ userId: z.string() }) });

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

async function invite(name: string, email: string, permissions: string[] = []) {
  const response = await call(adminCookie, "/api/admin/invitations", {
    method: "POST",
    json: { name, email },
  });

  expect(response.status).toBe(201);

  const { accessLink } = invitation.parse(await response.json());

  await env.DB.prepare(
    "UPDATE users SET status = 'active', permissions = ? WHERE id = ?"
  )
    .bind(JSON.stringify(permissions), accessLink.userId)
    .run();

  return accessLink.userId;
}

async function signIn(userId: string) {
  const response = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    })
  );

  expect(response.status).toBe(200);
  await response.json();

  return sessionCookie(response);
}

/** The id with its first letter percent-encoded: the router decodes it, a naive path parser does not. */
function encoded(id: string) {
  return `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`;
}

let managerId = "";
let managerCookie = "";

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);
  adminCookie = sessionCookie(bootstrap);
  adminId = required(
    await env.DB.prepare("SELECT id FROM users WHERE role = 'admin'").first<{
      id: string;
    }>(),
    "the first administrator exists"
  ).id;
  managerId = await invite("People manager", "manager@example.test", [
    "manage_people",
  ]);
  managerCookie = await signIn(managerId);
});

describe("people managers and the accounts they act on", () => {
  it("cannot reach an administrator through a percent-encoded id", async () => {
    // Each is refused, so none changes what the others act on.
    await Promise.all(
      [adminId, encoded(adminId)].flatMap((id) => [
        expectStatus(403, managerCookie, `/api/admin/users/${id}/access-link`, {
          method: "POST",
        }),
        expectStatus(403, managerCookie, `/api/admin/users/${id}/sessions`),
        expectStatus(403, managerCookie, `/api/admin/users/${id}`, {
          method: "PATCH",
          json: { status: "disabled" },
        }),
      ])
    );

    const admin = await env.DB.prepare("SELECT status FROM users WHERE id = ?")
      .bind(adminId)
      .first();

    expect(admin).toEqual({ status: "active" });

    const links = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM access_links WHERE user_id = ? AND kind = 'recovery'"
    )
      .bind(adminId)
      .first();

    expect(links).toEqual({ count: 0 });
  });

  it("answers 404 for a person who does not exist", async () => {
    await Promise.all(
      [managerCookie, adminCookie].map((cookie) =>
        expectStatus(404, cookie, "/api/admin/users/usr_missing/access-link", {
          method: "POST",
        })
      )
    );
  });

  it("acts only on people whose permissions the manager holds too", async () => {
    const peer = await invite("Peer", "peer@example.test", ["manage_people"]);

    const stronger = await invite("Stronger", "stronger@example.test", [
      "manage_people",
      "manage_apps",
    ]);

    const peerLink = await call(
      managerCookie,
      `/api/admin/users/${peer}/access-link`,
      { method: "POST" }
    );

    expect(peerLink.status).toBe(201);
    await peerLink.body?.cancel();

    await Promise.all(
      [
        `/api/admin/users/${encoded(stronger)}/access-link`,
        `/api/admin/users/${stronger}/access-link`,
      ].map((path) =>
        expectStatus(403, managerCookie, path, { method: "POST" })
      )
    );

    const renamed = await call(managerCookie, `/api/admin/users/${stronger}`, {
      method: "PATCH",
      json: { name: "Renamed" },
    });

    expect(renamed.status).toBe(403);
    await renamed.body?.cancel();

    // Their personal mailboxes are theirs too.
    const mailbox = await call(managerCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "stronger.alias@example.test",
        displayName: "Alias",
        ownerUserId: stronger,
        teamId: null,
      },
    });

    expect(mailbox.status).toBe(403);
    await mailbox.body?.cancel();

    const adminMailbox = await call(managerCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "admin.alias@example.test",
        displayName: "Alias",
        ownerUserId: adminId,
        teamId: null,
      },
    });

    expect(adminMailbox.status).toBe(403);
    await adminMailbox.body?.cancel();

    const peerMailbox = await call(managerCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "peer.alias@example.test",
        displayName: "Alias",
        ownerUserId: peer,
        teamId: null,
      },
    });

    expect(peerMailbox.status).toBe(201);
    await peerMailbox.body?.cancel();

    // An administrator acts on anyone.
    const byAdmin = await call(
      adminCookie,
      `/api/admin/users/${stronger}/access-link`,
      { method: "POST" }
    );

    expect(byAdmin.status).toBe(201);
    await byAdmin.body?.cancel();
  });

  it("leaves roles and permissions to administrators", async () => {
    const peer = await invite("Promotable", "promotable@example.test");

    await Promise.all(
      [{ role: "admin" }, { permissions: ["manage_people"] }].map((json) =>
        expectStatus(403, managerCookie, `/api/admin/users/${peer}`, {
          method: "PATCH",
          json,
        })
      )
    );
  });
});

describe("the last administrator", () => {
  async function activeAdministrators() {
    return (
      await env.DB.prepare(
        "SELECT id FROM users WHERE role = 'admin' AND status = 'active'"
      ).all<{ id: string }>()
    ).results.map((row) => row.id);
  }

  it("is kept by the demotion statement itself, in whichever order changes land", async () => {
    const db = createDb(env.DB);
    const second = await invite("Second admin", "second-sql@example.test");
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
      .bind(second)
      .run();

    const demote = (id: string) =>
      db
        .update(users)
        .set({ role: "member" })
        .where(and(eq(users.id, id), anotherActiveAdministratorRemains(id)))
        .returning({ id: users.id });

    // Two demotions that each saw the other administrator, run one after the other.
    expect(await demote(second)).toHaveLength(1);
    expect(await demote(adminId)).toHaveLength(0);
    expect(await activeAdministrators()).toEqual([adminId]);
    // A disabled administrator does not count.
    await env.DB.prepare(
      "UPDATE users SET role = 'admin', status = 'disabled' WHERE id = ?"
    )
      .bind(second)
      .run();
    expect(await demote(adminId)).toHaveLength(0);
    await env.DB.prepare(
      "UPDATE users SET role = 'member', status = 'active' WHERE id = ?"
    )
      .bind(second)
      .run();
  });

  // An active administrator can only be changed by another active one, so
  // the last one can only be lost to two changes racing each other.
  for (const change of [{ role: "member" }, { status: "disabled" }]) {
    // oxlint-disable-next-line no-loop-func -- one test per case; change is a per-iteration const
    it(`survives two administrators changing each other at once (${Object.keys(change)[0]})`, async () => {
      const second = await invite(
        "Second admin",
        `second-${Object.keys(change)[0]}@example.test`
      );

      const promoted = await call(adminCookie, `/api/admin/users/${second}`, {
        method: "PATCH",
        json: { role: "admin" },
      });

      expect(promoted.status).toBe(200);
      await promoted.body?.cancel();
      const secondCookie = await signIn(second);

      const responses = await Promise.all([
        call(adminCookie, `/api/admin/users/${second}`, {
          method: "PATCH",
          json: change,
        }),
        call(secondCookie, `/api/admin/users/${adminId}`, {
          method: "PATCH",
          json: change,
        }),
      ]);

      const statuses = await Promise.all(
        responses.map(async (response) => {
          await response.body?.cancel();

          return response.status;
        })
      );

      expect(
        statuses.filter((status) => status === 200).length
      ).toBeLessThanOrEqual(1);
      const remaining = await activeAdministrators();
      expect(remaining).toHaveLength(1);
      // Back to one administrator, the first.
      await env.DB.prepare(
        "UPDATE users SET role = 'admin', status = 'active' WHERE id = ?"
      )
        .bind(adminId)
        .run();
      await env.DB.prepare(
        "UPDATE users SET role = 'member', status = 'active' WHERE id = ?"
      )
        .bind(second)
        .run();
      adminCookie = await signIn(adminId);
    });
  }
});
