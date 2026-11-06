import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { mailboxStub } from "../worker/mailbox";

const origin = "http://example.test";

describe("mailbox signatures", () => {
  it("stores one signature per user and mailbox and appends it only on request", async () => {
    const bootstrap = await exports.default.fetch(new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }));
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();
    const json = { cookie, "content-type": "application/json" };

    const listMailboxes = async () => {
      const response = await exports.default.fetch(new Request(`${origin}/api/mail/mailboxes`, {
        headers: { cookie },
      }));
      return (await response.json<{
        mailboxes: Array<{ id: string; signature: unknown }>;
      }>()).mailboxes;
    };
    const [mailbox] = await listMailboxes();
    expect(mailbox!.signature).toBeNull();

    const save = (body: unknown, mailboxId = mailbox!.id) => exports.default.fetch(new Request(
      `${origin}/api/mail/mailboxes/${mailboxId}/signature`,
      { method: "PUT", headers: json, body: JSON.stringify(body) },
    ));
    const saved = await save({
      html: '<p><strong>Admin</strong><script>alert(1)</script><br>'
        + '<a href="https://example.co" onclick="x()">Example Co</a> '
        + '<a href="javascript:alert(1)">trap</a><img src=x onerror=alert(1)></p>',
      useOnReply: false,
    });
    expect(saved.status).toBe(200);
    await saved.json();
    expect((await listMailboxes())[0]!.signature).toEqual({
      html: '<p><strong>Admin</strong><br>'
        + '<a href="https://example.co" rel="noopener noreferrer" target="_blank">Example Co</a> trap</p>',
      text: "Admin\nExample Co [https://example.co] trap",
      useOnNew: true,
      useOnReply: false,
    });

    const forbidden = await save({ html: "x" }, "mbx_missing");
    expect(forbidden.status).toBe(403);
    await forbidden.json();

    const send = async (includeSignature: boolean | undefined) => {
      const response = await exports.default.fetch(new Request(`${origin}/api/mail/messages`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId: mailbox!.id,
          to: ["customer@example.net"],
          subject: "Hello",
          bodyText: "Body",
          bodyHtml: "<p>Body</p>",
          includeSignature,
        }),
      }));
      expect(response.status).toBe(201);
      const { messageId } = await response.json<{ messageId: string }>();
      return (await mailboxStub(env, mailbox!.id).getEmail(messageId))!;
    };
    expect((await send(undefined)).bodyText).toBe("Body");
    const signed = await send(true);
    expect(signed.bodyText).toBe("Body\n\nAdmin\nExample Co [https://example.co] trap");
    const signedHtml = await (await env.MAIL_STORAGE.get(signed.bodyHtmlR2Key!))!.text();
    expect(signedHtml).toContain("<div data-signature><p><strong>Admin</strong><br>");
    expect(signedHtml).not.toMatch(/script|onclick|javascript:|onerror/u);

    const cleared = await save({ html: "<p></p><p>  </p>" });
    expect(await cleared.json()).toMatchObject({ signature: null });
    expect((await listMailboxes())[0]!.signature).toBeNull();
    expect((await send(true)).bodyText).toBe("Body");
  });
});
