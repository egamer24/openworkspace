import { beforeAll, describe, expect, it } from "bun:test";

import { D1_BOOKMARK_HEADER, required } from "@open-workspace/core/shared";
import { mcpAccessToken } from "@open-workspace/core/testing";
import { parseMailboxRealtimeUpdate } from "@open-workspace/email/shared/mail.ts";
import { z } from "zod";

import { readJson } from "./json.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * A browser's WebSocket to the deployed Worker, once the upgrade succeeded
 * (101) and the server announced the mailbox's current version.
 */
function openRealtime(mailboxId: string, cookie: string) {
  const url = new URL(
    `/api/mail/mailboxes/${mailboxId}/realtime`,
    process.env.STACK_URL
  );

  url.protocol = "ws:";

  const socket = new WebSocket(url, {
    // @ts-expect-error Bun's WebSocket takes request headers.
    headers: { cookie, origin: "http://example.test", host: "example.test" },
  });

  return new Promise<{ socket: WebSocket; version: number }>(
    (resolve, reject) => {
      socket.addEventListener(
        "message",
        (message) => {
          const version =
            parseMailboxRealtimeUpdate(String(message.data))?.version ?? null;

          if (version === null) {
            reject(
              new Error(`Unexpected first message ${String(message.data)}`)
            );
          } else resolve({ socket, version });
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => reject(new Error("The realtime upgrade failed")),
        { once: true }
      );
    }
  );
}

/** The signed-in administrator every test here acts as. */
type AdminSession = {
  cookie: string;
  mailboxId: string;
  userId: string;
  sessionId: string;
};

let session: AdminSession;

const membershipRow = z.object({ user_id: z.string() });

/** The user with access to a mailbox, the first one D1 lists. */
async function mailboxMember(mailboxId: string) {
  const membership = await env.DB.prepare(
    "SELECT user_id FROM mailbox_access WHERE mailbox_id = ? LIMIT 1"
  )
    .bind(mailboxId)
    .first();

  expect(membership).toBeTruthy();

  return membershipRow.parse(membership).user_id;
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
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const sessionCookie = required(cookie, "bootstrap sets a session cookie");

  const mailboxes = await worker.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie: sessionCookie },
    })
  );

  const body = await readJson(
    mailboxes,
    z.object({ mailboxes: z.array(z.object({ id: z.string() })) })
  );

  const mailboxId = required(body.mailboxes[0], "the admin has a mailbox").id;
  const userId = await mailboxMember(mailboxId);

  const storedSession = await env.DB.prepare(
    `SELECT session.id
     FROM sessions session
     WHERE session.user_id = ?
     ORDER BY session.created_at DESC LIMIT 1`
  )
    .bind(userId)
    .first();

  expect(storedSession).toBeTruthy();
  session = {
    cookie: sessionCookie,
    mailboxId,
    userId,
    sessionId: z.object({ id: z.string() }).parse(storedSession).id,
  };
});

