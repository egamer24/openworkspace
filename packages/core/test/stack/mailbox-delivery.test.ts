import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";
import type {
  createMailboxSchema,
  updateMailboxSchema,
} from "../../worker/admin/schemas.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let samId = "";
let samPrimaryId = "";
let otherPrimaryId = "";
let teamId = "";

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

const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

const created = z.object({ mailboxId: z.string() });

const failure = z.looseObject({
  error: z.looseObject({ message: z.string() }).optional(),
});

/** Creates an address; its id, or the refusal's status and message. */
async function create(
  json: Omit<z.input<typeof createMailboxSchema>, "listPosting">,
  cookie = adminCookie
) {
  const response = await call(cookie, "/api/admin/mailboxes", {
    method: "POST",
    json: { listPosting: "workspace", ...json },
  });

  const body: unknown = await response.json();

  return response.status === 201
    ? { status: 201, id: created.parse(body).mailboxId, message: "" }
    : {
        status: response.status,
        id: "",
        message: failure.parse(body).error?.message ?? "",
      };
}

async function update(id: string, json: z.input<typeof updateMailboxSchema>) {
  const response = await call(adminCookie, `/api/admin/mailboxes/${id}`, {
    method: "PATCH",
    json,
  });

  await response.body?.cancel();

  return response.status;
}

async function invite(name: string, email: string, permissions: string[] = []) {
  const response = await call(adminCookie, "/api/admin/invitations", {
    method: "POST",
    json: { name, email },
  });

  expect(response.status).toBe(201);

  const { accessLink } = z
    .object({ accessLink: z.object({ userId: z.string() }) })
    .parse(await response.json());

  await env.DB.prepare(
    "UPDATE users SET status = 'active', permissions = ? WHERE id = ?"
  )
    .bind(JSON.stringify(permissions), accessLink.userId)
    .run();

  return accessLink.userId;
}

async function primaryOf(userId: string) {
  const row = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
  )
    .bind(userId)
    .first<{ id: string }>();

  return required(row, "an invited person has a primary mailbox").id;
}

async function exists(id: string) {
  return Boolean(
    await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ?")
      .bind(id)
      .first()
  );
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
  samId = await invite("Sam", "sam@example.test");
  samPrimaryId = await primaryOf(samId);
  otherPrimaryId = await primaryOf(await invite("Kim", "kim@example.test"));

  const team = await call(adminCookie, "/api/admin/teams", {
    method: "POST",
    json: {
      name: "Support",
      slug: "support",
      description: null,
      everyone: false,
      members: [],
    },
  });

  expect(team.status).toBe(201);
  teamId = z.object({ teamId: z.string() }).parse(await team.json()).teamId;
  await hooks.call("modules.recordAddressHooks", true);
});

afterAll(() => hooks.call("modules.recordAddressHooks", false));

describe("a person's extra addresses", () => {
  it("can be an alias of their own mailbox only", async () => {
    const alias = await create({
      address: "billing@example.test",
      displayName: "Billing",
      ownerUserId: samId,
      teamId: null,
      delivery: "alias",
      aliasOf: samPrimaryId,
    });

    expect(alias.status).toBe(201);
    expect(await hooks.call("modules.addressHookCalls")).toEqual([
      `saved ${alias.id}`,
    ]);

    const elsewhere = await create({
      address: "kims@example.test",
      displayName: "Kim's",
      ownerUserId: samId,
      teamId: null,
      delivery: "alias",
      aliasOf: otherPrimaryId,
    });

    expect(elsewhere.status).toBe(400);

    // An alias of an alias would hide where mail goes.
    expect(
      (
        await create({
          address: "billing2@example.test",
          displayName: "Billing",
          ownerUserId: samId,
          teamId: null,
          delivery: "alias",
          aliasOf: alias.id,
        })
      ).status
    ).toBe(400);

    // Nor is an alias anyone's primary.
    const promote = await call(
      adminCookie,
      `/api/admin/mailboxes/${alias.id}/primary`,
      { method: "POST" }
    );

    expect(promote.status).toBe(400);
    await promote.body?.cancel();
  });

  it("can forward to outside addresses, never the workspace's", async () => {
    const inside = await create({
      address: "out@example.test",
      displayName: "Out",
      ownerUserId: samId,
      teamId: null,
      delivery: "forward",
      forwardTo: ["sam@secondary.test"],
    });

    expect(inside).toMatchObject({
      status: 400,
      message: "Forward to addresses outside the workspace",
    });

    const forward = await create({
      address: "out@example.test",
      displayName: "Out",
      ownerUserId: samId,
      teamId: null,
      delivery: "forward",
      forwardTo: ["Sam@Home.test", "sam@home.test"],
    });

    expect(forward.status).toBe(201);

    const row = await env.DB.prepare(
      "SELECT forward_to FROM mailboxes WHERE id = ?"
    )
      .bind(forward.id)
      .first<{ forward_to: string }>();

    expect(JSON.parse(required(row, "saved").forward_to)).toEqual([
      "sam@home.test",
    ]);
    await hooks.call("modules.addressHookCalls");
  });

  it("keeps the primary a mailbox, and isn't a mailing list", async () => {
    expect(
      await update(samPrimaryId, {
        displayName: "Sam",
        delivery: "forward",
        forwardTo: ["sam@home.test"],
      })
    ).toBe(400);

    expect(
      (
        await create({
          address: "news@example.test",
          displayName: "News",
          ownerUserId: samId,
          teamId: null,
          delivery: "list",
        })
      ).status
    ).toBe(400);
  });

  it("needs manage_people, not manage_teams", async () => {
    const managerId = await invite("Manager", "manager@example.test", [
      "manage_teams",
    ]);

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: managerId }),
      })
    );

    expect(login.status).toBe(200);
    await login.json();

    const refused = await create(
      {
        address: "sneaky@example.test",
        displayName: "Sneaky",
        ownerUserId: samId,
        teamId: null,
        delivery: "forward",
        forwardTo: ["thief@outside.test"],
      },
      sessionCookie(login)
    );

    expect(refused.status).toBe(403);
  });
});

