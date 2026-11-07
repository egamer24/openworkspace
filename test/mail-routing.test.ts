import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import type { CloudflareApi } from "../worker/admin/cloudflare-onboarding";
import { ensureCloudflareDestination } from "../worker/admin/routing-routes";
import { FORWARDED_HEADER } from "../worker/mail/inbound-routing";

let adminCookie: string;
let memberCookie: string;
let adminMailboxId: string;
let opsMailboxId: string;
let domainId: string;
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

function message(to: string, options: { from?: string; headers?: Record<string, string> } = {}) {
  messageCount += 1;
  const from = options.from ?? "sender@example.net";
  return {
    from,
    to,
    raw: new Response(
      `From: ${from}\r\nTo: ${to}\r\nSubject: Routing ${messageCount}\r\n`
        + `Message-ID: <routing-${messageCount}@example.net>\r\n\r\nHello.`,
    ).body!,
    headers: new Headers(options.headers),
    rawSize: 100,
    setReject: vi.fn<(reason: string) => void>(),
    forward: vi.fn<(rcptTo: string, headers?: Headers) => Promise<EmailSendResult>>()
      .mockResolvedValue({ messageId: "forwarded" }),
  };
}

async function deliver(to: string, options?: Parameters<typeof message>[1]) {
  const fake = message(to, options);
  await worker.email(fake as unknown as ForwardableEmailMessage, env);
  return fake;
}

async function storedCount(mailboxId: string) {
  const listed = await env.MAIL_STORAGE.list({ prefix: `mailboxes/${mailboxId}/raw/` });
  return listed.objects.length;
}

async function verifiedDestination(email: string) {
  const created = await call("/admin/routing/destinations", { method: "POST", json: { email } });
  expect(created.status).toBe(201);
  const id = created.body.destinationId as string;
  expect((await call(`/admin/routing/destinations/${id}`, {
    method: "PATCH",
    json: { verified: true },
  })).status).toBe(200);
  return id;
}

async function route(input: Record<string, unknown>) {
  const created = await call("/admin/routing/addresses", { method: "POST", json: input });
  expect(created.status).toBe(201);
  return created.body.addressId as string;
}

beforeAll(async () => {
  adminCookie = await sessionCookie("bootstrap", { name: "Routing Admin", email: "admin@example.test" });
  const memberId = "usr_routing_member";
  await env.DB.prepare(
    "INSERT INTO users (id, name, role, status) VALUES (?, 'Member', 'member', 'active')",
  ).bind(memberId).run();
  memberCookie = await sessionCookie("login", { userId: memberId });
  const state = await call("/admin/state");
  adminMailboxId = state.body.mailboxes.find(
    (mailbox: { address: string }) => mailbox.address === "admin@example.test",
  ).id;
  domainId = state.body.domains.find((domain: { name: string }) => domain.name === "example.test").id;
  const ops = await call("/admin/mailboxes", {
    method: "POST",
    json: {
      address: "ops@example.test",
      displayName: "Operations",
      ownerUserId: null,
      members: [{ userId: state.body.users[0].id, canSend: true }],
    },
  });
  expect(ops.status).toBe(201);
  opsMailboxId = ops.body.mailboxId;
});

