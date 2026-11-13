import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import * as oidcClient from "openid-client";
import { z } from "zod";

import { findCookie, requireCookie, sessionCookie } from "./cookies.ts";
import { env, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const issuer = "http://example.test";

/** The JSON body of a successful response, parsed with `schema`. */
async function json<S extends z.ZodType>(response: Response, schema: S) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBeLessThan(400);

  return schema.parse(body);
}

/** A body the test only needs to be a success. */
const anyBody = z.unknown();
const redirectBody = z.looseObject({ redirectTo: z.string() });
const authState = z.looseObject({ authenticated: z.boolean() });

const loginTransaction = z.looseObject({
  transaction: z.looseObject({ clientName: z.string() }),
});

/** Where a redirect response points. */
function locationOf(response: Response) {
  return required(response.headers.get("location"), "the response redirects");
}

/** The request id at the end of a consent or login location. */
function requestIdOf(location: string) {
  return required(location.split("/").at(-1), "the location ends in an id");
}

/**
 * openid-client's requests, sent to the stack. A byte body is copied onto an
 * ArrayBuffer of its own, the buffer type a Request body takes.
 */
const relyingPartyFetch: oidcClient.CustomFetch = (url, init) =>
  worker.fetch(
    new Request(url, {
      method: init.method,
      headers: init.headers,
      body:
        init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body,
      redirect: init.redirect,
      signal: init.signal,
    })
  );

type SessionRow = { id: string; token_hash: string; created_at: number };

function oidcTransactionCookieName(requestId: string) {
  return `op_oidc_${requestId}`;
}