describe("the catch-all", () => {
  it("is one mailbox per domain", async () => {
    const inbox = await create({
      address: "support@example.test",
      displayName: "Support",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
      catchAll: true,
    });

    expect(inbox.status).toBe(201);

    const second = await create({
      address: "help@example.test",
      displayName: "Help",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
      catchAll: true,
    });

    expect(second).toMatchObject({
      status: 400,
      message: "Another address is the catch-all for example.test",
    });

    // Another domain has its own.
    expect(
      (
        await create({
          address: "support@secondary.test",
          displayName: "Support",
          ownerUserId: null,
          teamId,
          delivery: "inbox",
          catchAll: true,
        })
      ).status
    ).toBe(201);

    // A person's mailbox can be one too, once the shared inbox lets go.
    expect(
      await update(samPrimaryId, { displayName: "Sam", catchAll: true })
    ).toBe(400);
    expect(
      await update(inbox.id, { displayName: "Support", catchAll: false })
    ).toBe(200);
    expect(
      await update(samPrimaryId, { displayName: "Sam", catchAll: true })
    ).toBe(200);
    expect(
      await update(samPrimaryId, { displayName: "Sam", catchAll: false })
    ).toBe(200);
  });

  it("is only an address with its own mailbox", async () => {
    expect(
      (
        await create({
          address: "lists@example.test",
          displayName: "Lists",
          ownerUserId: null,
          teamId,
          delivery: "list",
          catchAll: true,
        })
      ).status
    ).toBe(400);
  });
});

describe("deleting a mailbox", () => {
  it("deletes its aliases first, each as an address", async () => {
    const inbox = await create({
      address: "sales@example.test",
      displayName: "Sales",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
    });

    const alias = await create({
      address: "deals@example.test",
      displayName: "Deals",
      ownerUserId: null,
      teamId,
      delivery: "alias",
      aliasOf: inbox.id,
    });

    expect([inbox.status, alias.status]).toEqual([201, 201]);
    await hooks.call("modules.addressHookCalls");

    // An address that aliases point to keeps its own mailbox.
    expect(
      await update(inbox.id, {
        displayName: "Sales",
        delivery: "forward",
        forwardTo: ["sales@outside.test"],
      })
    ).toBe(409);

    const deleted = await hooks.call<{
      result: string;
      events: { eventType: string; mailboxId: string }[];
    }>("modules.deleteAddress", inbox.id);

    expect(deleted).toEqual({
      result: "deleted",
      events: [
        { eventType: "mailbox.deleted", mailboxId: alias.id },
        { eventType: "mailbox.deleted", mailboxId: inbox.id },
      ],
    });
    expect(await hooks.call("modules.addressHookCalls")).toEqual([
      `deleted ${alias.id}`,
      `deleted ${inbox.id}`,
    ]);
    expect([await exists(inbox.id), await exists(alias.id)]).toEqual([
      false,
      false,
    ]);
  });

  it("through the admin API too", async () => {
    const inbox = await create({
      address: "jobs@example.test",
      displayName: "Jobs",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
    });

    const alias = await create({
      address: "careers@example.test",
      displayName: "Careers",
      ownerUserId: null,
      teamId,
      delivery: "alias",
      aliasOf: inbox.id,
    });

    const response = await call(
      adminCookie,
      `/api/admin/mailboxes/${inbox.id}`,
      { method: "DELETE" }
    );

    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(await exists(alias.id)).toBe(false);
  });
});
