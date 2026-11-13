import { describe, expect, it } from "bun:test";

import { importJWK, jwtVerify } from "jose";
import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { useFreshWorkspace, worker } from "../../testing/client.ts";
import { hashToken, randomToken } from "../../worker/lib/crypto.ts";

useFreshWorkspace();

const issuer = "http://example.test";
const redirectUri = "https://app.example.test/callback";

/** The response's text, once it is a success. */
async function expectOk(response: Response) {
  const text = await response.text();
  expect(response.status, text).toBeLessThan(400);

  return text;
}

/** A successful response's JSON body, parsed by `schema`. */
async function json<T>(response: Response, schema: z.ZodType<T>) {
  return schema.parse(JSON.parse(await expectOk(response)));
}

/** A redirect's Location as a URL. */
const location = (response: Response) =>
  new URL(required(response.headers.get("location"), "a redirect"));

const codeFrom = (response: Response) =>
  required(
    location(response).searchParams.get("code"),
    "authorize redirects with a code"
  );

const signedIn = z.object({ authenticated: z.boolean() });

const tokens = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

const jwk = z.looseObject({
  kty: z.string(),
  n: z.string(),
  e: z.string(),
  alg: z.string().optional(),
  kid: z.string().optional(),
});

describe("OIDC provider", () => {
  it("issues, filters, rotates, revokes, and discovers standards endpoints", async () => {
    const bootstrap = await worker.fetch(
      new Request(`${issuer}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "OIDC Admin",
          email: "oidc-admin@example.test",
        }),
      })
    );

    const cookie = required(
      bootstrap.headers.get("set-cookie")?.split(";", 1)[0],
      "sign-up sets a session cookie"
    );

    expect(cookie).toBeTruthy();
    await expectOk(bootstrap);

    const adminState = await json(
      await worker.fetch(
        new Request(`${issuer}/api/admin/state`, {
          headers: { cookie },
        })
      ),
      z.object({
        users: z.array(z.object({ id: z.string(), status: z.string() })),
      })
    );

    const userId = required(
      adminState.users[0],
      "the administrator is listed"
    ).id;

    const visibleGroup = await json(
      await worker.fetch(
        new Request(`${issuer}/api/admin/teams`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Grafana administrators",
            slug: "grafana-admins",
            description: null,
            members: [{ userId, canSend: true }],
          }),
        })
      ),
      z.object({ teamId: z.string() })
    );

    await expectOk(
      await worker.fetch(
        new Request(`${issuer}/api/admin/teams`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Finance",
            slug: "finance",
            description: null,
            members: [{ userId, canSend: true }],
          }),
        })
      )
    );

    const clientInput = {
      name: "Grafana",
      clientType: "confidential",
      accessTeams: [
        { teamId: visibleGroup.teamId, sentAs: "grafana-admins" },
        { teamId: "team_everyone" },
      ],
      redirectUris: [redirectUri],
      postLogoutRedirectUris: ["https://app.example.test/logout"],
      allowedOrigins: [],
      allowedScopes: ["openid", "profile", "email", "groups", "offline_access"],
      trusted: true,
      enabled: true,
    };

    const registered = await json(
      await worker.fetch(
        new Request(`${issuer}/api/admin/oidc-clients`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify(clientInput),
        })
      ),
      z.object({ clientId: z.string(), clientSecret: z.string() })
    );

    expect(registered.clientSecret).toMatch(/^owsec_/u);

    const discovery = await json(
      await worker.fetch(`${issuer}/.well-known/openid-configuration`),
      z.object({
        issuer: z.string(),
        authorization_endpoint: z.string(),
        token_endpoint: z.string(),
        jwks_uri: z.string(),
        code_challenge_methods_supported: z.array(z.string()),
      })
    );

    expect(discovery).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });

    const jwks = await json(
      await worker.fetch(discovery.jwks_uri),
      z.object({ keys: z.array(jwk) })
    );

    const [publicKey] = jwks.keys;
    expect(publicKey).not.toHaveProperty("d");

    const verifier = randomToken(48);
    const authorize = new URL(discovery.authorization_endpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registered.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set(
      "scope",
      "openid profile email groups offline_access"
    );
    authorize.searchParams.set("state", "state-value");
    authorize.searchParams.set("nonce", "nonce-value");
    authorize.searchParams.set("code_challenge", await hashToken(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    const unregisteredRedirect = new URL(authorize);
    unregisteredRedirect.searchParams.set(
      "redirect_uri",
      "https://evil.example.test/callback"
    );

    const rejectedRedirect = await worker.fetch(
      new Request(unregisteredRedirect, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    expect(rejectedRedirect.status).toBe(400);
    expect(rejectedRedirect.headers.get("location")).toBeNull();

    const authorization = await worker.fetch(
      new Request(authorize, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    expect(authorization.status).toBe(302);
    const callback = location(authorization);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("state-value");

    const code = required(
      callback.searchParams.get("code"),
      "authorize redirects with a code"
    );

    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });

    const invalidClient = await worker.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:wrong-secret`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: tokenBody,
      })
    );

    expect(invalidClient.status).toBe(401);

    const invalidVerifier = await worker.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          ...Object.fromEntries(tokenBody),
          code_verifier: randomToken(48),
        }),
      })
    );

    expect(invalidVerifier.status).toBe(400);
    expect(await invalidVerifier.json()).toMatchObject({
      error: "invalid_grant",
    });

    const token = await json(
      await worker.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: tokenBody,
        })
      ),
      tokens.extend({ id_token: z.string(), token_type: z.string() })
    );

    expect(token.token_type).toBe("Bearer");

    const signingKey = await importJWK(
      required(publicKey, "the JWKS has a key"),
      "RS256"
    );

    const verified = await jwtVerify(token.id_token, signingKey, {
      issuer,
      audience: registered.clientId,
    });

    expect(verified.payload).toMatchObject({
      sub: userId,
      nonce: "nonce-value",
      email: "oidc-admin@example.test",
      email_verified: true,
      groups: ["grafana-admins"],
    });
    expect(verified.payload.groups).not.toContain("finance");

    const userinfo = await json(
      await worker.fetch(
        new Request(`${issuer}/oauth/userinfo`, {
          headers: { authorization: `Bearer ${token.access_token}` },
        })
      ),
      z.object({ sub: z.string(), groups: z.array(z.string()) })
    );

    expect(userinfo).toMatchObject({
      sub: userId,
      groups: ["grafana-admins"],
    });

    await expectOk(
      await worker.fetch(
        new Request(`${issuer}/api/admin/teams/${visibleGroup.teamId}`, {
          method: "PATCH",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Grafana administrators",
            slug: "grafana-admins",
            description: null,
            members: [],
          }),
        })
      )
    );

    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });

    const rotated = await json(
      await worker.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: refreshBody,
        })
      ),
      tokens.extend({ id_token: z.string() })
    );

    expect(
      (
        await jwtVerify(rotated.id_token, signingKey, {
          issuer,
          audience: registered.clientId,
        })
      ).payload.groups
    ).toEqual([]);

    const reused = await worker.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: refreshBody,
      })
    );

    expect(reused.status).toBe(400);
    expect(
      (
        await worker.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${rotated.access_token}` },
          })
        )
      ).status
    ).toBe(401);

    const familyRevoked = await worker.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rotated.refresh_token,
        }),
      })
    );

    expect(familyRevoked.status).toBe(400);

    const reuseVerifier = randomToken(48);
    const reuseAuthorize = new URL(authorize);
    reuseAuthorize.searchParams.set(
      "code_challenge",
      await hashToken(reuseVerifier)
    );

    const reuseAuthorization = await worker.fetch(
      new Request(reuseAuthorize, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    expect(reuseAuthorization.status).toBe(302);

    const reuseCode = codeFrom(reuseAuthorization);

    const reuseTokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: reuseCode,
      redirect_uri: redirectUri,
      code_verifier: reuseVerifier,
    });

    const reuseTokens = await json(
      await worker.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: reuseTokenBody,
        })
      ),
      tokens
    );

    expect(
      (
        await worker.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${reuseTokens.access_token}` },
          })
        )
      ).status
    ).toBe(200);

    const codeReplay = await worker.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: reuseTokenBody,
      })
    );

    expect(codeReplay.status).toBe(400);
    expect(await codeReplay.json()).toMatchObject({ error: "invalid_grant" });
    expect(
      (
        await worker.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${reuseTokens.access_token}` },
          })
        )
      ).status
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request(discovery.token_endpoint, {
            method: "POST",
            headers: {
              authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: reuseTokens.refresh_token,
            }),
          })
        )
      ).status
    ).toBe(400);

    const revokeVerifier = randomToken(48);
    const revokeAuthorize = new URL(authorize);
    revokeAuthorize.searchParams.set(
      "code_challenge",
      await hashToken(revokeVerifier)
    );

    const revokeAuthorization = await worker.fetch(
      new Request(revokeAuthorize, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    const revokeCode = codeFrom(revokeAuthorization);

    const revokeTokens = await json(
      await worker.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: revokeCode,
            redirect_uri: redirectUri,
            code_verifier: revokeVerifier,
          }),
        })
      ),
      z.object({ access_token: z.string() })
    );

    const revocation = await worker.fetch(
      new Request(`${issuer}/oauth/revoke`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: revokeTokens.access_token }),
      })
    );

    expect(revocation.status).toBe(200);
    expect(
      (
        await worker.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${revokeTokens.access_token}` },
          })
        )
      ).status
    ).toBe(401);

    await expectOk(
      await worker.fetch(
        new Request(`${issuer}/api/admin/oidc-clients/${registered.clientId}`, {
          method: "PATCH",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...clientInput,
            accessTeams: [],
          }),
        })
      )
    );

    const denied = await worker.fetch(
      new Request(authorize, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    expect(denied.status).toBe(302);
    expect(location(denied).searchParams.get("error")).toBe("access_denied");

    const logout = new URL(`${issuer}/oauth/logout`);
    logout.searchParams.set("client_id", registered.clientId);
    logout.searchParams.set("id_token_hint", "not-a-jwt");
    logout.searchParams.set(
      "post_logout_redirect_uri",
      "https://evil.example.test/logout"
    );

    const logoutChallenge = await worker.fetch(
      new Request(logout, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    expect(logoutChallenge.status).toBe(302);
    const confirmLocation = location(logoutChallenge);
    expect(confirmLocation.pathname).toBe("/oidc/logout");
    expect(confirmLocation.searchParams.get("client_id")).toBe(
      registered.clientId
    );
    expect(
      await json(
        await worker.fetch(
          new Request(`${issuer}/api/bootstrap`, {
            headers: { cookie },
          })
        ),
        signedIn
      )
    ).toMatchObject({ authenticated: true });

    const confirmed = await worker.fetch(
      new Request(`${issuer}/api/oidc/logout`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: issuer,
        },
        body: JSON.stringify({
          client_id: registered.clientId,
          id_token_hint: "not-a-jwt",
          post_logout_redirect_uri: "https://evil.example.test/logout",
        }),
      })
    );

    const confirmedBody = await json(
      confirmed,
      z.object({ redirectTo: z.string() })
    );

    expect(confirmedBody.redirectTo).toBe(`${issuer}/`);
    expect(confirmed.headers.get("set-cookie")).toContain("op_session_dev=");
    const cleared = confirmed.headers.get("set-cookie")?.split(";", 1)[0];
    expect(
      await json(
        await worker.fetch(
          new Request(`${issuer}/api/bootstrap`, {
            headers: { cookie: cleared ?? cookie },
          })
        ),
        signedIn
      )
    ).toMatchObject({ authenticated: false });
  });
});
