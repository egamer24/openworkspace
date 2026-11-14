import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let adminId = "";
let memberCookie = "";
let memberId = "";
let otherId = "";

const idList = z.array(z.looseObject({ id: z.string() }));

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

async function invite(name: string, email: string) {
  const response = await call(adminCookie, "/api/admin/invitations", {
    method: "POST",
    json: { name, email },
  });

  expect(response.status).toBe(201);

  const { accessLink } = await readJson(
    response,
    z.object({ accessLink: z.looseObject({ userId: z.string() }) })
  );

  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(accessLink.userId)
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

async function mailboxIds(cookie: string) {
  const response = await call(cookie, "/api/mail/mailboxes");
  const body = await readJson(response, z.object({ mailboxes: idList }));

  return body.mailboxes.map((mailbox) => mailbox.id);
}

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

  const admin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin'"
  ).first<{ id: string }>();

  adminId = required(admin, "the bootstrap creates an admin").id;
  memberId = await invite("Lead", "lead@example.test");
  otherId = await invite("Other", "other@example.test");
  memberCookie = await signIn(memberId);
});

describe("team mailboxes", () => {
  it("gives the team's members its mailbox and takes it away when they leave", async () => {
    const team = await call(adminCookie, "/api/admin/teams", {
      method: "POST",
      json: {
        name: "Sales",
        slug: "sales",
        description: null,
        members: [{ userId: memberId, canSend: false }],
      },
    });

    expect(team.status).toBe(201);

    const { teamId } = await readJson(
      team,
      z.looseObject({ teamId: z.string() })
    );

    const mailbox = await call(adminCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "sales@example.test",
        displayName: "Sales",
        ownerUserId: null,
        teamId,
      },
    });

    expect(mailbox.status).toBe(201);

    const { mailboxId } = await readJson(
      mailbox,
      z.looseObject({ mailboxId: z.string() })
    );

    expect(await mailboxIds(memberCookie)).toContain(mailboxId);
    expect(await mailboxIds(adminCookie)).not.toContain(mailboxId);

    const access = await env.DB.prepare(
      "SELECT can_send AS canSend FROM mailbox_access WHERE mailbox_id = ? AND user_id = ?"
    )
      .bind(mailboxId, memberId)
      .first();

    expect(access).toEqual({ canSend: 0 });

    // A team with mailboxes cannot be deleted out from under them.
    const blocked = await call(adminCookie, `/api/admin/teams/${teamId}`, {
      method: "DELETE",
    });

    expect(blocked.status).toBe(409);
    await blocked.json();

    const left = await call(adminCookie, `/api/admin/teams/${teamId}`, {
      method: "PATCH",
      json: { name: "Sales", slug: "sales", description: null, members: [] },
    });

    expect(left.status).toBe(200);
    await left.json();
    expect(await mailboxIds(memberCookie)).not.toContain(mailboxId);
  });

  it("rejects a mailbox that is neither personal nor a team's", async () => {
    const response = await call(adminCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "nobody@example.test",
        displayName: "Nobody",
        ownerUserId: null,
        teamId: null,
      },
    });

    expect(response.status).toBe(400);
    await response.json();
  });
});