describe("mail routing administration", () => {
  it("is admin-only", async () => {
    expect((await call("/admin/routing", { cookie: memberCookie })).status).toBe(403);
    expect((await call("/admin/routing/destinations", {
      method: "POST",
      json: { email: "x@example.org" },
      cookie: memberCookie,
    })).status).toBe(403);
    expect((await call("/admin/routing/addresses", {
      method: "POST",
      json: { address: "x@example.test", mailboxId: adminMailboxId },
      cookie: memberCookie,
    })).status).toBe(403);
  });

  it("validates input and refuses unverified destinations", async () => {
    expect((await call("/admin/routing/destinations", {
      method: "POST",
      json: { email: "not-an-address" },
    })).status).toBe(400);

    const manual = await call("/admin/routing/destinations", {
      method: "POST",
      json: { email: "pending@example.org" },
    });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ verified: false });
    expect(manual.body.manualStep).toMatch(/Destination addresses/u);
    expect((await call("/admin/routing/destinations", {
      method: "POST",
      json: { email: "pending@example.org" },
    })).status).toBe(409);
    // Without API access, refresh explains that Cloudflare is not configured.
    expect((await call(`/admin/routing/destinations/${manual.body.destinationId}/refresh`, {
      method: "POST",
    })).status).toBe(503);

    expect((await call("/admin/routing/addresses", {
      method: "POST",
      json: { address: "pending@example.test", destinationIds: [manual.body.destinationId] },
    })).status).toBe(409);
    expect((await call("/admin/routing/addresses", {
      method: "POST",
      json: { address: "nothing@example.test" },
    })).status).toBe(400);
    expect((await call("/admin/routing/addresses", {
      method: "POST",
      json: { address: "alias@unconfigured.test", mailboxId: adminMailboxId },
    })).status).toBe(400);
    expect((await call("/admin/routing/addresses", {
      method: "POST",
      json: { address: "ops@example.test", mailboxId: adminMailboxId },
    })).status).toBe(409);
    expect((await call(`/admin/routing/domains/${domainId}/unknown-recipients`, {
      method: "PUT",
      json: { mailboxId: "mbx_missing" },
    })).status).toBe(400);
  });

  it("delivers an alias into the existing mailbox", async () => {
    await route({ address: "Hello@example.test", mailboxId: adminMailboxId });
    const before = await storedCount(adminMailboxId);

    const delivered = await deliver("hello@example.test");

    expect(delivered.setReject).not.toHaveBeenCalled();
    expect(delivered.forward).not.toHaveBeenCalled();
    expect(await storedCount(adminMailboxId)).toBe(before + 1);
    // The address is taken, so no mailbox can be created on it.
    expect((await call("/admin/mailboxes", {
      method: "POST",
      json: {
        address: "hello@example.test",
        displayName: "Hello",
        ownerUserId: null,
        members: [{ userId: "usr_routing_member", canSend: false }],
      },
    })).status).toBe(409);
  });

  it("forwards a forward-only address with no mailbox unchanged", async () => {
    const destination = await verifiedDestination("forward@example.org");
    await route({ address: "sales@example.test", destinationIds: [destination] });

    const delivered = await deliver("sales@example.test");

    expect(delivered.setReject).not.toHaveBeenCalled();
    expect(delivered.forward).toHaveBeenCalledTimes(1);
    const [rcptTo, headers] = delivered.forward.mock.calls[0]!;
    expect(rcptTo).toBe("forward@example.org");
    expect(headers?.get(FORWARDED_HEADER)).toBe("1");

    const routing = await call("/admin/routing");
    expect(routing.body.addresses).toContainEqual(expect.objectContaining({
      address: "sales@example.test",
      mailboxId: null,
      destinationIds: [destination],
    }));
  });

  it("stores and forwards, or forwards only when keepCopy is off", async () => {
    const destination = await verifiedDestination("copy@example.org");
    await route({ address: "admin@example.test", destinationIds: [destination] });
    const adminBefore = await storedCount(adminMailboxId);
    const kept = await deliver("admin@example.test");
    expect(kept.forward).toHaveBeenCalledWith("copy@example.org", expect.any(Headers));
    expect(await storedCount(adminMailboxId)).toBe(adminBefore + 1);

    await route({ address: "ops@example.test", destinationIds: [destination], keepCopy: false });
    const opsBefore = await storedCount(opsMailboxId);
    const forwardedOnly = await deliver("ops@example.test");
    expect(forwardedOnly.forward).toHaveBeenCalledTimes(1);
    expect(await storedCount(opsMailboxId)).toBe(opsBefore);

    // A forward skipped by the loop guard falls back to storing the message.
    const looped = await deliver("ops@example.test", { from: "copy@example.org" });
    expect(looped.forward).not.toHaveBeenCalled();
    expect(await storedCount(opsMailboxId)).toBe(opsBefore + 1);
  });

  it("guards against forwarding loops", async () => {
    const destination = await verifiedDestination("loop@example.org");
    await route({ address: "loop@example.test", destinationIds: [destination] });

    const fromDestination = await deliver("loop@example.test", { from: "LOOP@example.org" });
    expect(fromDestination.forward).not.toHaveBeenCalled();
    expect(fromDestination.setReject).toHaveBeenCalledWith(expect.stringMatching(/no forwarding destination/u));

    const tooManyHops = await deliver("loop@example.test", { headers: { [FORWARDED_HEADER]: "3" } });
    expect(tooManyHops.forward).not.toHaveBeenCalled();
    expect(tooManyHops.setReject).toHaveBeenCalled();
    const negative = await deliver("loop@example.test", { headers: { [FORWARDED_HEADER]: "-1000000" } });
    expect(negative.forward.mock.calls[0]![1]?.get(FORWARDED_HEADER)).toBe("1");

    const nextHop = await deliver("loop@example.test", { headers: { [FORWARDED_HEADER]: "2" } });
    expect(nextHop.forward.mock.calls[0]![1]?.get(FORWARDED_HEADER)).toBe("3");
  });

  it("retries a forward-only delivery when every forward fails", async () => {
    const fake = message("sales@example.test");
    fake.forward.mockRejectedValue(new Error("destination address not verified"));
    await expect(worker.email(fake as unknown as ForwardableEmailMessage, env))
      .rejects.toThrow(/Forwarding/u);
  });

  it("rejects unknown recipients unless the domain has a catch-all mailbox", async () => {
    const rejected = await deliver("nobody@example.test");
    expect(rejected.setReject).toHaveBeenCalledWith(expect.stringContaining("does not exist"));

    expect((await call(`/admin/routing/domains/${domainId}/unknown-recipients`, {
      method: "PUT",
      json: { mailboxId: opsMailboxId },
    })).status).toBe(200);
    const before = await storedCount(opsMailboxId);
    const caught = await deliver("nobody@example.test");
    expect(caught.setReject).not.toHaveBeenCalled();
    expect(await storedCount(opsMailboxId)).toBe(before + 1);
    // Configured addresses still win over the catch-all.
    expect((await deliver("sales@example.test")).forward).toHaveBeenCalledTimes(1);

    expect((await call(`/admin/routing/domains/${domainId}/unknown-recipients`, {
      method: "PUT",
      json: { mailboxId: null },
    })).status).toBe(200);
    expect((await deliver("nobody@example.test")).setReject).toHaveBeenCalled();
  });

  it("resolves the recipient with a single D1 query", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    try {
      await deliver("hello@example.test");
      await deliver("sales@example.test");
      await deliver("nobody@example.test");
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(batch).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      batch.mockRestore();
    }
  });
});

