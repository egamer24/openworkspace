import { describe, expect, it } from "bun:test";

import { hashToken } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, hooks, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const DAY_MS = 24 * 60 * 60 * 1000;

const authState = z.looseObject({ authenticated: z.boolean() });

async function createUser(name: string, role: "admin" | "member" = "member") {
  const userId = `usr_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO users (id, name, role, status) VALUES (?, ?, ?, 'active')"
  )
    .bind(userId, name, role)
    .run();

  return userId;
}

async function login(
  userId: string,
  options: { cookie?: string; userAgent?: string } = {}
) {
  const headers = new Headers({
    "content-type": "application/json",
    "cf-ipcountry": "RS",
    "cf-connecting-ip": "203.0.113.10",
  });

  if (options.cookie) headers.set("cookie", options.cookie);

  if (options.userAgent) headers.set("user-agent", options.userAgent);

  const response = await worker.fetch(
    new Request("http://example.test/api/auth/mock/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ userId }),
    })
  );

  expect(response.status).toBe(200);

  return sessionCookie(response);
}

async function sessionForCookie(cookie: string) {
  const token = cookie.slice(cookie.indexOf("=") + 1);

  return env.DB.prepare(`
    SELECT id, user_id AS userId, expires_at AS expiresAt,
           user_agent AS userAgent, location, ip_address AS ipAddress
    FROM sessions
    WHERE token_hash = ?
  `)
    .bind(await hashToken(token))
    .first<{
      id: string;
      userId: string;
      expiresAt: number;
      userAgent: string | null;
      location: string | null;
      ipAddress: string | null;
    }>();
}

async function bindPush(cookie: string, endpoint: string) {
  const { VAPID_PUBLIC_KEY } = await hooks.env("VAPID_PUBLIC_KEY");

  const response = await worker.fetch(
    new Request("http://example.test/api/notifications/subscriptions", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint,
        keys: {
          p256dh: VAPID_PUBLIC_KEY,
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    })
  );

  expect(response.status).toBe(200);
}

describe("session and push ownership", () => {
  it("stores sign-in metadata and renews the D1 lease without rotating the cookie", async () => {
    const userId = await createUser("Renewal User");
    const cookie = await login(userId, { userAgent: "Session Test Desktop" });

    const stored = required(
      await sessionForCookie(cookie),
      "the sign-in stores a session"
    );

    expect(stored).toMatchObject({
      userId,
      userAgent: "Session Test Desktop",
      ipAddress: "203.0.113.10",
    });
    // The runtime always attaches request.cf (the local one, Cloudflare's
    // own for the developer's address), so the location is its city, region,
    // and country rather than the cf-ipcountry header's fallback.
    expect(stored.location).toMatch(/^(?:[^,]+, )*[A-Z]{2}$/u);

    const nearExpiry = Date.now() + DAY_MS;
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(nearExpiry, stored.id)
      .run();
    const renewedAt = Date.now();

    const response = await worker.fetch(
      new Request("http://example.test/api/bootstrap", {
        headers: { cookie },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();

    const renewed = required(
      await sessionForCookie(cookie),
      "the session is still stored"
    );

    expect(renewed.expiresAt).toBeGreaterThanOrEqual(renewedAt + 30 * DAY_MS);
  });

  it("replaces the current browser session after a fresh sign-in", async () => {
    const userId = await createUser("Reauthentication User");
    const firstCookie = await login(userId);
    const secondCookie = await login(userId, { cookie: firstCookie });

    const oldState = await worker
      .fetch(
        new Request("http://example.test/api/bootstrap", {
          headers: { cookie: firstCookie },
        })
      )
      .then((response) => readJson(response, authState));

    const newState = await worker
      .fetch(
        new Request("http://example.test/api/bootstrap", {
          headers: { cookie: secondCookie },
        })
      )
      .then((response) => readJson(response, authState));

    expect(oldState.authenticated).toBe(false);
    expect(newState.authenticated).toBe(true);
  });

  it("keeps at most ten sessions per user", async () => {
    const userId = await createUser("Session Limit User");

    for (let index = 0; index < 11; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each sign-in must land after the last, so the eleventh evicts the oldest
      await login(userId, { userAgent: `Browser ${index}` });
    }

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ count: number }>();

    expect(count?.count).toBe(10);
  });

  it("atomically transfers an endpoint to the currently authenticated account", async () => {
    const firstUserId = await createUser("First Push User");
    const secondUserId = await createUser("Second Push User");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    await bindPush(await login(firstUserId), endpoint);
    await bindPush(await login(secondUserId), endpoint);

    const owner = await env.DB.prepare(
      "SELECT user_id AS userId FROM push_subscriptions WHERE endpoint = ?"
    )
      .bind(endpoint)
      .first<{ userId: string }>();

    expect(owner?.userId).toBe(secondUserId);
  });

  it("rejects push endpoints that aren't public HTTPS URLs", async () => {
    const { VAPID_PUBLIC_KEY } = await hooks.env("VAPID_PUBLIC_KEY");
    const cookie = await login(await createUser("Relay User"));

    const endpoints = [
      "http://fcm.googleapis.com/fcm/send/1",
      "https://localhost/relay",
      "https://10.0.0.5/relay",
      "https://[::1]/relay",
      "https://metadata.google.internal/relay",
      "https://user:secret@push.example.com/relay",
    ];

    const statuses = await Promise.all(
      endpoints.map(async (endpoint) => {
        const response = await worker.fetch(
          new Request("http://example.test/api/notifications/subscriptions", {
            method: "PUT",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({
              endpoint,
              keys: {
                p256dh: VAPID_PUBLIC_KEY,
                auth: "AAAAAAAAAAAAAAAAAAAAAA",
              },
            }),
          })
        );

        return response.status;
      })
    );

    expect(statuses).toEqual(endpoints.map(() => 400));
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM push_subscriptions WHERE endpoint IN (?, ?, ?, ?, ?, ?)"
      )
        .bind(...endpoints)
        .first()
    ).toMatchObject({ count: 0 });
  });

  it("accepts browser push services and a self-hosted one", async () => {
    const cookie = await login(await createUser("Browser User"));
    const id = crypto.randomUUID();

    await bindPush(cookie, `https://fcm.googleapis.com/fcm/send/${id}`);
    await bindPush(
      cookie,
      `https://updates.push.services.mozilla.com/wpush/v2/${id}`
    );
    await bindPush(cookie, `https://web.push.apple.com/${id}`);
    await bindPush(
      cookie,
      `https://wns2-par02p.notify.windows.com/w/?token=${id}`
    );
    // A self-hosted Mozilla autopush, set in Firefox's about:config.
    await bindPush(cookie, `https://push.example.com/wpush/v2/${id}`);
  });

  it("removes only the revoked session's push, as the user or an admin", async () => {
    const userId = await createUser("Push Lifecycle User");
    const adminCookie = await login(await createUser("Session Admin", "admin"));

    const devices = await Promise.all(
      ["laptop", "phone", "tablet"].map(async (device) => {
        const cookie = await login(userId, { userAgent: device });
        const endpoint = `https://fcm.googleapis.com/fcm/send/${device}-${crypto.randomUUID()}`;
        await bindPush(cookie, endpoint);

        const session = required(
          await sessionForCookie(cookie),
          "each sign-in stores a session"
        );

        return { cookie, endpoint, sessionId: session.id };
      })
    );

    const laptop = required(devices[0], "the laptop signed in");
    const phone = required(devices[1], "the phone signed in");
    const tablet = required(devices[2], "the tablet signed in");

    expect(
      await env.DB.prepare(
        "SELECT session_id AS sessionId FROM push_subscriptions WHERE endpoint = ?"
      )
        .bind(laptop.endpoint)
        .first()
    ).toEqual({ sessionId: laptop.sessionId });

    const revoke = await worker.fetch(
      new Request(`http://example.test/api/auth/sessions/${laptop.sessionId}`, {
        method: "DELETE",
        headers: { cookie: tablet.cookie },
      })
    );

    expect(revoke.status).toBe(200);

    const adminRevoke = await worker.fetch(
      new Request(
        `http://example.test/api/admin/users/${userId}/sessions/${phone.sessionId}`,
        { method: "DELETE", headers: { cookie: adminCookie } }
      )
    );

    expect(adminRevoke.status).toBe(200);

    const remaining = await env.DB.prepare(
      "SELECT endpoint FROM push_subscriptions WHERE user_id = ?"
    )
      .bind(userId)
      .all();

    expect(remaining.results).toEqual([{ endpoint: tablet.endpoint }]);
  });

  it("keeps a device's push when its session expires, is replaced or pruned", async () => {
    const userId = await createUser("Long-lived Push User");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const firstCookie = await login(userId);
    await bindPush(firstCookie, endpoint);

    const first = required(
      await sessionForCookie(firstCookie),
      "the first sign-in stores a session"
    );

    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, first.id)
      .run();

    // A fresh sign-in on the device deletes its previous session row.
    const secondCookie = await login(userId, { cookie: firstCookie });

    const second = required(
      await sessionForCookie(secondCookie),
      "the second sign-in stores a session"
    );

    const subscription = env.DB.prepare(
      "SELECT session_id AS sessionId FROM push_subscriptions WHERE endpoint = ?"
    ).bind(endpoint);

    expect(await subscription.first()).toEqual({ sessionId: first.id });

    // What the app does on every start: the row follows the new session.
    await bindPush(secondCookie, endpoint);

    expect(await subscription.first()).toEqual({ sessionId: second.id });

    for (let index = 0; index < 10; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each sign-in must land after the last, so the tenth evicts the device's session
      await login(userId);
    }

    expect(await sessionForCookie(secondCookie)).toBeNull();
    expect(await subscription.first()).toEqual({ sessionId: second.id });
  });

  it("drops a session's push when it signs out", async () => {
    const userId = await createUser("Sign-out User");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const cookie = await login(userId);
    await bindPush(cookie, endpoint);

    const logout = await worker.fetch(
      new Request("http://example.test/api/auth/logout", {
        method: "POST",
        headers: { cookie },
      })
    );

    expect(logout.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT id FROM push_subscriptions WHERE endpoint = ?"
      )
        .bind(endpoint)
        .first()
    ).toBeNull();
  });
});
