import { env, exports } from "cloudflare:workers";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import { hashToken, randomToken } from "../worker/lib/crypto";

const issuer = "http://example.test";
const redirectUri = "https://recovery.example.test/callback";

async function body<T>(response: Response) {
  const value = await response.json<T>();
  expect(response.status, JSON.stringify(value)).toBeLessThan(400);
  return value;
}

function post(path: string, input: unknown, cookie?: string) {
  return exports.default.fetch(
    new Request(`${issuer}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(input),
    }),
  );
}

// Minimal software authenticator: "none" attestation with a P-256 key.
async function registrationResponse(challenge: string) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const coseKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, isoBase64URL.toBuffer(jwk.x!)],
    [-3, isoBase64URL.toBuffer(jwk.y!)],
  ]));
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("example.test")),
  );
  const authData = new Uint8Array([
    ...rpIdHash,
    0x45, // UP | UV | AT
    0, 0, 0, 0,
    ...new Uint8Array(16),
    0, credentialId.length,
    ...credentialId,
    ...coseKey,
  ]);
  const attestationObject = isoCBOR.encode(new Map<string, unknown>([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authData],
  ]) as never);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.create",
    challenge,
    origin: issuer,
    crossOrigin: false,
  }));
  const id = isoBase64URL.fromBuffer(credentialId);
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal"],
    },
  };
}

async function completeAccessLink(url: string) {
  const [, kind, token] = new URL(url).pathname.split("/");
  const route = kind === "invite" ? "invitation" : "recovery";
  const options = await body<{
    options: { challenge: string };
    challengeId: string;
  }>(await post(`/api/auth/${route}/${token}/options`, {}));
  return post(`/api/auth/${route}/${token}/verify`, {
    challengeId: options.challengeId,
    response: await registrationResponse(options.options.challenge),
  });
}

describe("OIDC account recovery", () => {
  it("revokes relying-party tokens when an admin recovery completes", async () => {
    const bootstrap = await post("/api/auth/mock/bootstrap", {
      name: "Recovery Admin",
      email: "recovery-admin@example.test",
    });
    const adminCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0]!;
    await body(bootstrap);
    const invitation = await body<{ accessLink: { userId: string; url: string } }>(
      await post("/api/admin/invitations", {
        name: "Recovery Member",
        email: "recovery-member@example.test",
      }, adminCookie),
    );
    const userId = invitation.accessLink.userId;
    await body(await completeAccessLink(invitation.accessLink.url));
    const member = await env.DB.prepare(
      "SELECT status FROM users WHERE id = ?",
    ).bind(userId).first<{ status: string }>();
    expect(member?.status).toBe("active");

    const login = await post("/api/auth/mock/login", { userId });
    const userCookie = login.headers.get("set-cookie")?.split(";", 1)[0]!;
    await body(login);
    const client = await body<{ clientId: string; clientSecret: string }>(
      await post("/api/admin/oidc-clients", {
        name: "Recovery app",
        clientType: "confidential",
        accessPolicy: "selected_users",
        redirectUris: [redirectUri],
        postLogoutRedirectUris: [],
        allowedOrigins: [],
        allowedScopes: ["openid", "email", "offline_access"],
        trusted: true,
        enabled: true,
        assignedUserIds: [userId],
        exposedGroupIds: [],
      }, adminCookie),
    );
    const clientAuth = `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`;
    const verifier = randomToken(48);
    const authorize = new URL(`${issuer}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: "openid email offline_access",
      code_challenge: await hashToken(verifier),
      code_challenge_method: "S256",
    }).toString();
    const authorization = await exports.default.fetch(
      new Request(authorize, {
        headers: { cookie: userCookie },
        redirect: "manual",
      }),
    );
    const code = new URL(
      authorization.headers.get("location")!,
    ).searchParams.get("code")!;
    const token = (form: Record<string, string>) => exports.default.fetch(
      new Request(`${issuer}/oauth/token`, {
        method: "POST",
        headers: {
          authorization: clientAuth,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form),
      }),
    );
    const tokens = await body<{ refresh_token: string }>(
      await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    );
    expect(tokens.refresh_token).toBeTruthy();

    const recovery = await body<{ accessLink: { url: string } }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/users/${userId}/access-link`, {
          method: "POST",
          headers: { cookie: adminCookie },
        }),
      ),
    );
    await body(await completeAccessLink(recovery.accessLink.url));

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    for (const table of ["oidc_refresh_tokens", "oidc_access_tokens", "oidc_grants"]) {
      const remaining = await env.DB.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE user_id = ?`,
      ).bind(userId).first<{ count: number }>();
      expect(remaining?.count, table).toBe(0);
    }
  });
});
