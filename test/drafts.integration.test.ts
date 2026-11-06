import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb } from "../worker/db/client";
import { users } from "../worker/db/schema";

const origin = "http://example.test";

describe("server-side drafts", () => {
  it("autosaves with version checks, keeps attachments past upload expiry, and is removed on send", async () => {
    const bootstrap = await exports.default.fetch(new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }));
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();
    const [user] = await createDb(env.DB).select({ id: users.id }).from(users);
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await exports.default.fetch(new Request(`${origin}${path}`, {
        ...init,
        headers: { cookie, "content-type": "application/json", ...init.headers },
      }));
      return { status: response.status, body: await response.json<Record<string, any>>() };
    };
    const { body: { mailboxes: [mailbox] } } = await call("/api/mail/mailboxes");
    const mailboxId: string = mailbox.id;

    const intent = await call(`/api/mail/uploads?mailboxId=${mailboxId}`, {
      method: "POST",
      body: JSON.stringify({ filename: "quote.txt", contentType: "text/plain", size: 5 }),
    });
    expect(intent.status).toBe(201);
    const uploadId: string = intent.body.upload.id;
    const put = await exports.default.fetch(new Request(intent.body.upload.uploadUrl, {
      method: "PUT",
      headers: { cookie, "content-type": "text/plain" },
      body: "hello",
    }));
    expect(put.status).toBe(200);
    await put.json();
    expect((await call(`/api/mail/uploads/${uploadId}/complete?mailboxId=${mailboxId}`, {
      method: "POST",
    })).status).toBe(200);

    const draftId = "dft_0b5f1c2e-6a1d-4e0f-9b7a-1c2d3e4f5a6b";
    const draftPath = `/api/mail/drafts/${draftId}?mailboxId=${mailboxId}`;
    const draft = (expectedVersion: number, subject: string) => ({
      expectedVersion,
      kind: "compose",
      to: ["customer@example.net"],
      subject,
      editorBody: `<p>Quote attached</p><p><span data-composer-asset="asset-1" data-composer-asset-intent="attachment"></span></p>`,
      bodyText: "Quote attached",
      attachments: [{ assetId: "asset-1", uploadId, intent: "attachment", contentId: null }],
    });
    const first = await call(draftPath, { method: "PUT", body: JSON.stringify(draft(0, "Quote")) });
    expect(first).toMatchObject({ status: 200, body: { version: 1 } });
    const second = await call(draftPath, { method: "PUT", body: JSON.stringify(draft(1, "Quote v2")) });
    expect(second).toMatchObject({ status: 200, body: { version: 2 } });
    // A second window still holding version 1 must not overwrite version 2.
    const stale = await call(draftPath, { method: "PUT", body: JSON.stringify(draft(1, "Stale")) });
    expect(stale).toMatchObject({ status: 409, body: { draft: { subject: "Quote v2", version: 2 } } });

    expect((await call(`/api/mail/drafts?mailboxId=${mailboxId}`)).body.drafts).toMatchObject([
      { id: draftId, subject: "Quote v2", to: ["customer@example.net"], attachmentCount: 1 },
    ]);

    // Simulate the seven-day composer-uploads/ lifecycle rule.
    const composerPrefix = `composer-uploads/${mailboxId}/${user!.id}/${uploadId}/`;
    const expired = await env.MAIL_STORAGE.list({ prefix: composerPrefix });
    expect(expired.objects.length).toBeGreaterThan(0);
    await env.MAIL_STORAGE.delete(expired.objects.map((object) => object.key));

    const reopened = await call(draftPath);
    expect(reopened).toMatchObject({
      status: 200,
      body: {
        draft: {
          subject: "Quote v2",
          version: 2,
          attachmentsJson: [{ assetId: "asset-1", uploadId, filename: "quote.txt", size: 5 }],
        },
      },
    });

    const sent = await call("/api/mail/messages", {
      method: "POST",
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        draftId,
        mailboxId,
        to: ["customer@example.net"],
        subject: "Quote v2",
        bodyText: "Quote attached",
        attachments: [{ uploadId }],
      }),
    });
    expect(sent.status).toBe(201);

    await expect.poll(async () => (await call(`/api/mail/drafts?mailboxId=${mailboxId}`)).body.drafts)
      .toEqual([]);
    await expect.poll(async () => (await env.MAIL_STORAGE.list({
      prefix: `mailboxes/${mailboxId}/drafts/${draftId}/`,
    })).objects.length).toBe(0);
    expect((await call(draftPath)).status).toBe(404);
  });
});
