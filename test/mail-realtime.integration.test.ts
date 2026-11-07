import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { MAILBOX_REALTIME_UPDATE } from "../shared/mail";
import { mailboxStub } from "../worker/mailbox";

let session: {
  cookie: string;
  mailboxId: string;
  userId: string;
  sessionId: string;
};

beforeAll(async () => {
  const response = await exports.default.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const mailboxes = await exports.default.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie: cookie! },
    }),
  );
  const body = await mailboxes.json() as { mailboxes: Array<{ id: string }> };
  const membership = await env.DB.prepare(
    "SELECT user_id FROM mailbox_members WHERE mailbox_id = ? LIMIT 1",
  ).bind(body.mailboxes[0]!.id).first<{ user_id: string }>();
  expect(membership).toBeTruthy();
  const storedSession = await env.DB.prepare(
    `SELECT session.id
     FROM sessions session
     WHERE session.user_id = ?
     ORDER BY session.created_at DESC LIMIT 1`,
  ).bind(membership!.user_id).first<{ id: string }>();
  expect(storedSession).toBeTruthy();
  session = {
    cookie: cookie!,
    mailboxId: body.mailboxes[0]!.id,
    userId: membership!.user_id,
    sessionId: storedSession!.id,
  };
});

describe("mailbox realtime", () => {
  it("authenticates the upgrade and broadcasts read changes", async () => {
    const { cookie, mailboxId } = session;
    const stub = mailboxStub(env, mailboxId);
    await stub.seedMailbox([], [{
      id: "msg_realtime_read",
      conversationId: "conv_realtime_read",
      direction: "incoming",
      fromJson: [{ address: "sender@example.net", name: "Sender" }],
      toJson: [{ address: "admin@example.test", name: null }],
      subject: "Realtime read",
      timelineAt: new Date(),
      transportState: "received",
    }]);

    const upgrade = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/realtime`,
        {
          headers: {
            cookie,
            origin: "http://example.test",
            upgrade: "websocket",
          },
        },
      ),
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket!;
    socket.accept();
    await expect(
      stub.shouldSuppressPush(
        "msg_realtime_read",
        session.userId,
      ),
    ).resolves.toBe(true);
    await expect(
      stub.shouldSuppressPush(
        "msg_realtime_read",
        session.userId,
      ),
    ).resolves.toBe(true);
    const nextEvent = new Promise<string>((resolve) => {
      socket.addEventListener("message", (message) => {
        resolve(String(message.data));
      }, { once: true });
    });

    const read = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/msg_realtime_read/read?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ isRead: true }),
        },
      ),
    );
    expect(read.status).toBe(200);
    await expect(nextEvent).resolves.toBe(MAILBOX_REALTIME_UPDATE);
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close(1000, "Test complete");
    await closed;
    await expect(
      stub.shouldSuppressPush(
        "msg_realtime_read",
        session.userId,
      ),
    ).resolves.toBe(true);
  });

  it("rejects a cross-origin WebSocket request", async () => {
    const { cookie, mailboxId } = session;
    const response = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/realtime`,
        {
          headers: {
            cookie,
            origin: "https://attacker.example",
            upgrade: "websocket",
          },
        },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("rejects API tokens before opening a WebSocket", async () => {
    const tokenResponse = await exports.default.fetch(
      new Request("http://example.test/api/auth/api-tokens", {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Realtime rejection" }),
      }),
    );
    expect(tokenResponse.status).toBe(201);
    const { token } = await tokenResponse.json<{ token: { token: string } }>();

    const response = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${session.mailboxId}/realtime`,
        {
          headers: {
            authorization: `Bearer ${token.token}`,
            origin: "http://example.test",
            upgrade: "websocket",
          },
        },
      ),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("closes a socket before broadcasting after mailbox access is revoked", async () => {
    const { cookie, mailboxId } = session;
    const membership = await env.DB.prepare(
      "SELECT user_id, can_send FROM mailbox_members WHERE mailbox_id = ? LIMIT 1",
    ).bind(mailboxId).first<{ user_id: string; can_send: number }>();
    expect(membership).toBeTruthy();
    const stub = mailboxStub(env, mailboxId);
    await stub.seedMailbox([], [{
      id: "msg_realtime_revoked",
      conversationId: "conv_realtime_revoked",
      direction: "incoming",
      fromJson: [{ address: "sender@example.net", name: "Sender" }],
      toJson: [{ address: "admin@example.test", name: null }],
      subject: "Revoked realtime",
      timelineAt: new Date(),
      transportState: "received",
    }]);
    const upgrade = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/realtime`,
        {
          headers: {
            cookie,
            origin: "http://example.test",
            upgrade: "websocket",
          },
        },
      ),
    );
    const socket = upgrade.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code), { once: true });
    });

    await env.DB.prepare(
      "DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?",
    ).bind(mailboxId, membership!.user_id).run();
    await stub.setMessageRead(membership!.user_id, "msg_realtime_revoked", true);
    await expect(closed).resolves.toBe(1008);
    await env.DB.prepare(`
      INSERT INTO mailbox_members (mailbox_id, user_id, can_send)
      VALUES (?, ?, ?)
    `).bind(mailboxId, membership!.user_id, membership!.can_send).run();
  });
});

