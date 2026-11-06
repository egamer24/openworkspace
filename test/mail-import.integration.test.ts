import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb } from "../worker/db/client";
import { users } from "../worker/db/schema";
import { mailboxStub } from "../worker/mailbox";

const origin = "http://example.test";

function message(headers: Record<string, string>, body: string) {
  return [
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
}

describe("admin mail import", () => {
  it("imports history with its date, direction, folder, and read state, without side effects", async () => {
    const bootstrap = await exports.default.fetch(new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }));
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();
    const [user] = await createDb(env.DB).select({ id: users.id }).from(users);
    const listed = await exports.default.fetch(new Request(`${origin}/api/mail/mailboxes`, {
      headers: { cookie },
    }));
    const { mailboxes: [mailbox] } = await listed.json<{
      mailboxes: Array<{ id: string }>;
    }>();
    const stub = mailboxStub(env, mailbox!.id);

    const importMessage = async (query: string, raw: string) => {
      const response = await exports.default.fetch(new Request(
        `${origin}/api/admin/mailboxes/${mailbox!.id}/import?${query}`,
        {
          method: "POST",
          headers: { cookie, "content-type": "message/rfc822" },
          body: raw,
        },
      ));
      return {
        status: response.status,
        body: await response.json<{ status?: string; messageId?: string }>(),
      };
    };
    const folderCounts = async () => Object.fromEntries(
      (await stub.listFolders(user!.id)).map((folder) => [
        folder.name,
        { total: folder.totalCount, unread: folder.unreadCount },
      ]),
    );

    const original = message({
      From: "Customer <customer@example.net>",
      To: "admin@example.test",
      Subject: "Order question",
      Date: "Mon, 01 Jan 2024 10:00:00 +0000",
      "Message-ID": "<order@example.net>",
    }, "Where is my order?");
    const first = await importMessage("state=archive&seen=1", original);
    expect(first).toMatchObject({ status: 200, body: { status: "imported" } });
    const imported = await stub.getEmail(first.body.messageId!);
    expect(imported).toMatchObject({
      direction: "incoming",
      transportState: "received",
    });
    expect(imported!.timelineAt.toISOString()).toBe("2024-01-01T10:00:00.000Z");
    expect((await folderCounts()).Archive).toEqual({ total: 1, unread: 0 });

    const again = await importMessage("state=archive&seen=1", original);
    expect(again).toMatchObject({
      status: 200,
      body: { status: "duplicate", messageId: first.body.messageId },
    });

    // The reply is newer, so it decides where the thread lives.
    const reply = await importMessage("state=active&folder=Clients", message({
      From: "Admin <admin@example.test>",
      To: "customer@example.net",
      Subject: "Re: Order question",
      Date: "Tue, 02 Jan 2024 09:00:00 +0000",
      "Message-ID": "<reply@example.test>",
      "In-Reply-To": "<order@example.net>",
    }, "It ships tomorrow."));
    expect(reply.status).toBe(200);
    const sent = await stub.getEmail(reply.body.messageId!);
    expect(sent).toMatchObject({
      direction: "outgoing",
      transportState: "submitted",
      conversationId: imported!.conversationId,
      deliveryStatusJson: [],
    });

    // An older message must not move the thread, whatever its own state.
    const older = await importMessage(
      "state=trash&receivedAt=2023-12-31T08:00:00Z",
      message({
        From: "Customer <customer@example.net>",
        To: "admin@example.test",
        Subject: "Re: Order question",
        "Message-ID": "<earlier@example.net>",
        References: "<order@example.net>",
      }, "Earlier note."),
    );
    expect(older.status).toBe(200);
    expect((await stub.getEmail(older.body.messageId!))!.timelineAt.toISOString())
      .toBe("2023-12-31T08:00:00.000Z");

    const counts = await folderCounts();
    expect(counts.Clients).toEqual({ total: 1, unread: 1 });
    expect(counts.Archive).toEqual({ total: 0, unread: 0 });
    expect(counts.Trash).toEqual({ total: 0, unread: 0 });
    expect(await stub.getConversation(imported!.conversationId)).toHaveLength(3);

    const empty = await importMessage("", "");
    expect(empty.status).toBe(400);
    const missing = await exports.default.fetch(new Request(
      `${origin}/api/admin/mailboxes/mbx_missing/import`,
      { method: "POST", headers: { cookie }, body: original },
    ));
    expect(missing.status).toBe(404);
    await missing.json();
  });
});
