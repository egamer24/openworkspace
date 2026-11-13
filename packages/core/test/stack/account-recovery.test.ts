import { beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";
import { passkeyRegistration } from "../fixtures/passkey.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

const count = async (sql: string, ...params: string[]) =>
  required(
    await env.DB.prepare(sql)
      .bind(...params)
      .first<{ n: number }>(),
    "count(*) returns a row"
  ).n;

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

const accessLinkResponse = z.object({
  accessLink: z.object({ userId: z.string(), url: z.string() }),
});

const registrationStart = z.object({
  options: z.object({
    challenge: z.string(),
    rp: z.object({ id: z.string().optional() }),
  }),
  challengeId: z.string(),
});

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);
  adminCookie = sessionCookie(bootstrap);
});

describe("account recovery", () => {
  it("ends every session and every app's access, as disabling does", async () => {
    const invited = await call(adminCookie, "/api/admin/invitations", {
      method: "POST",
      json: { name: "Recovering", email: "recovering@example.test" },
    });

    const { userId } = accessLinkResponse.parse(
      await invited.json()
    ).accessLink;

    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
      .bind(userId)
      .run();

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      })
    );

    const oldCookie = sessionCookie(login);

    // An app the person signed in to, and a sign-in to a SAML app in progress.
    const client = await call(adminCookie, "/api/admin/oidc-clients", {
      method: "POST",
      json: {
        name: "Wiki",
        clientType: "public",
        accessTeams: [{ teamId: "team_everyone", sentAs: null }],
        redirectUris: ["https://wiki.example.net/callback"],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        allowedScopes: ["openid", "profile", "offline_access"],
        trusted: false,
        enabled: true,
      },
    });

    const { clientId } = z
      .object({ clientId: z.string() })
      .parse(await client.json());

    const now = Date.now();
    const later = now + 3_600_000;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO oidc_grants (client_id, user_id, scopes, granted_at, updated_at) VALUES (?, ?, '[\"openid\"]', ?, ?)"
      ).bind(clientId, userId, now, now),
      env.DB.prepare(`INSERT INTO oidc_access_tokens (token_hash, family_id, client_id, user_id, scopes, auth_time, expires_at, created_at)
        VALUES ('recovery-access', 'fam_recovery', ?, ?, '["openid"]', ?, ?, ?)`).bind(
        clientId,
        userId,
        now,
        later,
        now
      ),
      env.DB.prepare(`INSERT INTO oidc_refresh_tokens (token_hash, family_id, client_id, user_id, scopes, auth_time, expires_at, created_at)
        VALUES ('recovery-refresh', 'fam_recovery', ?, ?, '["openid"]', ?, ?, ?)`).bind(
        clientId,
        userId,
        now,
        later,
        now
      ),
      env.DB.prepare(`INSERT INTO oidc_authorization_codes (token_hash, client_id, user_id, redirect_uri, scopes, code_challenge, auth_time, expires_at, created_at)
        VALUES ('recovery-code', ?, ?, 'https://wiki.example.net/callback', '["openid"]', 'x', ?, ?, ?)`).bind(
        clientId,
        userId,
        now,
        later,
        now
      ),
      env.DB.prepare(`INSERT INTO oidc_authorization_requests (id, client_id, user_id, status, redirect_uri, scopes, code_challenge, expires_at, created_at)
        VALUES ('req_recovery', ?, ?, 'awaiting_consent', 'https://wiki.example.net/callback', '["openid"]', 'x', ?, ?)`).bind(
        clientId,
        userId,
        later,
        now
      ),
      env.DB.prepare(`INSERT INTO saml_applications (id, name, entity_id, acs_url, email_attribute_name, name_attribute_name, created_by_user_id, created_at, updated_at)
        VALUES ('sapp_recovery', 'Docs', 'https://docs.example.net', 'https://docs.example.net/acs', 'email', 'name', ?, ?, ?)`).bind(
        userId,
        now,
        now
      ),
      env.DB.prepare(`INSERT INTO saml_authn_requests (id, application_id, user_id, acs_url, status, expires_at, created_at)
        VALUES ('saml_recovery', 'sapp_recovery', ?, 'https://docs.example.net/acs', 'authenticated', ?, ?)`).bind(
        userId,
        later,
        now
      ),
    ]);

    const link = await call(
      adminCookie,
      `/api/admin/users/${userId}/access-link`,
      { method: "POST" }
    );

    expect(link.status).toBe(201);

    const token = required(
      new URL(
        accessLinkResponse.parse(await link.json()).accessLink.url
      ).pathname
        .split("/")
        .at(-1),
      "an access link ends in its token"
    );

    const options = await worker.fetch(
      new Request(`${origin}/api/auth/recovery/${token}/options`, {
        method: "POST",
      })
    );

    const started = registrationStart.parse(await options.json());

    expect(options.status).toBe(200);

    const verified = await worker.fetch(
      new Request(`${origin}/api/auth/recovery/${token}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          challengeId: started.challengeId,
          response: await passkeyRegistration(started.options, origin),
        }),
      })
    );

    expect(verified.status, await verified.clone().text()).toBe(200);
    const newCookie = sessionCookie(verified);

    // The old session is gone; the one recovery opened works.
    expect((await call(oldCookie, "/api/auth/sessions")).status).toBe(401);
    const sessions = await call(newCookie, "/api/auth/sessions");
    expect(sessions.status).toBe(200);
    await sessions.body?.cancel();
    expect(
      await count(
        "SELECT count(*) AS n FROM sessions WHERE user_id = ?",
        userId
      )
    ).toBe(1);

    const remaining = await Promise.all(
      [
        "oidc_grants",
        "oidc_access_tokens",
        "oidc_refresh_tokens",
        "oidc_authorization_codes",
        "oidc_authorization_requests",
        "saml_authn_requests",
      ].map(async (table) => ({
        table,
        rows: await count(
          `SELECT count(*) AS n FROM ${table} WHERE user_id = ?`,
          userId
        ),
      }))
    );

    for (const { table, rows } of remaining) expect(rows, table).toBe(0);

    expect(
      await count(
        "SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?",
        userId
      )
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM access_links WHERE user_id = ? AND consumed_at IS NULL",
        userId
      )
    ).toBe(0);
  });
});