describe("notification preferences", () => {
  it("binds a push registration to the current account", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const create = await exports.default.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "PUT",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          endpoint,
          keys: {
            p256dh: env.VAPID_PUBLIC_KEY,
            auth: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        }),
      }),
    );
    expect(create.status).toBe(200);
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId FROM push_subscriptions WHERE endpoint = ?",
      ).bind(endpoint).first<{ userId: string }>(),
    ).resolves.toMatchObject({ userId: session.userId });

    const remove = await exports.default.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "DELETE",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }),
    );
    expect(remove.status).toBe(200);
    await expect(
      env.DB.prepare(
        "SELECT id FROM push_subscriptions WHERE endpoint = ?",
      ).bind(endpoint).first(),
    ).resolves.toBeNull();
  });

  it("rejects malformed browser push keys", async () => {
    const create = await exports.default.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "PUT",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
          keys: { p256dh: "not-a-p256-key", auth: "too-short" },
        }),
      }),
    );
    expect(create.status).toBe(400);
  });

  it("accepts only browser push service endpoints", async () => {
    const { isPushServiceEndpoint } = await import("../worker/mail/push-notifications");
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/x",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) expect(isPushServiceEndpoint(endpoint), endpoint).toBe(true);
    for (const endpoint of [
      "https://example.test/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com.example/x",
      "https://fcm.googleapis.com:8443/x",
      "http://fcm.googleapis.com/x",
      "https://127.0.0.1/x",
    ]) expect(isPushServiceEndpoint(endpoint), endpoint).toBe(false);
  });

  it("keeps account push when an unrelated session expires", async () => {
    const expiredTokenHash = `expired_${crypto.randomUUID()}`;
    const expiredSessionId = `ses_${crypto.randomUUID()}`;
    const pushSubscriptionId = `push_${crypto.randomUUID()}`;
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      expiredSessionId,
      session.userId,
      expiredTokenHash,
      now - 1,
      now - 60_000,
    ).run();
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      pushSubscriptionId,
      session.userId,
      endpoint,
      env.VAPID_PUBLIC_KEY,
      "AAAAAAAAAAAAAAAAAAAAAA",
    ).run();

    const login = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: session.userId }),
      }),
    );
    expect(login.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?",
      ).bind(expiredTokenHash).first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM push_subscriptions WHERE id = ?",
      ).bind(pushSubscriptionId).first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
  });

  it("defaults each accessible mailbox to enabled and stores a personal override", async () => {
    const { cookie, mailboxId } = session;
    const initial = await exports.default.fetch(
      new Request("http://example.test/api/notifications/preferences", {
        headers: { cookie },
      }),
    );
    expect(await initial.json()).toMatchObject({
      preferences: [{ mailboxId, enabled: true }],
    });

    const update = await exports.default.fetch(
      new Request(
        `http://example.test/api/notifications/preferences/${mailboxId}`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      ),
    );
    expect(update.status).toBe(200);

    const changed = await exports.default.fetch(
      new Request("http://example.test/api/notifications/preferences", {
        headers: { cookie },
      }),
    );
    expect(await changed.json()).toMatchObject({
      preferences: [{ mailboxId, enabled: false }],
    });
  });
});
