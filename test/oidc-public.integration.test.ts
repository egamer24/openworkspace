import { env, exports } from "cloudflare:workers";
import * as oidcClient from "openid-client";
import { describe, expect, it } from "vitest";

const issuer = "http://example.test";

async function json<T>(response: Response) {
  const body = await response.json<T>();
  expect(response.status, JSON.stringify(body)).toBeLessThan(400);
  return body;
}

function responseCookie(response: Response, name: string) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  return values
    .map((value) => value.split(";", 1)[0]!)
    .find((value) => value.startsWith(`${name}=`));
}

function oidcTransactionCookieName(requestId: string) {
  return `op_oidc_${requestId}`;
}

describe("public OIDC clients", () => {
  it("exchanges a PKCE code without a client secret and allows registered CORS", async () => {
    const bootstrap = await exports.default.fetch(
      new Request(`${issuer}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Public Client Admin",
          email: "public@example.test",
        }),
      }),
    );
    const cookie = responseCookie(bootstrap, "op_session")!;
    await json(bootstrap);
    const state = await json<{ users: Array<{ id: string }> }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/state`, {
          headers: { cookie },
        }),
      ),
    );
    const registered = await json<{
      clientId: string;
      clientSecret?: string;
    }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/oidc-clients`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Browser app",
            clientType: "public",
            accessPolicy: "selected_users",
            redirectUris: ["https://spa.example.test/callback"],
            postLogoutRedirectUris: [],
            allowedOrigins: ["https://spa.example.test"],
            allowedScopes: ["openid", "profile"],
            trusted: false,
            enabled: true,
            assignedUserIds: [state.users[0]!.id],
            exposedGroupIds: [],
          }),
        }),
      ),
    );
    expect(registered.clientSecret).toBeUndefined();

    const relyingParty = await oidcClient.discovery(
      new URL(issuer),
      registered.clientId,
      {
        redirect_uris: ["https://spa.example.test/callback"],
        token_endpoint_auth_method: "none",
      },
      oidcClient.None(),
      {
        execute: [oidcClient.allowInsecureRequests],
        [oidcClient.customFetch]: (input, init) =>
          exports.default.fetch(new Request(input, init as RequestInit)),
      },
    );
    const verifier = oidcClient.randomPKCECodeVerifier();
    const authorize = oidcClient.buildAuthorizationUrl(relyingParty, {
      redirect_uri: "https://spa.example.test/callback",
      scope: "openid profile",
      code_challenge: await oidcClient.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    const silentUrl = new URL(authorize);
    silentUrl.searchParams.set("prompt", "none");
    const silent = await exports.default.fetch(
      new Request(silentUrl, { headers: { cookie }, redirect: "manual" }),
    );
    expect(
      new URL(silent.headers.get("location")!).searchParams.get("error"),
    ).toBe("consent_required");
    const malformedMaxAgeUrl = new URL(authorize);
    malformedMaxAgeUrl.searchParams.set("max_age", "1.5");
    const malformedMaxAge = await exports.default.fetch(
      new Request(malformedMaxAgeUrl, {
        headers: { cookie },
        redirect: "manual",
      }),
    );
    expect(
      new URL(malformedMaxAge.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBe("invalid_request");

    const combinedPromptUrl = new URL(authorize);
    combinedPromptUrl.searchParams.set("prompt", "login consent");
    const combinedPrompt = await exports.default.fetch(
      new Request(combinedPromptUrl, {
        headers: { cookie },
        redirect: "manual",
      }),
    );
    expect(combinedPrompt.headers.get("location")).toMatch(
      /^\/oidc\/login\/req_/u,
    );

    const authorization = await exports.default.fetch(
      new Request(authorize, { headers: { cookie }, redirect: "manual" }),
    );
    const consentLocation = authorization.headers.get("location")!;
    expect(consentLocation).toMatch(/^\/oidc\/consent\//u);
    const requestId = consentLocation.split("/").at(-1)!;
    const consent = await json<{
      request: { clientName: string; scopes: string[] };
    }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/oidc/consent/${requestId}`, {
          headers: { cookie },
        }),
      ),
    );
    expect(consent.request).toMatchObject({
      clientName: "Browser app",
      scopes: ["openid", "profile"],
    });
    const approval = await json<{ redirectTo: string }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/oidc/consent/${requestId}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ approved: true }),
        }),
      ),
    );
    const token = await oidcClient.authorizationCodeGrant(
      relyingParty,
      new URL(approval.redirectTo),
      { pkceCodeVerifier: verifier },
    );
    expect(token.access_token).toBeTruthy();
    expect(token.id_token).toBeTruthy();

    await json(
      await exports.default.fetch(
        new Request(
          `${issuer}/api/admin/oidc-clients/${registered.clientId}`,
          {
            method: "PATCH",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({
              name: "Browser app",
              clientType: "public",
              accessPolicy: "selected_users",
              redirectUris: ["https://spa.example.test/callback"],
              postLogoutRedirectUris: [],
              allowedOrigins: ["https://spa.example.test"],
              allowedScopes: ["openid", "profile", "email"],
              trusted: false,
              enabled: true,
              assignedUserIds: [state.users[0]!.id],
              exposedGroupIds: [],
            }),
          },
        ),
      ),
    );
    const emailVerifier = oidcClient.randomPKCECodeVerifier();
    const emailAuthorize = oidcClient.buildAuthorizationUrl(relyingParty, {
      redirect_uri: "https://spa.example.test/callback",
      scope: "openid email",
      code_challenge:
        await oidcClient.calculatePKCECodeChallenge(emailVerifier),
      code_challenge_method: "S256",
    });
    const emailAuthorization = await exports.default.fetch(
      new Request(emailAuthorize, { headers: { cookie }, redirect: "manual" }),
    );
    const emailConsentLocation = emailAuthorization.headers.get("location")!;
    expect(emailConsentLocation).toMatch(/^\/oidc\/consent\//u);
    const emailRequestId = emailConsentLocation.split("/").at(-1)!;
    await json(
      await exports.default.fetch(
        new Request(`${issuer}/api/oidc/consent/${emailRequestId}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ approved: true }),
        }),
      ),
    );
    const silentUnion = new URL(
      oidcClient.buildAuthorizationUrl(relyingParty, {
        redirect_uri: "https://spa.example.test/callback",
        scope: "openid profile email",
        code_challenge: await oidcClient.calculatePKCECodeChallenge(
          oidcClient.randomPKCECodeVerifier(),
        ),
        code_challenge_method: "S256",
        prompt: "none",
      }),
    );
    const silentUnionResponse = await exports.default.fetch(
      new Request(silentUnion, { headers: { cookie }, redirect: "manual" }),
    );
    expect(
      new URL(silentUnionResponse.headers.get("location")!).searchParams.get(
        "code",
      ),
    ).toBeTruthy();

    const preflight = await exports.default.fetch(
      new Request(`${issuer}/oauth/token`, {
        method: "OPTIONS",
        headers: { origin: "https://spa.example.test" },
      }),
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://spa.example.test",
    );

    const freshVerifier = oidcClient.randomPKCECodeVerifier();
    const reauthenticationUrl = oidcClient.buildAuthorizationUrl(
      relyingParty,
      {
        redirect_uri: "https://spa.example.test/callback",
        scope: "openid profile",
        code_challenge:
          await oidcClient.calculatePKCECodeChallenge(freshVerifier),
        code_challenge_method: "S256",
        prompt: "login",
      },
    );
    const reauthentication = await exports.default.fetch(
      new Request(reauthenticationUrl, {
        headers: { cookie },
        redirect: "manual",
      }),
    );
    const loginLocation = reauthentication.headers.get("location")!;
    expect(loginLocation).toMatch(/^\/oidc\/login\/req_/u);
    expect(loginLocation).not.toContain("force_login");
    const reauthRequestId = loginLocation.split("/").at(-1)!;
    const transactionCookie = responseCookie(
      reauthentication,
      oidcTransactionCookieName(reauthRequestId),
    );
    expect(transactionCookie).toBeTruthy();
    const parallelReauthentication = await exports.default.fetch(
      new Request(reauthenticationUrl, {
        headers: { cookie },
        redirect: "manual",
      }),
    );
    const parallelLoginLocation = parallelReauthentication.headers.get("location")!;
    const parallelRequestId = parallelLoginLocation.split("/").at(-1)!;
    const parallelTransactionCookie = responseCookie(
      parallelReauthentication,
      oidcTransactionCookieName(parallelRequestId),
    );
    expect(parallelTransactionCookie).toBeTruthy();
    expect(parallelTransactionCookie).not.toBe(transactionCookie);
    const transactionCookies =
      `${cookie}; ${transactionCookie}; ${parallelTransactionCookie}`;

    const unbound = await exports.default.fetch(
      new Request(`${issuer}/api/oidc/login/${reauthRequestId}`, {
        headers: { cookie },
      }),
    );
    expect(unbound.status).toBe(400);
    await unbound.json();
    expect(
      await json<{ transaction: { clientName: string } }>(
        await exports.default.fetch(
          new Request(`${issuer}/api/oidc/login/${reauthRequestId}`, {
            headers: { cookie: transactionCookies },
          }),
        ),
      ),
    ).toMatchObject({ transaction: { clientName: "Browser app" } });
    expect(
      await json<{ transaction: { clientName: string } }>(
        await exports.default.fetch(
          new Request(`${issuer}/api/oidc/login/${parallelRequestId}`, {
            headers: { cookie: transactionCookies },
          }),
        ),
      ),
    ).toMatchObject({ transaction: { clientName: "Browser app" } });

    const originalSession = await env.DB.prepare(
      `SELECT session.id, session.token_hash, session.created_at
       FROM sessions session
       WHERE session.user_id = ? LIMIT 1`,
    ).bind(state.users[0]!.id).first<{
      id: string;
      token_hash: string;
      created_at: number;
    }>();
    expect(originalSession).toBeTruthy();
    const pushSubscriptionId = `push_${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      pushSubscriptionId,
      state.users[0]!.id,
      `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
      "test-p256dh",
      "test-auth",
    ).run();

    const reauthenticated = await exports.default.fetch(
      new Request(`${issuer}/api/auth/mock/login`, {
        method: "POST",
        headers: {
          cookie: transactionCookies,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: state.users[0]!.id,
          oidcRequestId: reauthRequestId,
        }),
      }),
    );
    const continuation = await json<{ redirectTo: string }>(reauthenticated);
    expect(continuation.redirectTo).toBe(
      `/oauth/authorize/resume/${reauthRequestId}`,
    );
    const reauthenticatedSession = responseCookie(reauthenticated, "op_session");
    expect(reauthenticatedSession).toBeTruthy();
    expect(reauthenticatedSession).not.toBe(cookie);
    const refreshedSession = await env.DB.prepare(
      `SELECT session.id, session.token_hash, session.created_at
       FROM sessions session
       WHERE session.user_id = ?
       ORDER BY session.created_at DESC LIMIT 1`,
    ).bind(state.users[0]!.id).first<{
      id: string;
      token_hash: string;
      created_at: number;
    }>();
    expect(refreshedSession!.id).not.toBe(originalSession!.id);
    expect(refreshedSession!.token_hash).not.toBe(originalSession!.token_hash);
    expect(refreshedSession!.created_at).toBeGreaterThanOrEqual(
      originalSession!.created_at,
    );
    const retainedPush = await env.DB.prepare(
      "SELECT user_id FROM push_subscriptions WHERE id = ?",
    ).bind(pushSubscriptionId).first<{ user_id: string }>();
    expect(retainedPush?.user_id).toBe(state.users[0]!.id);
    const staleSessionState = await exports.default.fetch(
      new Request(`${issuer}/api/auth/state`, {
        headers: { cookie },
      }),
    );
    expect(
      await json<{ authenticated: boolean }>(staleSessionState.clone()),
    ).toMatchObject({ authenticated: false });
    expect(staleSessionState.headers.get("set-cookie")).toBeNull();
    expect(
      await json<{ authenticated: boolean }>(
        await exports.default.fetch(
          new Request(`${issuer}/api/auth/state`, {
            headers: { cookie: reauthenticatedSession! },
          }),
        ),
      ),
    ).toMatchObject({ authenticated: true });

    const newSessionVerifier = oidcClient.randomPKCECodeVerifier();
    const newSessionUrl = oidcClient.buildAuthorizationUrl(relyingParty, {
      redirect_uri: "https://spa.example.test/callback",
      scope: "openid profile",
      code_challenge:
        await oidcClient.calculatePKCECodeChallenge(newSessionVerifier),
      code_challenge_method: "S256",
    });
    const newSessionAuthorization = await exports.default.fetch(
      new Request(newSessionUrl, { redirect: "manual" }),
    );
    const newSessionLoginLocation = newSessionAuthorization.headers.get("location")!;
    expect(newSessionLoginLocation).toMatch(/^\/oidc\/login\/req_/u);
    const newSessionRequestId = newSessionLoginLocation.split("/").at(-1)!;
    const newSessionTransactionCookie = responseCookie(
      newSessionAuthorization,
      oidcTransactionCookieName(newSessionRequestId),
    );
    const newSessionLogin = await json<{ redirectTo: string }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/auth/mock/login`, {
          method: "POST",
          headers: {
            cookie: newSessionTransactionCookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            userId: state.users[0]!.id,
            oidcRequestId: newSessionRequestId,
          }),
        }),
      ),
    );
    expect(newSessionLogin.redirectTo).toBe(
      `/oauth/authorize/resume/${newSessionRequestId}`,
    );

    const resumed = await exports.default.fetch(
      new Request(`${issuer}${continuation.redirectTo}`, {
        headers: { cookie: reauthenticatedSession! },
        redirect: "manual",
      }),
    );
    expect(resumed.status).toBe(302);
    expect(new URL(resumed.headers.get("location")!).searchParams.get("code"))
      .toBeTruthy();
    const replayedResume = await exports.default.fetch(
      new Request(`${issuer}${continuation.redirectTo}`, {
        headers: { cookie: reauthenticatedSession! },
        redirect: "manual",
      }),
    );
    expect(replayedResume.status).toBe(400);
    await replayedResume.json();

    const maxAgeVerifier = oidcClient.randomPKCECodeVerifier();
    const maxAgeUrl = oidcClient.buildAuthorizationUrl(relyingParty, {
      redirect_uri: "https://spa.example.test/callback",
      scope: "openid profile",
      code_challenge:
        await oidcClient.calculatePKCECodeChallenge(maxAgeVerifier),
      code_challenge_method: "S256",
      max_age: "0",
    });
    const maxAgeLogin = await exports.default.fetch(
      new Request(maxAgeUrl, {
        headers: { cookie: reauthenticatedSession! },
        redirect: "manual",
      }),
    );
    expect(maxAgeLogin.headers.get("location")).toMatch(
      /^\/oidc\/login\/req_/u,
    );

    const logout = new URL(`${issuer}/oauth/logout`);
    logout.searchParams.set("client_id", registered.clientId);
    const logoutChallenge = await exports.default.fetch(
      new Request(logout, {
        headers: { cookie: reauthenticatedSession! },
        redirect: "manual",
      }),
    );
    expect(logoutChallenge.status).toBe(302);
    expect(new URL(logoutChallenge.headers.get("location")!).pathname).toBe(
      "/oidc/logout",
    );
    expect(
      await json<{ authenticated: boolean }>(
        await exports.default.fetch(
          new Request(`${issuer}/api/auth/state`, {
            headers: { cookie: reauthenticatedSession! },
          }),
        ),
      ),
    ).toMatchObject({ authenticated: true });
  });
});
