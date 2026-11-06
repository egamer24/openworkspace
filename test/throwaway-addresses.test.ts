import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { throwawayLocalPart } from "../worker/mail/throwaway-addresses";

let adminCookie: string;
let memberCookie: string;
let adminMailboxId: string;
let sharedMailboxId: string;
let messageCount = 0;

async function call(path: string, init: { method?: string; json?: unknown; cookie?: string } = {}) {
  const response = await exports.default.fetch(new Request(`http://example.test/api${path}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: init.cookie ?? adminCookie,
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  }));
  return { status: response.status, body: await response.json<Record<string, any>>() };
}

async function sessionCookie(path: string, body: unknown) {
  const response = await exports.default.fetch(new Request(`http://example.test/api/auth/mock/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function deliver(to: string) {
  messageCount += 1;
  const fake = {
    from: "shop@example.net",
    to,
    raw: new Response(
      `From: shop@example.net\r\nTo: ${to}\r\nSubject: Throwaway ${messageCount}\r\n`
        + `Message-ID: <throwaway-${messageCount}@example.net>\r\n\r\nHello.`,
    ).body!,
    headers: new Headers(),
    rawSize: 100,
    setReject: vi.fn<(reason: string) => void>(),
    forward: vi.fn(),
  };
  await worker.email(fake as unknown as ForwardableEmailMessage, env);
  return fake;
}

async function storedCount(mailboxId: string) {
  const listed = await env.MAIL_STORAGE.list({ prefix: `mailboxes/${mailboxId}/raw/` });
  return listed.objects.length;
}

async function create(mailboxId: string, label: string | null = null, cookie = adminCookie) {
  return call("/mail/throwaway-addresses", { method: "POST", json: { mailboxId, label }, cookie });
}

beforeAll(async () => {
  adminCookie = await sessionCookie("bootstrap", { name: "Throwaway Admin", email: "admin@example.test" });
  const memberId = "usr_throwaway_member";
  await env.DB.prepare(
    "INSERT INTO users (id, name, role, status) VALUES (?, 'Member', 'member', 'active')",
  ).bind(memberId).run();
  memberCookie = await sessionCookie("login", { userId: memberId });
  const state = await call("/admin/state");
  adminMailboxId = state.body.mailboxes.find(
    (mailbox: { address: string }) => mailbox.address === "admin@example.test",
  ).id;
  const shared = await call("/admin/mailboxes", {
    method: "POST",
    json: {
      address: "team@example.test",
      displayName: "Team",
      ownerUserId: null,
      members: [
        { userId: state.body.users[0].id, canSend: true },
        { userId: memberId, canSend: false },
      ],
    },
  });
  expect(shared.status).toBe(201);
  sharedMailboxId = shared.body.mailboxId;
});

describe("throwaway addresses", () => {
  it("generates readable random local parts", () => {
    const parts = new Set(Array.from({ length: 200 }, throwawayLocalPart));
    expect(parts.size).toBeGreaterThan(190);
    for (const part of parts) expect(part).toMatch(/^[a-z]+-[a-z]+-[1-9]\d{3}$/u);
  });

  it("delivers into the chosen mailbox until it is turned off", async () => {
    const created = await create(adminMailboxId, "Shop newsletter");
    expect(created.status).toBe(201);
    const { id, address } = created.body.address;
    expect(address).toMatch(/^[a-z]+-[a-z]+-\d{4}@example\.test$/u);
    expect(created.body.address).toMatchObject({ label: "Shop newsletter", enabled: true });

    const before = await storedCount(adminMailboxId);
    expect((await deliver(address)).setReject).not.toHaveBeenCalled();
    expect(await storedCount(adminMailboxId)).toBe(before + 1);

    const off = await call(`/mail/throwaway-addresses/${id}`, { method: "PATCH", json: { enabled: false } });
    expect(off.body.address).toMatchObject({ enabled: false });
    expect((await deliver(address)).setReject).toHaveBeenCalled();
    expect(await storedCount(adminMailboxId)).toBe(before + 1);

    await call(`/mail/throwaway-addresses/${id}`, { method: "PATCH", json: { enabled: true } });
    expect((await deliver(address)).setReject).not.toHaveBeenCalled();
    expect(await storedCount(adminMailboxId)).toBe(before + 2);
  });

  it("is private to its creator and needs send access", async () => {
    expect((await create(sharedMailboxId, null, memberCookie)).status).toBe(403);
    expect((await create(adminMailboxId, null, memberCookie)).status).toBe(403);
    const mine = await create(sharedMailboxId, "Team signups");
    const { id } = mine.body.address;
    const listed = await call("/mail/throwaway-addresses", { cookie: memberCookie });
    expect(listed.body.addresses).toEqual([]);
    expect((await call(`/mail/throwaway-addresses/${id}`, {
      method: "PATCH",
      json: { enabled: false },
      cookie: memberCookie,
    })).status).toBe(404);
    const own = await call("/mail/throwaway-addresses");
    expect(own.body.addresses.map((row: { id: string }) => row.id)).toContain(id);
  });

  it("stops delivering when the creator loses send access", async () => {
    const created = await create(sharedMailboxId, "Revoked later");
    const { address } = created.body.address;
    expect((await deliver(address)).setReject).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE mailbox_members SET can_send = 0 WHERE mailbox_id = ?")
      .bind(sharedMailboxId).run();
    expect((await deliver(address)).setReject).toHaveBeenCalled();
    await env.DB.prepare("UPDATE mailbox_members SET can_send = 1 WHERE mailbox_id = ? AND user_id != ?")
      .bind(sharedMailboxId, "usr_throwaway_member").run();
  });

  it("shows throwaways to admins with their state", async () => {
    const routing = await call("/admin/routing");
    const throwaways = routing.body.addresses.filter((row: { throwaway: boolean }) => row.throwaway);
    expect(throwaways.length).toBeGreaterThanOrEqual(3);
    expect(throwaways[0]).toEqual(expect.objectContaining({ label: expect.anything(), enabled: expect.any(Boolean) }));
  });
});
