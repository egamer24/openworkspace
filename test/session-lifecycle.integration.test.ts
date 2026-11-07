import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken } from "../worker/lib/crypto";

const DAY_MS = 24 * 60 * 60 * 1_000;

function responseCookie(response: Response, name: string) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  return values
    .map((value) => value.split(";", 1)[0]!)
    .find((value) => value.startsWith(`${name}=`));
}

async function createUser(name: string) {
  const userId = `usr_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO users (id, name, role, status) VALUES (?, ?, 'member', 'active')",
  ).bind(userId, name).run();
  return userId;
}

async function login(
  userId: string,
  options: { cookie?: string; userAgent?: string } = {},
) {
  const response = await exports.default.fetch(
    new Request("http://example.test/api/auth/mock/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
        "cf-ipcountry": "RS",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ userId }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = responseCookie(response, "op_session");
  expect(cookie).toBeTruthy();
  return cookie!;
}

async function sessionForCookie(cookie: string) {
  const token = cookie.slice(cookie.indexOf("=") + 1);
  return env.DB.prepare(`
    SELECT id, user_id AS userId, expires_at AS expiresAt,
           user_agent AS userAgent, location, ip_address AS ipAddress
    FROM sessions
    WHERE token_hash = ?
  `).bind(await hashToken(token)).first<{
    id: string;
    userId: string;
    expiresAt: number;
    userAgent: string | null;
    location: string | null;
    ipAddress: string | null;
  }>();
}

async function bindPush(cookie: string, endpoint: string) {
  const response = await exports.default.fetch(
    new Request("http://example.test/api/notifications/subscriptions", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint,
        keys: {
          p256dh: env.VAPID_PUBLIC_KEY,
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
}

describe("session and push ownership", () => {
  it("stores sign-in metadata and renews the D1 lease without rotating the cookie", async () => {
    const userId = await createUser("Renewal User");
    const cookie = await login(userId, { userAgent: "Session Test Desktop" });
    const stored = await sessionForCookie(cookie);
    expect(stored).toMatchObject({
      userId,
      userAgent: "Session Test Desktop",
      location: "RS",
      ipAddress: "203.0.113.10",
    });

    const nearExpiry = Date.now() + DAY_MS;
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(nearExpiry, stored!.id)
      .run();
    const renewedAt = Date.now();
    const response = await exports.default.fetch(
      new Request("http://example.test/api/auth/state", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const renewed = await sessionForCookie(cookie);
    expect(renewed!.expiresAt).toBeGreaterThanOrEqual(renewedAt + 30 * DAY_MS);
  });

  it("replaces the current browser session after a fresh sign-in", async () => {
    const userId = await createUser("Reauthentication User");
    const firstCookie = await login(userId);
    const secondCookie = await login(userId, { cookie: firstCookie });

    const oldState = await exports.default.fetch(
      new Request("http://example.test/api/auth/state", {
        headers: { cookie: firstCookie },
      }),
    ).then((response) => response.json() as Promise<{ authenticated: boolean }>);
    const newState = await exports.default.fetch(
      new Request("http://example.test/api/auth/state", {
        headers: { cookie: secondCookie },
      }),
    ).then((response) => response.json() as Promise<{ authenticated: boolean }>);
    expect(oldState.authenticated).toBe(false);
    expect(newState.authenticated).toBe(true);
  });

  it("keeps at most ten sessions per user", async () => {
    const userId = await createUser("Session Limit User");
    for (let index = 0; index < 11; index += 1) {
      await login(userId, { userAgent: `Browser ${index}` });
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
    ).bind(userId).first<{ count: number }>();
    expect(count?.count).toBe(10);
  });

  it("atomically transfers an endpoint to the currently authenticated account", async () => {
    const firstUserId = await createUser("First Push User");
    const secondUserId = await createUser("Second Push User");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    await bindPush(await login(firstUserId), endpoint);
    await bindPush(await login(secondUserId), endpoint);

    const owner = await env.DB.prepare(
      "SELECT user_id AS userId FROM push_subscriptions WHERE endpoint = ?",
    ).bind(endpoint).first<{ userId: string }>();
    expect(owner?.userId).toBe(secondUserId);
  });

  it("drops push registered by a revoked session and detaches it on explicit logout", async () => {
    const userId = await createUser("Push Lifecycle User");
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const firstCookie = await login(userId);
    await bindPush(firstCookie, endpoint);
    const firstSession = await sessionForCookie(firstCookie);

    const revoke = await exports.default.fetch(
      new Request(`http://example.test/api/auth/sessions/${firstSession!.id}`, {
        method: "DELETE",
        headers: { cookie: firstCookie },
      }),
    );
    expect(revoke.status).toBe(200);
    // Whoever held the revoked session could have registered their own endpoint.
    expect(
      await env.DB.prepare(
        "SELECT id FROM push_subscriptions WHERE endpoint = ?",
      ).bind(endpoint).first(),
    ).toBeNull();

    const secondCookie = await login(userId);
    await bindPush(secondCookie, endpoint);
    const logout = await exports.default.fetch(
      new Request("http://example.test/api/auth/logout", {
        method: "POST",
        headers: { cookie: secondCookie, "content-type": "application/json" },
        body: JSON.stringify({ pushEndpoint: endpoint }),
      }),
    );
    expect(logout.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT id FROM push_subscriptions WHERE endpoint = ?",
      ).bind(endpoint).first(),
    ).toBeNull();
  });
});