describe("permissions", () => {
  it("are given to members by administrators only", async () => {
    const given = await call(adminCookie, `/api/admin/users/${memberId}`, {
      method: "PATCH",
      json: { permissions: ["manage_teams", "manage_people", "manage_teams"] },
    });

    expect(given.status).toBe(200);
    await given.json();
    expect(
      await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
        .bind(memberId)
        .first("permissions")
    ).toBe(JSON.stringify(["manage_teams", "manage_people"]));

    const unknown = await call(adminCookie, `/api/admin/users/${memberId}`, {
      method: "PATCH",
      json: { permissions: ["manage_domains"] },
    });

    expect(unknown.status).toBe(400);
    await unknown.json();

    // Managing people does not include handing out permissions.
    memberCookie = await signIn(memberId);

    const byMember = await call(memberCookie, `/api/admin/users/${otherId}`, {
      method: "PATCH",
      json: { permissions: ["manage_webhooks"] },
    });

    expect(byMember.status).toBe(403);
    await byMember.json();
  });

  it("show on the signed-in user and grant only what was given", async () => {
    const state = await call(memberCookie, "/api/bootstrap");
    expect(await state.json()).toMatchObject({
      user: {
        role: "member",
        permissions: ["manage_people", "manage_teams"],
      },
    });

    const admin = await call(memberCookie, "/api/admin/state");
    expect(admin.status).toBe(200);

    const body = await readJson(
      admin,
      z.looseObject({
        oidcClients: z.array(z.unknown()),
        teams: z.array(z.unknown()),
      })
    );

    expect(body.oidcClients).toEqual([]);

    const team = await call(memberCookie, "/api/admin/teams", {
      method: "POST",
      json: {
        name: "Support",
        slug: "support",
        description: null,
        members: [{ userId: otherId, canSend: true }],
      },
    });

    expect(team.status).toBe(201);
    await team.json();

    // Managing people never reaches an administrator's mailboxes.
    const adminMailbox = await call(memberCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "boss@example.test",
        displayName: "Boss",
        ownerUserId: adminId,
        teamId: null,
      },
    });

    expect(adminMailbox.status).toBe(403);
    await adminMailbox.json();

    const ownMailbox = await call(memberCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "other.two@example.test",
        displayName: "Other",
        ownerUserId: otherId,
        teamId: null,
      },
    });

    expect(ownMailbox.status).toBe(201);
    await ownMailbox.json();

    // Each is refused, so none changes what the others see.
    await Promise.all(
      (
        [
          ["/api/admin/webhooks", "GET"],
          ["/api/admin/blocked-senders", "GET"],
          ["/api/admin/blocked-senders", "POST"],
          ["/api/admin/blocked-senders?pattern=%40spam.example", "DELETE"],
          ["/api/admin/oidc-clients", "POST"],
          ["/api/admin/ai", "PUT"],
        ] as const
      ).map(async ([path, method]) => {
        const response = await call(memberCookie, path, {
          method,
          json: method === "GET" ? undefined : {},
        });

        expect(response.status, `${method} ${path}`).toBe(403);
        await response.body?.cancel();
      })
    );
  });

  it("include the installed modules' own, which their routes check", async () => {
    const state = await call(adminCookie, "/api/admin/state");

    const { availablePermissions } = await readJson(
      state,
      z.looseObject({ availablePermissions: idList })
    );

    expect(availablePermissions.map((permission) => permission.id)).toEqual([
      "manage_people",
      "manage_teams",
      "manage_webhooks",
      "manage_apps",
      "manage_blocked_senders",
      "import_mail",
      "manage_mail_archive",
    ]);

    const blocker = await invite("Blocker", "blocker@example.test");

    const given = await call(adminCookie, `/api/admin/users/${blocker}`, {
      method: "PATCH",
      json: { permissions: ["manage_blocked_senders"] },
    });

    expect(given.status).toBe(200);
    await given.json();
    const blockerCookie = await signIn(blocker);

    const added = await call(blockerCookie, "/api/admin/blocked-senders", {
      method: "POST",
      json: { pattern: "spam.example", moveExisting: false },
    });

    expect(await added.json()).toEqual({
      ok: true,
      pattern: "@spam.example",
      moved: null,
    });
    const listed = await call(blockerCookie, "/api/admin/blocked-senders");
    expect(await listed.json()).toMatchObject({
      blockedSenders: [
        { pattern: "@spam.example", scope: "domain", createdByName: "Blocker" },
      ],
    });

    const removed = await call(
      blockerCookie,
      "/api/admin/blocked-senders?pattern=%40spam.example",
      { method: "DELETE" }
    );

    expect(await removed.json()).toEqual({ ok: true });

    // The module's section opens nothing of core's.
    const people = await call(blockerCookie, `/api/admin/users/${otherId}`, {
      method: "PATCH",
      json: { name: "Renamed" },
    });

    expect(people.status).toBe(403);
    await people.json();
  });

  it("never let people managers reach administrators", async () => {
    const promote = await call(memberCookie, `/api/admin/users/${otherId}`, {
      method: "PATCH",
      json: { role: "admin" },
    });

    expect(promote.status).toBe(403);
    await promote.json();

    const disableAdmin = await call(
      memberCookie,
      `/api/admin/users/${adminId}`,
      {
        method: "PATCH",
        json: { status: "disabled" },
      }
    );

    expect(disableAdmin.status).toBe(403);
    await disableAdmin.json();

    const adminSessions = await call(
      memberCookie,
      `/api/admin/users/${adminId}/sessions`
    );

    expect(adminSessions.status).toBe(403);
    await adminSessions.json();

    const rename = await call(memberCookie, `/api/admin/users/${otherId}`, {
      method: "PATCH",
      json: { name: "Other Person" },
    });

    expect(rename.status).toBe(200);
    await rename.json();
  });

  it("stop granting anything once taken away", async () => {
    const taken = await call(adminCookie, `/api/admin/users/${memberId}`, {
      method: "PATCH",
      json: { permissions: [] },
    });

    expect(taken.status).toBe(200);
    await taken.json();
    const state = await call(memberCookie, "/api/admin/state");
    expect(state.status).toBe(403);
    await state.json();
  });
});