describe("mailbox realtime", () => {
  it("authenticates the upgrade and broadcasts read changes", async () => {
    const { cookie, mailboxId } = session;
    const stub = mailbox(mailboxId);
    await stub.seedMailbox(
      [],
      [
        {
          id: "msg_realtime_read",
          conversationId: "conv_realtime_read",
          direction: "incoming",
          fromJson: [{ address: "sender@example.net", name: "Sender" }],
          toJson: [{ address: "admin@example.test", name: null }],
          subject: "Realtime read",
          timelineAt: new Date(),
          transportState: "received",
        },
      ]
    );

    const { socket, version: openedAt } = await openRealtime(mailboxId, cookie);
    await expect(
      stub.shouldSuppressPush("msg_realtime_read", session.userId)
    ).resolves.toBe(true);
    await expect(
      stub.shouldSuppressPush("msg_realtime_read", session.userId)
    ).resolves.toBe(true);

    const nextEvent = new Promise<string>((resolve) => {
      socket.addEventListener(
        "message",
        (message) => {
          resolve(String(message.data));
        },
        { once: true }
      );
    });

    const read = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/msg_realtime_read/read?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ isRead: true }),
        }
      )
    );

    expect(read.status).toBe(200);
    // The read response and the broadcast name the same new version.

    const { version } = await readJson(
      read,
      z.looseObject({ version: z.number() })
    );

    expect(version).toBeGreaterThan(openedAt);
    const update = parseMailboxRealtimeUpdate(await nextEvent);
    expect(update?.version).toBe(version);
    // Sent once the mailbox wrote its new inbox counts to D1, with the
    // bookmark after that write: reads with it see the new counts.
    expect(update?.bookmark).toBeTruthy();

    const listed = await worker.fetch(
      new Request("http://example.test/api/mail/mailboxes", {
        headers: {
          cookie,
          [D1_BOOKMARK_HEADER]: required(
            update?.bookmark,
            "the broadcast carries a bookmark"
          ),
        },
      })
    );

    const { mailboxes } = await readJson(
      listed,
      z.object({
        mailboxes: z.array(
          z.looseObject({ id: z.string(), version: z.number() })
        ),
      })
    );

    expect(mailboxes.find((entry) => entry.id === mailboxId)?.version).toBe(
      version
    );

    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });

    socket.close(1000, "Test complete");
    await closed;
    await expect(
      stub.shouldSuppressPush("msg_realtime_read", session.userId)
    ).resolves.toBe(true);
  });

  it("rejects a cross-origin WebSocket request", async () => {
    const { cookie, mailboxId } = session;

    const response = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/realtime`,
        {
          headers: {
            cookie,
            origin: "https://attacker.example",
            upgrade: "websocket",
          },
        }
      )
    );

    expect(response.status).toBe(403);
  });

  it("rejects OAuth access tokens before opening a WebSocket", async () => {
    const token = { token: (await mcpAccessToken(session.cookie)).accessToken };

    const response = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${session.mailboxId}/realtime`,
        {
          headers: {
            authorization: `Bearer ${token.token}`,
            origin: "http://example.test",
            upgrade: "websocket",
          },
        }
      )
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("closes a socket before broadcasting after mailbox access is revoked", async () => {
    const { cookie } = session;

    const memberId = await mailboxMember(session.mailboxId);
    // A team mailbox: leaving the team takes access away.
    const suffix = crypto.randomUUID().slice(0, 8);
    const teamId = `team_realtime_${suffix}`;
    const mailboxId = `mbx_realtime_${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO teams (id, name, slug, created_by_user_id) VALUES (?, ?, ?, ?)"
      ).bind(teamId, "Realtime", `realtime-${suffix}`, memberId),
      env.DB.prepare(
        "INSERT INTO team_members (team_id, user_id, can_send) VALUES (?, ?, 1)"
      ).bind(teamId, memberId),
      env.DB.prepare(`
        INSERT INTO mailboxes (id, local_part, domain, display_name, team_id, created_by_user_id)
        SELECT ?, ?, domain, 'Realtime', ?, ? FROM mailboxes WHERE id = ?
      `).bind(
        mailboxId,
        `realtime-${suffix}`,
        teamId,
        memberId,
        session.mailboxId
      ),
    ]);
    const stub = mailbox(mailboxId);
    await stub.seedMailbox(
      [],
      [
        {
          id: "msg_realtime_revoked",
          conversationId: "conv_realtime_revoked",
          direction: "incoming",
          fromJson: [{ address: "sender@example.net", name: "Sender" }],
          toJson: [{ address: "admin@example.test", name: null }],
          subject: "Revoked realtime",
          timelineAt: new Date(),
          transportState: "received",
        },
      ]
    );
    const { socket } = await openRealtime(mailboxId, cookie);

    const closed = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      });
    });

    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(teamId, memberId)
      .run();
    await stub.setMessageRead(memberId, "msg_realtime_revoked", true);
    await expect(closed).resolves.toBe(1008);
  });
});

describe("notification preferences", () => {
  it("binds a push registration to the current account", async () => {
    const { VAPID_PUBLIC_KEY } = await hooks.env("VAPID_PUBLIC_KEY");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;

    const create = await worker.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "PUT",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          endpoint,
          keys: {
            p256dh: VAPID_PUBLIC_KEY,
            auth: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        }),
      })
    );

    expect(create.status).toBe(200);
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId FROM push_subscriptions WHERE endpoint = ?"
      )
        .bind(endpoint)
        .first<{ userId: string }>()
    ).resolves.toMatchObject({ userId: session.userId });

    const remove = await worker.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "DELETE",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      })
    );

    expect(remove.status).toBe(200);
    await expect(
      env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
        .bind(endpoint)
        .first()
    ).resolves.toBeNull();
  });

  it("rejects malformed browser push keys", async () => {
    const create = await worker.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "PUT",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
          keys: { p256dh: "not-a-p256-key", auth: "too-short" },
        }),
      })
    );

    expect(create.status).toBe(400);
  });

  it("keeps account push when an unrelated session expires", async () => {
    const { VAPID_PUBLIC_KEY } = await hooks.env("VAPID_PUBLIC_KEY");
    const expiredTokenHash = `expired_${crypto.randomUUID()}`;
    const expiredSessionId = `ses_${crypto.randomUUID()}`;
    const pushSubscriptionId = `push_${crypto.randomUUID()}`;
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        expiredSessionId,
        session.userId,
        expiredTokenHash,
        now - 1,
        now - 60_000
      )
      .run();
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        pushSubscriptionId,
        session.userId,
        endpoint,
        VAPID_PUBLIC_KEY,
        "AAAAAAAAAAAAAAAAAAAAAA"
      )
      .run();

    const login = await worker.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: session.userId }),
      })
    );

    expect(login.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?"
      )
        .bind(expiredTokenHash)
        .first<{ count: number }>()
    ).toMatchObject({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM push_subscriptions WHERE id = ?"
      )
        .bind(pushSubscriptionId)
        .first<{ count: number }>()
    ).toMatchObject({ count: 1 });
  });

  it("defaults each accessible mailbox to enabled and stores a personal override", async () => {
    const { cookie, mailboxId } = session;

    const initial = await worker.fetch(
      new Request("http://example.test/api/notifications/preferences", {
        headers: { cookie },
      })
    );

    expect(await initial.json()).toMatchObject({
      preferences: [{ mailboxId, enabled: true }],
    });

    const update = await worker.fetch(
      new Request(
        `http://example.test/api/notifications/preferences/${mailboxId}`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }
      )
    );

    expect(update.status).toBe(200);

    const changed = await worker.fetch(
      new Request("http://example.test/api/notifications/preferences", {
        headers: { cookie },
      })
    );

    expect(await changed.json()).toMatchObject({
      preferences: [{ mailboxId, enabled: false }],
    });
  });
});
