import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../worker/db/client";
import { domains, driveItems, driveLinks, mailboxMembers, mailboxes, users } from "../worker/db/schema";
import { driveStagingKey } from "../worker/drive/service";
import { mailboxStub } from "../worker/mailbox";

const ORIGIN = "http://example.test";

type Item = { id: string; name: string; kind: string; size: number };

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected a session cookie");
  return cookie;
}

function call(cookie: string | null, path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, body }));
}

async function member(adminId: string, domainId: string, name: string) {
  const db = createDb(env.DB);
  const localPart = `${name}${crypto.randomUUID().slice(0, 8)}`;
  const id = `usr_${localPart}`;
  const now = new Date();
  await db.batch([
    db.insert(users).values({ id, name, role: "member", status: "active", createdAt: now, updatedAt: now }),
    db.insert(mailboxes).values({
      id: `mbx_${localPart}`,
      localPart,
      domainId,
      displayName: name,
      ownerUserId: id,
      isPrimary: true,
      createdByUserId: adminId,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(mailboxMembers).values({ mailboxId: `mbx_${localPart}`, userId: id, canSend: true, createdAt: now }),
  ] as const);
  const login = await call(null, "/api/auth/mock/login", { method: "POST", json: { userId: id } });
  expect(login.status).toBe(200);
  return { id, email: `${localPart}@example.test`, cookie: sessionCookie(login) };
}

// Storage is shared by the tests in this file, so bootstrap once and give
// every test its own fresh users.
let adminAccount: Promise<{ cookie: string; id: string; domainId: string }> | undefined;
function bootstrapAdmin() {
  adminAccount ??= (async () => {
    const bootstrap = await call(null, "/api/auth/mock/bootstrap", {
      method: "POST",
      json: { name: "Admin", email: "admin@example.test" },
    });
    expect(bootstrap.status).toBe(200);
    const db = createDb(env.DB);
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    const [domain] = await db.select({ id: domains.id }).from(domains).limit(1);
    return { cookie: sessionCookie(bootstrap), id: admin!.id, domainId: domain!.id };
  })();
  return adminAccount;
}

async function setup({ enable = true } = {}) {
  const admin = await bootstrapAdmin();
  const toggle = await call(admin.cookie, "/api/admin/drive", { method: "PUT", json: { enabled: enable } });
  expect(toggle.status).toBe(200);
  const owner = await member(admin.id, admin.domainId, "owner");
  return {
    admin: admin.cookie,
    owner: owner.cookie,
    ownerId: owner.id,
    viewer: await member(admin.id, admin.domainId, "viewer"),
    editor: await member(admin.id, admin.domainId, "editor"),
    stranger: await member(admin.id, admin.domainId, "stranger"),
  };
}

async function folder(cookie: string, name: string, parentId: string | null = null) {
  const response = await call(cookie, "/api/drive/folders", { method: "POST", json: { name, parentId } });
  expect(response.status).toBe(201);
  return (await response.json<{ item: Item }>()).item;
}

async function upload(
  cookie: string,
  name: string,
  content: string,
  input: { parentId?: string | null; contentType?: string } = {},
) {
  const bytes = new TextEncoder().encode(content);
  const intent = await call(cookie, "/api/drive/uploads", {
    method: "POST",
    json: { name, size: bytes.byteLength, contentType: input.contentType ?? "text/plain", parentId: input.parentId ?? null },
  });
  expect(intent.status).toBe(201);
  const { item, upload: target } = await intent.json<{
    item: Item;
    upload: { uploadUrl: string; headers: Record<string, string> };
  }>();
  // Tests have no R2 S3 credentials, so the URL is the Worker fallback.
  const url = new URL(target.uploadUrl);
  expect(url.pathname).toBe(`/api/drive/uploads/${item.id}/content`);
  const put = await call(cookie, url.pathname, { method: "PUT", headers: target.headers, body: bytes });
  expect(put.status).toBe(200);
  const complete = await call(cookie, `/api/drive/uploads/${item.id}/complete`, { method: "POST" });
  expect(complete.status).toBe(200);
  return (await complete.json<{ item: Item }>()).item;
}

async function r2KeyOf(itemId: string) {
  const [row] = await createDb(env.DB).select({ r2Key: driveItems.r2Key }).from(driveItems).where(eq(driveItems.id, itemId));
  return row?.r2Key ?? null;
}

describe("drive module", () => {
  it("is a 404 everywhere while disabled", async () => {
    const { admin, owner } = await setup({ enable: false });
    expect((await call(owner, "/api/drive/status")).status).toBe(404);
    expect((await call(owner, "/api/drive/items")).status).toBe(404);
    expect((await call(owner, "/api/drive/folders", { method: "POST", json: { name: "x" } })).status).toBe(404);
    expect((await call(null, "/d/some-token")).status).toBe(404);
    expect(await (await call(admin, "/api/admin/drive")).json()).toMatchObject({ enabled: false });
    expect((await call(owner, "/api/admin/drive")).status).toBe(403);

    await call(admin, "/api/admin/drive", { method: "PUT", json: { enabled: true } });
    expect((await call(owner, "/api/drive/status")).status).toBe(200);
    expect((await call(null, "/api/drive/status")).status).toBe(401);
  });

  it("enforces the per-user quota before accepting uploads", async () => {
    const { admin, owner, ownerId } = await setup();
    expect((await call(admin, `/api/admin/drive/quotas/${ownerId}`, { method: "PUT", json: { quotaBytes: 10 } })).status).toBe(200);

    const tooBig = await call(owner, "/api/drive/uploads", { method: "POST", json: { name: "big.txt", size: 11 } });
    expect(tooBig.status).toBe(413);
    const fits = await call(owner, "/api/drive/uploads", { method: "POST", json: { name: "fits.txt", size: 10 } });
    expect(fits.status).toBe(201);
    // The pending upload already holds its share of the quota.
    const next = await call(owner, "/api/drive/uploads", { method: "POST", json: { name: "more.txt", size: 1 } });
    expect(next.status).toBe(413);
    expect(await (await call(owner, "/api/drive/status")).json()).toMatchObject({ usedBytes: 10, quotaBytes: 10 });
    // Folders cost nothing.
    await folder(owner, "Still allowed");

    await call(admin, `/api/admin/drive/quotas/${ownerId}`, { method: "PUT", json: { quotaBytes: null } });
    expect((await call(owner, "/api/drive/uploads", { method: "POST", json: { name: "more.txt", size: 1 } })).status).toBe(201);
  });

  it("uploads, rejects size mismatches and name conflicts, and downloads", async () => {
    const { owner } = await setup();
    const file = await upload(owner, "notes.txt", "hello drive");
    const download = await call(owner, `/api/drive/items/${file.id}/content`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello drive");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/u);

    const intent = await (await call(owner, "/api/drive/uploads", {
      method: "POST",
      json: { name: "short.txt", size: 5, contentType: "text/plain" },
    })).json<{ item: Item }>();
    const put = await call(owner, `/api/drive/uploads/${intent.item.id}/content`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "abc",
    });
    expect(put.status).toBe(422);
    expect((await call(owner, `/api/drive/uploads/${intent.item.id}/complete`, { method: "POST" })).status).toBe(422);

    await folder(owner, "Docs");
    const duplicate = await call(owner, "/api/drive/folders", { method: "POST", json: { name: "docs" } });
    expect(duplicate.status).toBe(409);
    expect((await call(owner, "/api/drive/uploads", { method: "POST", json: { name: "NOTES.txt", size: 1 } })).status).toBe(409);

    const listed = await (await call(owner, "/api/drive/items?sort=name")).json<{ items: Item[] }>();
    // Folders first, then files; the incomplete upload stays hidden.
    expect(listed.items.map((item) => item.name)).toEqual(["Docs", "notes.txt"]);
    const search = await (await call(owner, "/api/drive/items?search=NOT")).json<{ items: Item[] }>();
    expect(search.items.map((item) => item.name)).toEqual(["notes.txt"]);
  });

  it("applies the owner / editor / viewer / unrelated permission matrix", async () => {
    const { owner, viewer, editor, stranger } = await setup();
    const shared = await folder(owner, "Shared");
    const file = await upload(owner, "plan.txt", "plan", { parentId: shared.id });
    for (const [person, role] of [[viewer, "viewer"], [editor, "editor"]] as const) {
      const share = await call(owner, `/api/drive/items/${shared.id}/shares`, {
        method: "PUT",
        json: { email: person.email, role },
      });
      expect(share.status).toBe(200);
    }

    // Viewer: read only, inherited from the folder.
    const sharedWithMe = await (await call(viewer.cookie, "/api/drive/items?view=shared")).json<{ items: Item[] }>();
    expect(sharedWithMe.items.map((item) => item.id)).toEqual([shared.id]);
    expect((await call(viewer.cookie, `/api/drive/items?parentId=${shared.id}`)).status).toBe(200);
    expect((await call(viewer.cookie, `/api/drive/items/${file.id}/content`)).status).toBe(200);
    expect((await call(viewer.cookie, `/api/drive/items/${file.id}`, { method: "PATCH", json: { name: "x.txt" } })).status).toBe(403);
    expect((await call(viewer.cookie, `/api/drive/items/${file.id}/trash`, { method: "POST" })).status).toBe(403);
    expect((await call(viewer.cookie, "/api/drive/uploads", {
      method: "POST",
      json: { name: "v.txt", size: 1, parentId: shared.id },
    })).status).toBe(404);
    expect((await call(viewer.cookie, `/api/drive/items/${shared.id}/shares`)).status).toBe(404);
    expect((await call(viewer.cookie, `/api/drive/items/${file.id}/links`, { method: "POST", json: {} })).status).toBe(404);

    // Editor: can change content, uploads are charged to the folder owner.
    expect((await call(editor.cookie, `/api/drive/items/${file.id}`, { method: "PATCH", json: { name: "plan-v2.txt" } })).status).toBe(200);
    const added = await upload(editor.cookie, "editor.txt", "by editor", { parentId: shared.id });
    const [addedRow] = await createDb(env.DB).select().from(driveItems).where(eq(driveItems.id, added.id));
    expect(addedRow!.ownerUserId).not.toBe(editor.id);
    expect(await (await call(owner, "/api/drive/status")).json()).toMatchObject({ usedBytes: 4 + 9 });
    // Moving out of the owner's tree into the editor's own drive is refused.
    expect((await call(editor.cookie, `/api/drive/items/${added.id}`, { method: "PATCH", json: { parentId: null } })).status).toBe(422);
    expect((await call(editor.cookie, `/api/drive/items/${added.id}/trash`, { method: "POST" })).status).toBe(200);
    expect((await call(editor.cookie, `/api/drive/items/${added.id}`, { method: "DELETE" })).status).toBe(404);

    // Unrelated user: nothing exists.
    expect((await call(stranger.cookie, `/api/drive/items/${file.id}`)).status).toBe(404);
    expect((await call(stranger.cookie, `/api/drive/items/${file.id}/content`)).status).toBe(404);
    expect((await call(stranger.cookie, `/api/drive/items?parentId=${shared.id}`)).status).toBe(404);
    expect((await call(stranger.cookie, "/api/drive/items?view=shared")).json()).resolves.toMatchObject({ items: [] });

    // Unsharing revokes access immediately.
    await call(owner, `/api/drive/items/${shared.id}/shares/${viewer.id}`, { method: "DELETE" });
    expect((await call(viewer.cookie, `/api/drive/items/${file.id}/content`)).status).toBe(404);
  });

  it("serves public links with password, expiry, revocation and access counts", async () => {
    const { owner } = await setup();
    const file = await upload(owner, "public.txt", "public bytes");
    async function link(json: Record<string, unknown>) {
      const response = await call(owner, `/api/drive/items/${file.id}/links`, { method: "POST", json });
      expect(response.status).toBe(201);
      const body = await response.json<{ url: string; link: { id: string } }>();
      return { path: new URL(body.url).pathname, id: body.link.id };
    }

    const open = await link({});
    const fetched = await call(null, open.path);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("public bytes");
    expect(fetched.headers.get("content-disposition")).toMatch(/^attachment;/u);

    const locked = await link({ password: "correct horse" });
    const form = await call(null, locked.path);
    expect(form.status).toBe(401);
    expect(await form.text()).toContain("<form");
    const wrong = await call(null, locked.path, { method: "POST", body: new URLSearchParams({ password: "nope" }) });
    expect(wrong.status).toBe(401);
    const right = await call(null, locked.path, { method: "POST", body: new URLSearchParams({ password: "correct horse" }) });
    expect(right.status).toBe(200);
    expect(await right.text()).toBe("public bytes");

    const expiring = await link({ expiresAt: Date.now() + 60_000 });
    await createDb(env.DB).update(driveLinks).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(driveLinks.id, expiring.id));
    expect((await call(null, expiring.path)).status).toBe(404);
    expect((await call(owner, `/api/drive/items/${file.id}/links`, {
      method: "POST",
      json: { expiresAt: Date.now() - 1 },
    })).status).toBe(422);

    const shares = await (await call(owner, `/api/drive/items/${file.id}/shares`)).json<{
      links: Array<{ id: string; accessCount: number; hasPassword: boolean }>;
    }>();
    expect(shares.links.find((item) => item.id === open.id)).toMatchObject({ accessCount: 1, hasPassword: false });
    expect(shares.links.find((item) => item.id === locked.id)).toMatchObject({ accessCount: 1, hasPassword: true });
    expect(JSON.stringify(shares)).not.toContain("pbkdf2");

    expect((await call(owner, `/api/drive/links/${open.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(null, open.path)).status).toBe(404);
    expect((await call(null, "/d/not-a-real-token")).status).toBe(404);

    // Trashed files stop being public.
    await call(owner, `/api/drive/items/${file.id}/trash`, { method: "POST" });
    expect((await call(null, locked.path, { method: "POST", body: new URLSearchParams({ password: "correct horse" }) })).status).toBe(404);
  });

  it("trashes, restores and permanently deletes whole folders including R2 objects", async () => {
    const { owner, ownerId } = await setup();
    const parent = await folder(owner, "Project");
    const child = await upload(owner, "inside.txt", "inside", { parentId: parent.id });
    const r2Key = (await r2KeyOf(child.id))!;
    expect(await env.MAIL_STORAGE.head(r2Key)).not.toBeNull();

    expect((await call(owner, `/api/drive/items/${parent.id}`, { method: "DELETE" })).status).toBe(409);
    await call(owner, `/api/drive/items/${parent.id}/trash`, { method: "POST" });
    expect(await (await call(owner, "/api/drive/items")).json()).toMatchObject({ items: [] });
    const trash = await (await call(owner, "/api/drive/items?view=trash")).json<{ items: Item[] }>();
    expect(trash.items.map((item) => item.id)).toEqual([parent.id]);

    // A new folder may take the trashed name; restoring then reports the conflict.
    const clash = await folder(owner, "Project");
    expect((await call(owner, `/api/drive/items/${parent.id}/restore`, { method: "POST" })).status).toBe(409);
    await call(owner, `/api/drive/items/${clash.id}/trash`, { method: "POST" });
    await call(owner, `/api/drive/items/${clash.id}`, { method: "DELETE" });

    expect((await call(owner, `/api/drive/items/${parent.id}/restore`, { method: "POST" })).status).toBe(200);
    const restored = await (await call(owner, `/api/drive/items?parentId=${parent.id}`)).json<{ items: Item[] }>();
    expect(restored.items.map((item) => item.id)).toEqual([child.id]);

    await call(owner, `/api/drive/items/${parent.id}/trash`, { method: "POST" });
    expect((await call(owner, `/api/drive/items/${parent.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await env.MAIL_STORAGE.head(r2Key)).toBeNull();
    const rows = await createDb(env.DB).select().from(driveItems).where(eq(driveItems.ownerUserId, ownerId));
    expect(rows).toEqual([]);
    expect(await (await call(owner, "/api/drive/status")).json()).toMatchObject({ usedBytes: 0 });
  });

  it("never serves risky file types inline", async () => {
    const { owner } = await setup();
    const html = await upload(owner, "page.html", "<script>alert(1)</script>", { contentType: "text/html" });
    const svg = await upload(owner, "logo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", { contentType: "image/svg+xml" });
    const disguised = await upload(owner, "evil.txt", "<script>1</script>", { contentType: "text/html" });
    const png = await upload(owner, "pixel.png", "png", { contentType: "image/png" });
    const text = await upload(owner, "readme.txt", "<b>hi</b>", { contentType: "text/plain" });

    for (const item of [html, svg, disguised]) {
      const response = await call(owner, `/api/drive/items/${item.id}/content?inline=true`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toMatch(/^sandbox;/u);
    }
    const image = await call(owner, `/api/drive/items/${png.id}/content?inline=true`);
    expect(image.headers.get("content-disposition")).toMatch(/^inline;/u);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-security-policy")).toMatch(/^sandbox;/u);
    const plain = await call(owner, `/api/drive/items/${text.id}/content?inline=true`);
    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const viewLink = await (await call(owner, `/api/drive/items/${html.id}/links`, {
      method: "POST",
      json: { access: "view" },
    })).json<{ url: string }>();
    const publicHtml = await call(null, new URL(viewLink.url).pathname);
    expect(publicHtml.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(publicHtml.headers.get("content-security-policy")).toMatch(/^sandbox;/u);
  });

  it("saves a mail attachment into Drive and exposes MCP tools only while enabled", async () => {
    const { admin, owner, ownerId } = await setup();
    const [mailbox] = await createDb(env.DB).select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.ownerUserId, ownerId));
    const mailboxId = mailbox!.id;
    const attachmentKey = `mailboxes/${mailboxId}/messages/msg_drive/attachments/att_drive`;
    await env.MAIL_STORAGE.put(attachmentKey, "attached bytes");
    await mailboxStub(env, mailboxId).seedMailbox([], [{
      id: "msg_drive",
      conversationId: "conv_drive",
      direction: "incoming",
      fromJson: [{ address: "sender@example.net", name: null }],
      toJson: [{ address: "owner@example.test", name: null }],
      subject: "Invoice",
      timelineAt: new Date(),
      transportState: "received",
      attachmentsJson: [{
        id: "att_drive",
        r2Key: attachmentKey,
        filename: "invoice/2026.txt",
        contentType: "text/plain",
        size: 14,
        contentId: null,
        disposition: "attachment",
        delivery: "attached",
        downloadTokenHash: null,
        downloadExpiresAt: null,
      }],
    }]);
    const saved = await call(owner, "/api/drive/items/from-attachment", {
      method: "POST",
      json: { mailboxId, messageId: "msg_drive", attachmentId: "att_drive" },
    });
    expect(saved.status).toBe(201);
    const { item } = await saved.json<{ item: Item }>();
    expect(item).toMatchObject({ name: "invoice_2026.txt", size: 14 });
    expect(await (await call(owner, `/api/drive/items/${item.id}/content`)).text()).toBe("attached bytes");

    const token = await (await call(owner, "/api/auth/api-tokens", { method: "POST", json: { name: "Drive" } }))
      .json<{ token: { token: string } }>();
    async function toolNames() {
      const response = await exports.default.fetch(new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token.token}`,
          accept: "application/json",
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "drive-test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }));
      const body = await response.json<{ result: { tools: Array<{ name: string }> } }>();
      return body.result.tools.map((tool) => tool.name);
    }
    expect(await toolNames()).toContain("create_drive_share_link");
    await call(admin, "/api/admin/drive", { method: "PUT", json: { enabled: false } });
    expect(await toolNames()).not.toContain("list_drive_items");
  });

  it("stops serving public links once the owner is disabled", async () => {
    const { admin, owner, ownerId } = await setup();
    const file = await upload(owner, "owned.txt", "owned bytes");
    const created = await call(owner, `/api/drive/items/${file.id}/links`, { method: "POST", json: {} });
    expect(created.status).toBe(201);
    const path = new URL((await created.json<{ url: string }>()).url).pathname;
    expect((await call(null, path)).status).toBe(200);

    const disable = await call(admin, `/api/admin/users/${ownerId}`, { method: "PATCH", json: { status: "disabled" } });
    expect(disable.status).toBe(200);
    expect((await call(null, path)).status).toBe(404);
  });

  it("refuses to fill or finish an upload after the editor loses write access", async () => {
    const { owner, editor } = await setup();
    const shared = await folder(owner, "Revoked");
    const share = await call(owner, `/api/drive/items/${shared.id}/shares`, {
      method: "PUT",
      json: { email: editor.email, role: "editor" },
    });
    expect(share.status).toBe(200);
    const bytes = new TextEncoder().encode("late");
    const intent = await call(editor.cookie, "/api/drive/uploads", {
      method: "POST",
      json: { name: "late.txt", size: bytes.byteLength, contentType: "text/plain", parentId: shared.id },
    });
    expect(intent.status).toBe(201);
    const { item } = await intent.json<{ item: Item }>();

    await call(owner, `/api/drive/items/${shared.id}/shares/${editor.id}`, { method: "DELETE" });
    const put = await call(editor.cookie, `/api/drive/uploads/${item.id}/content`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    });
    expect(put.status).toBe(404);
    // Even with bytes already staged, completion is refused.
    await env.MAIL_STORAGE.put(driveStagingKey(item.id), bytes);
    expect((await call(editor.cookie, `/api/drive/uploads/${item.id}/complete`, { method: "POST" })).status).toBe(404);
    const [row] = await createDb(env.DB).select().from(driveItems).where(eq(driveItems.id, item.id));
    expect(row!.status).toBe("pending");
  });
});