describe("Cloudflare destination addresses", () => {
  function fakeApi(existing: { id: string; email: string; verified: string | null }[]) {
    const calls: string[] = [];
    const api: CloudflareApi = {
      async request<T>(method: string, path: string, body?: unknown) {
        calls.push(`${method} ${path.split("?")[0]}`);
        if (method === "GET") return existing as T;
        return { id: "new", email: (body as { email: string }).email, verified: null } as T;
      },
    };
    return { api, calls };
  }

  it("reuses an existing destination and its verification time", async () => {
    const { api, calls } = fakeApi([
      { id: "d1", email: "Team@Example.org", verified: "2026-01-01T00:00:00Z" },
    ]);
    await expect(ensureCloudflareDestination(api, "acct", "team@example.org"))
      .resolves.toMatchObject({ id: "d1", verified: "2026-01-01T00:00:00Z" });
    expect(calls).toEqual(["GET /accounts/acct/email/routing/addresses"]);
  });

  it("creates a missing destination, which starts unverified", async () => {
    const { api, calls } = fakeApi([]);
    await expect(ensureCloudflareDestination(api, "acct", "new@example.org"))
      .resolves.toMatchObject({ id: "new", verified: null });
    expect(calls).toEqual([
      "GET /accounts/acct/email/routing/addresses",
      "POST /accounts/acct/email/routing/addresses",
    ]);
  });
});