describe("public OIDC clients", () => {
  it("exchanges a PKCE code without a client secret and allows registered CORS", async () => {
    const bootstrap = await worker.fetch(
      new Request(`${issuer}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Public Client Admin",
          email: "public@example.test",
        }),
      })
    );

    const cookie = sessionCookie(bootstrap);
    await json(bootstrap, anyBody);

    const state = await json(
      await worker.fetch(
        new Request(`${issuer}/api/admin/state`, {
          headers: { cookie },
        })
      ),
      z.object({ users: z.array(z.looseObject({ id: z.string() })) })
    );

    const [firstUser] = state.users;
    const userId = required(firstUser, "the workspace has a user").id;

    const registered = await json(
      await worker.fetch(
        new Request(`${issuer}/api/admin/oidc-clients`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Browser app",
            clientType: "public",
            accessTeams: [{ teamId: "team_everyone" }],
            redirectUris: ["https://spa.example.test/callback"],
            postLogoutRedirectUris: [],
            allowedOrigins: ["https://spa.example.test"],
            allowedScopes: ["openid", "profile"],
            trusted: false,
            enabled: true,
            assignedUserIds: [userId],
          }),
        })
      ),
      z.looseObject({
        clientId: z.string(),
        clientSecret: z.string().optional(),
      })
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
        [oidcClient.customFetch]: relyingPartyFetch,
      }
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

    const silent = await worker.fetch(
      new Request(silentUrl, { headers: { cookie }, redirect: "manual" })
    );

    expect(new URL(locationOf(silent)).searchParams.get("error")).toBe(
      "consent_required"
    );
    const malformedMaxAgeUrl = new URL(authorize);
    malformedMaxAgeUrl.searchParams.set("max_age", "1.5");

    const malformedMaxAge = await worker.fetch(
      new Request(malformedMaxAgeUrl, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    expect(new URL(locationOf(malformedMaxAge)).searchParams.get("error")).toBe(
      "invalid_request"
    );

    const combinedPromptUrl = new URL(authorize);
    combinedPromptUrl.searchParams.set("prompt", "login consent");

    const combinedPrompt = await worker.fetch(
      new Request(combinedPromptUrl, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    expect(combinedPrompt.headers.get("location")).toMatch(
      /^\/oidc\/login\/req_/u
    );

    const authorization = await worker.fetch(
      new Request(authorize, { headers: { cookie }, redirect: "manual" })
    );

    const consentLocation = locationOf(authorization);
    expect(consentLocation).toMatch(/^\/oidc\/consent\//u);
    const requestId = requestIdOf(consentLocation);

    const consent = await json(
      await worker.fetch(
        new Request(`${issuer}/api/oidc/consent/${requestId}`, {
          headers: { cookie },
        })
      ),
      z.object({
        request: z.looseObject({
          clientName: z.string(),
          scopes: z.array(z.looseObject({ id: z.string(), group: z.string() })),
        }),
      })
    );

    expect(consent.request).toMatchObject({
      clientName: "Browser app",
      scopes: [
        { id: "openid", group: "identity" },
        { id: "profile", group: "identity" },
      ],
      unavailableScopes: [],
    });

    const approval = await json(
      await worker.fetch(
        new Request(`${issuer}/api/oidc/consent/${requestId}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ approved: true }),
        })
      ),
      redirectBody
    );

    const token = await oidcClient.authorizationCodeGrant(
      relyingParty,
      new URL(approval.redirectTo),
      { pkceCodeVerifier: verifier }
    );

    expect(token.access_token).toBeTruthy();
    expect(token.id_token).toBeTruthy();

    await json(
      await worker.fetch(
        new Request(`${issuer}/api/admin/oidc-clients/${registered.clientId}`, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Browser app",
            clientType: "public",
            accessTeams: [{ teamId: "team_everyone" }],
            redirectUris: ["https://spa.example.test/callback"],
            postLogoutRedirectUris: [],
            allowedOrigins: ["https://spa.example.test"],
            allowedScopes: ["openid", "profile", "email"],
            trusted: false,
            enabled: true,
            assignedUserIds: [userId],
          }),
        })
      ),
      anyBody
    );
    const emailVerifier = oidcClient.randomPKCECodeVerifier();

    const emailAuthorize = oidcClient.buildAuthorizationUrl(relyingParty, {
      redirect_uri: "https://spa.example.test/callback",
      scope: "openid email",
      code_challenge:
        await oidcClient.calculatePKCECodeChallenge(emailVerifier),
      code_challenge_method: "S256",
    });

    const emailAuthorization = await worker.fetch(
      new Request(emailAuthorize, { headers: { cookie }, redirect: "manual" })
    );

    const emailConsentLocation = locationOf(emailAuthorization);
    expect(emailConsentLocation).toMatch(/^\/oidc\/consent\//u);
    const emailRequestId = requestIdOf(emailConsentLocation);
    await json(
      await worker.fetch(
        new Request(`${issuer}/api/oidc/consent/${emailRequestId}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ approved: true }),
        })
      ),
      anyBody
    );

    const silentUnion = new URL(
      oidcClient.buildAuthorizationUrl(relyingParty, {
        redirect_uri: "https://spa.example.test/callback",
        scope: "openid profile email",
        code_challenge: await oidcClient.calculatePKCECodeChallenge(
          oidcClient.randomPKCECodeVerifier()
        ),
        code_challenge_method: "S256",
        prompt: "none",
      })
    );

    const silentUnionResponse = await worker.fetch(
      new Request(silentUnion, { headers: { cookie }, redirect: "manual" })
    );

    expect(
      new URL(locationOf(silentUnionResponse)).searchParams.get("code")
    ).toBeTruthy();

    const preflight = await worker.fetch(
      new Request(`${issuer}/oauth/token`, {
        method: "OPTIONS",
        headers: { origin: "https://spa.example.test" },
      })
    );

    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://spa.example.test"
    );

    const freshVerifier = oidcClient.randomPKCECodeVerifier();

    const reauthenticationUrl = oidcClient.buildAuthorizationUrl(relyingParty, {
      redirect_uri: "https://spa.example.test/callback",
      scope: "openid profile",
      code_challenge:
        await oidcClient.calculatePKCECodeChallenge(freshVerifier),
      code_challenge_method: "S256",
      prompt: "login",
    });

    const reauthentication = await worker.fetch(
      new Request(reauthenticationUrl, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    const loginLocation = locationOf(reauthentication);
    expect(loginLocation).toMatch(/^\/oidc\/login\/req_/u);
    expect(loginLocation).not.toContain("force_login");
    const reauthRequestId = requestIdOf(loginLocation);

    const transactionCookie = findCookie(
      reauthentication,
      oidcTransactionCookieName(reauthRequestId)
    );

    expect(transactionCookie).toBeTruthy();

    const parallelReauthentication = await worker.fetch(
      new Request(reauthenticationUrl, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    const parallelLoginLocation = locationOf(parallelReauthentication);

    const parallelRequestId = requestIdOf(parallelLoginLocation);

    const parallelTransactionCookie = findCookie(
      parallelReauthentication,
      oidcTransactionCookieName(parallelRequestId)
    );

    expect(parallelTransactionCookie).toBeTruthy();
    expect(parallelTransactionCookie).not.toBe(transactionCookie);
    const transactionCookies = `${cookie}; ${transactionCookie}; ${parallelTransactionCookie}`;

    const unbound = await worker.fetch(
      new Request(`${issuer}/api/oidc/login/${reauthRequestId}`, {
        headers: { cookie },
      })
    );

    expect(unbound.status).toBe(400);
    await unbound.json();
    expect(
      await json(
        await worker.fetch(
          new Request(`${issuer}/api/oidc/login/${reauthRequestId}`, {
            headers: { cookie: transactionCookies },
          })
        ),
        loginTransaction
      )
    ).toMatchObject({ transaction: { clientName: "Browser app" } });
    expect(
      await json(
        await worker.fetch(
          new Request(`${issuer}/api/oidc/login/${parallelRequestId}`, {
            headers: { cookie: transactionCookies },
          })
        ),
        loginTransaction
      )
    ).toMatchObject({ transaction: { clientName: "Browser app" } });

    const originalSession = await env.DB.prepare(
      `SELECT session.id, session.token_hash, session.created_at
       FROM sessions session
       WHERE session.user_id = ? LIMIT 1`
    )
      .bind(userId)
      .first<SessionRow>();

    expect(originalSession).toBeTruthy();
    const pushSubscriptionId = `push_${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        pushSubscriptionId,
        userId,
        `https://push.example.test/${crypto.randomUUID()}`,
        "test-p256dh",
        "test-auth"
      )
      .run();

    const reauthenticated = await worker.fetch(
      new Request(`${issuer}/api/auth/mock/login`, {
        method: "POST",
        headers: {
          cookie: transactionCookies,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId,
          oidcRequestId: reauthRequestId,
        }),
      })
    );

    const continuation = await json(reauthenticated, redirectBody);
    expect(continuation.redirectTo).toBe(
      `/oauth/authorize/resume/${reauthRequestId}`
    );

    const reauthenticatedSession = sessionCookie(reauthenticated);
    expect(reauthenticatedSession).not.toBe(cookie);

    const refreshedSession = await env.DB.prepare(
      `SELECT session.id, session.token_hash, session.created_at
       FROM sessions session
       WHERE session.user_id = ?
       ORDER BY session.created_at DESC LIMIT 1`
    )
      .bind(userId)
      .first<SessionRow>();

    const before = required(originalSession, "the user had a session");
    const after = required(refreshedSession, "the user has a new session");
    expect(after.id).not.toBe(before.id);
    expect(after.token_hash).not.toBe(before.token_hash);
    expect(after.created_at).toBeGreaterThanOrEqual(before.created_at);

    const retainedPush = await env.DB.prepare(
      "SELECT user_id FROM push_subscriptions WHERE id = ?"
    )
      .bind(pushSubscriptionId)
      .first<{ user_id: string }>();

    expect(retainedPush?.user_id).toBe(userId);

    const staleSessionState = await worker.fetch(
      new Request(`${issuer}/api/bootstrap`, {
        headers: { cookie },
      })
    );

    expect(await json(staleSessionState.clone(), authState)).toMatchObject({
      authenticated: false,
    });
    expect(staleSessionState.headers.get("set-cookie")).toBeNull();
    expect(
      await json(
        await worker.fetch(
          new Request(`${issuer}/api/bootstrap`, {
            headers: { cookie: reauthenticatedSession },
          })
        ),
        authState
      )
    ).toMatchObject({ authenticated: true });

    const newSessionVerifier = oidcClient.randomPKCECodeVerifier();

    const newSessionUrl = oidcClient.buildAuthorizationUrl(relyingParty, {
      redirect_uri: "https://spa.example.test/callback",
      scope: "openid profile",
      code_challenge:
        await oidcClient.calculatePKCECodeChallenge(newSessionVerifier),
      code_challenge_method: "S256",
    });

    const newSessionAuthorization = await worker.fetch(
      new Request(newSessionUrl, { redirect: "manual" })
    );

    const newSessionLoginLocation = locationOf(newSessionAuthorization);

    expect(newSessionLoginLocation).toMatch(/^\/oidc\/login\/req_/u);
    const newSessionRequestId = requestIdOf(newSessionLoginLocation);

    const newSessionTransactionCookie = requireCookie(
      newSessionAuthorization,
      oidcTransactionCookieName(newSessionRequestId)
    );

    const newSessionLogin = await json(
      await worker.fetch(
        new Request(`${issuer}/api/auth/mock/login`, {
          method: "POST",
          headers: {
            cookie: newSessionTransactionCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            userId,
            oidcRequestId: newSessionRequestId,
          }),
        })
      ),
      redirectBody
    );

    expect(newSessionLogin.redirectTo).toBe(
      `/oauth/authorize/resume/${newSessionRequestId}`
    );

    const resumed = await worker.fetch(
      new Request(`${issuer}${continuation.redirectTo}`, {
        headers: { cookie: reauthenticatedSession },
        redirect: "manual",
      })
    );

    expect(resumed.status).toBe(302);
    expect(new URL(locationOf(resumed)).searchParams.get("code")).toBeTruthy();

    const replayedResume = await worker.fetch(
      new Request(`${issuer}${continuation.redirectTo}`, {
        headers: { cookie: reauthenticatedSession },
        redirect: "manual",
      })
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

    const maxAgeLogin = await worker.fetch(
      new Request(maxAgeUrl, {
        headers: { cookie: reauthenticatedSession },
        redirect: "manual",
      })
    );

    expect(maxAgeLogin.headers.get("location")).toMatch(
      /^\/oidc\/login\/req_/u
    );

    const logout = new URL(`${issuer}/oauth/logout`);
    logout.searchParams.set("client_id", registered.clientId);

    const logoutChallenge = await worker.fetch(
      new Request(logout, {
        headers: { cookie: reauthenticatedSession },
        redirect: "manual",
      })
    );

    expect(logoutChallenge.status).toBe(302);
    expect(new URL(locationOf(logoutChallenge)).pathname).toBe("/oidc/logout");
    expect(
      await json(
        await worker.fetch(
          new Request(`${issuer}/api/bootstrap`, {
            headers: { cookie: reauthenticatedSession },
          })
        ),
        authState
      )
    ).toMatchObject({ authenticated: true });
  });
});
