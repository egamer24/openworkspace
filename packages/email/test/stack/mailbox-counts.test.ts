import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { poll } from "@open-workspace/core/testing";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * Mailbox lists read inbox unread counts from D1, where each mailbox's
 * Durable Object keeps them as its mail changes; listing never calls it.
 */

const mailboxList = z.object({
  mailboxes: z.array(
    z.looseObject({
      id: z.string(),
      unreadCount: z.number(),
      version: z.number(),
    })
  ),
});

let cookie: string;
let userId: string;
let mailboxId: string;

function incoming(id: string, conversationId: string, at: number): NewEmail {
  return {
    id,
    conversationId,
    direction: "incoming",
    fromJson: [{ address: `${id}@example.net`, name: null }],
    toJson: [{ address: "admin@example.test", name: null }],
    subject: `Subject ${id}`,
    preview: id,
    bodyText: id,
    timelineAt: new Date(at),
    transportState: "received",
  };
}

async function api(path: string, init: RequestInit = {}) {
  const response = await worker.fetch(
    new Request(`http://example.test${path}`, {
      ...init,
      headers: { cookie, "content-type": "application/json", ...init.headers },
    })
  );

  expect(response.status).toBe(200);

  return response;
}

async function listedMailboxes() {
  return (await readJson(await api("/api/mail/mailboxes"), mailboxList))
    .mailboxes;
}

async function listedUnread() {
  return required(
    (await listedMailboxes()).find((entry) => entry.id === mailboxId),
    "the mailbox is listed"
  );
}

/** Counts are written in the background after each change; waits for `expected`. */
async function expectListedUnread(expected: number) {
  const last = await poll(
    listedUnread,
    (listed) => listed.unreadCount === expected,
    { timeout: 5000, interval: 50 }
  );

  expect(last.unreadCount).toBe(expected);

  return last;
}

function d1Counts() {
  return env.DB.prepare(
    "SELECT incoming_count, version FROM mailbox_counts WHERE mailbox_id = ?"
  )
    .bind(mailboxId)
    .first<{ incoming_count: number; version: number }>();
}

beforeAll(async () => {
  const response = await worker.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(response.status).toBe(200);
  cookie = sessionCookie(response);
  const [first] = await listedMailboxes();
  mailboxId = required(first, "the admin has a mailbox").id;

  const access = await env.DB.prepare(
    "SELECT user_id FROM mailbox_access WHERE mailbox_id = ?"
  )
    .bind(mailboxId)
    .first<{ user_id: string }>();

  userId = required(access, "the admin has access to the mailbox").user_id;
});

describe("mailbox inbox counts in D1", () => {
  it("follow delivery, reading, moving and deleting", async () => {
    expect((await listedUnread()).unreadCount).toBe(0);
    await mailbox(mailboxId).seedMailbox(
      [],
      [
        incoming("msg_count_a1", "conv_count_a", 1_700_000_000_000),
        incoming("msg_count_a2", "conv_count_a", 1_700_000_000_001),
        incoming("msg_count_b1", "conv_count_b", 1_700_000_000_002),
        incoming("msg_count_c1", "conv_count_c", 1_700_000_000_003),
      ]
    );
    expect(await d1Counts()).toMatchObject({ incoming_count: 4 });
    await expectListedUnread(4);

    // Reading is per person: only this person's row changes.
    await api(`/api/mail/messages/msg_count_a1/read?mailboxId=${mailboxId}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    await expectListedUnread(3);
    expect(
      await env.DB.prepare(
        "SELECT user_id, read_count FROM mailbox_read_counts WHERE mailbox_id = ?"
      )
        .bind(mailboxId)
        .all()
    ).toMatchObject({ results: [{ user_id: userId, read_count: 1 }] });

    await api(`/api/mail/messages/msg_count_a1/read?mailboxId=${mailboxId}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: false }),
    });
    await expectListedUnread(4);

    await api(`/api/mail/conversations/bulk?mailboxId=${mailboxId}`, {
      method: "PATCH",
      body: JSON.stringify({
        type: "read",
        conversationIds: ["conv_count_b"],
        isRead: true,
      }),
    });
    await expectListedUnread(3);

    // Out of the inbox (to trash), then gone for good.
    await mailbox(mailboxId).bulkUpdateConversations(
      ["conv_count_a"],
      "inbox",
      { mailboxState: "trash" }
    );
    const afterMove = await expectListedUnread(1);
    expect(afterMove.version).toBe(
      required(await d1Counts(), "the mailbox has counts in D1").version
    );
    await mailbox(mailboxId).permanentlyDeleteConversations(["conv_count_a"]);
    await mailbox(mailboxId).bulkUpdateConversations(
      ["conv_count_c"],
      "inbox",
      { mailboxState: "archive" }
    );
    await expectListedUnread(0);
    expect(await d1Counts()).toMatchObject({ incoming_count: 1 });
  });

  it("are written again on start by a mailbox whose last write did not land", async () => {
    await mailbox(mailboxId).bulkUpdateConversations(
      ["conv_count_c"],
      "archive",
      { mailboxState: "active" }
    );
    await expectListedUnread(1);
    await mailbox(mailboxId)
      .testForgetInboxCounts()
      .catch(() => undefined);
    await env.DB.prepare("DELETE FROM mailbox_counts WHERE mailbox_id = ?")
      .bind(mailboxId)
      .run();
    await env.DB.prepare("DELETE FROM mailbox_read_counts WHERE mailbox_id = ?")
      .bind(mailboxId)
      .run();
    expect((await listedUnread()).unreadCount).toBe(0);

    // Any call starts the object again; it writes its counts on start.
    await mailbox(mailboxId).getFolderCounts(userId, "inbox");
    await expectListedUnread(1);
  });
});
