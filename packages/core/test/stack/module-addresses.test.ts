import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let samId = "";
let samPrimaryId = "";
let teamId = "";
let teamInboxId = "";

type Recorded<T> = {
  result: T;
  events: { eventType: string; mailboxId: string }[];
};

type Created = { mailboxId: string } | { status: number; refusal: string };

async function call(
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers: {
        cookie: adminCookie,
        origin,
        "content-type": "application/json",
      },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );

  const body: unknown = await response.json();

  return { status: response.status, body };
}

const createAlias = (aliasOf: string, address: string, userId = samId) =>
  hooks.call<Recorded<Created>>(
    "modules.createAlias",
    aliasOf,
    address,
    userId
  );

const createdId = (created: Recorded<Created>) => {
  if (!("mailboxId" in created.result)) {
    throw new Error(`Refused: ${created.result.refusal}`);
  }

  return created.result.mailboxId;
};

async function row(id: string) {
  return await env.DB.prepare(
    `SELECT owner_user_id AS ownerUserId, team_id AS teamId, delivery,
       alias_of AS aliasOf, created_by_user_id AS createdBy
     FROM mailboxes WHERE id = ?`
  )
    .bind(id)
    .first();
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
  adminCookie = required(
    bootstrap.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

  const invited = await call("/api/admin/invitations", {
    method: "POST",
    json: { name: "Sam", email: "sam@example.test" },
  });

  samId = z
    .object({ accessLink: z.object({ userId: z.string() }) })
    .parse(invited.body).accessLink.userId;
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(samId)
    .run();

  samPrimaryId = required(
    await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
    )
      .bind(samId)
      .first<{ id: string }>(),
    "an invited person has a primary mailbox"
  ).id;

  const team = await call("/api/admin/teams", {
    method: "POST",
    json: {
      name: "Support",
      slug: "support",
      description: null,
      everyone: false,
      members: [{ userId: samId, canSend: true }],
    },
  });

  teamId = z.object({ teamId: z.string() }).parse(team.body).teamId;

  const inbox = await call("/api/admin/mailboxes", {
    method: "POST",
    json: {
      address: "support@example.test",
      displayName: "Support",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
      listPosting: "workspace",
    },
  });

  teamInboxId = z.object({ mailboxId: z.string() }).parse(inbox.body).mailboxId;
  await hooks.call("modules.aliasModule", true);
});

afterAll(() => hooks.call("modules.aliasModule", false));

describe("a module's addresses", () => {
  it("are created and deleted with core's checks and webhooks", async () => {
    const created = await createAlias(samPrimaryId, "Shop-Sam@Example.test");
    const aliasId = createdId(created);

    expect(created.events).toEqual([
      { eventType: "mailbox.created", mailboxId: aliasId },
    ]);
    expect(await row(aliasId)).toEqual({
      ownerUserId: samId,
      teamId: null,
      delivery: "alias",
      aliasOf: samPrimaryId,
      createdBy: samId,
    });

    expect(
      (await createAlias(samPrimaryId, "shop-sam@example.test")).result
    ).toEqual({ status: 409, refusal: "Mailbox address is already in use" });
    expect(
      (await createAlias(samPrimaryId, "shop@elsewhere.test")).result
    ).toMatchObject({ status: 400 });
    // Delivery rules apply too: an alias can't point at another alias.
    expect(
      (await createAlias(aliasId, "twice@example.test")).result
    ).toMatchObject({ status: 400 });

    const deleted = await hooks.call<Recorded<string>>(
      "modules.deleteAddress",
      aliasId
    );

    expect(deleted).toEqual({
      result: "deleted",
      events: [{ eventType: "mailbox.deleted", mailboxId: aliasId }],
    });
    expect(await row(aliasId)).toBeNull();
  });

  it("go away when their person loses send access", async () => {
    const teamAlias = createdId(
      await createAlias(teamInboxId, "desk-sam@example.test")
    );

    const personal = createdId(
      await createAlias(samPrimaryId, "news-sam@example.test")
    );

    expect(await row(teamAlias)).toMatchObject({
      ownerUserId: null,
      teamId,
      createdBy: samId,
    });

    // Off the team: the alias of its inbox goes, Sam's own stays.
    const offTeam = await call(`/api/admin/teams/person/${samId}`, {
      method: "PUT",
      json: { teamIds: [] },
    });

    expect(offTeam.status).toBe(200);
    expect(await hooks.call("modules.lostAliases")).toEqual([teamAlias]);
    expect(await row(teamAlias)).toBeNull();
    expect(await row(personal)).not.toBeNull();

    // Disabled: nothing of Sam's delivers through the module any more.
    const disabled = await call(`/api/admin/users/${samId}`, {
      method: "PATCH",
      json: { status: "disabled" },
    });

    expect(disabled.status).toBe(200);
    expect(await hooks.call("modules.lostAliases")).toEqual([personal]);
    expect(await row(personal)).toBeNull();
  });
});
