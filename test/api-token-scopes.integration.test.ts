import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const origin = "http://example.test";

function fetchApi(path: string, init: RequestInit = {}) {
  return exports.default.fetch(new Request(`${origin}${path}`, init));
}

describe("API token scopes", () => {
  it("limits send-only tokens to listing mailboxes, uploading, and sending", async () => {
    const bootstrap = await fetchApi("/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    });
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();

    const created = await fetchApi("/api/auth/api-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Invoicing", scope: "send" }),
    });
    expect(created.status).toBe(201);
    const { token } = await created.json<{
      token: { token: string; scope: string };
    }>();
    expect(token.scope).toBe("send");
    const auth = { authorization: `Bearer ${token.token}` };

    const listed = await fetchApi("/api/auth/api-tokens", { headers: { cookie } });
    expect(await listed.json()).toMatchObject({
      tokens: [{ name: "Invoicing", scope: "send" }],
    });

    const mailboxes = await fetchApi("/api/mail/mailboxes", { headers: auth });
    expect(mailboxes.status).toBe(200);
    const { mailboxes: [mailbox] } = await mailboxes.json<{
      mailboxes: Array<{ id: string; address: string }>;
    }>();
    expect(mailbox!.address).toBe("admin@example.test");

    const upload = await fetchApi(`/api/mail/uploads?mailboxId=${mailbox!.id}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        filename: "invoice.txt",
        contentType: "text/plain",
        size: 7,
      }),
    });
    expect(upload.status).toBe(201);
    await upload.json();

    const send = () => fetchApi("/api/mail/messages", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
        mailboxId: mailbox!.id,
        to: ["customer@example.net"],
        subject: "Invoice 1042",
        bodyText: "Attached.",
      }),
    });
    const sent = await send();
    expect(sent.status).toBe(201);
    const first = await sent.json<{ messageId: string }>();
    const retried = await send();
    expect(retried.status).toBe(200);
    expect((await retried.json<{ messageId: string }>()).messageId)
      .toBe(first.messageId);

    for (const path of [
      `/api/mail/mailboxes/${mailbox!.id}/folders`,
      `/api/mail/conversations?mailboxId=${mailbox!.id}`,
      "/api/admin/state",
    ]) {
      const denied = await fetchApi(path, { headers: auth });
      expect(denied.status, path).toBe(403);
      await denied.json();
    }

    const mcp = await fetchApi("/mcp", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(403);
    await mcp.json();
  });
});
