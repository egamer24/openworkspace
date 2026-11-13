import { describe, expect, it } from "bun:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { required } from "../../shared/invariant.ts";
import type { AppEnv } from "../../worker/env.ts";
import { claimsFromIdTokenHint, publicJwks } from "../../worker/oidc/keys.ts";

// The Worker's own signing key and origin, as a deployment binds them.
const { privateKey: signingKey } = await generateKeyPair("RS256", {
  extractable: true,
});

// SAFETY: the OIDC key helpers read only the signing key, origin, and mock-auth flag set here.
const env = {
  OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(await exportJWK(signingKey)),
  IDENTITY_PROVIDER_ORIGIN: "http://example.test",
  ALLOW_MOCK_AUTH: "true",
} as AppEnv["Bindings"];

describe("OIDC signing key", () => {
  it("publishes its public half without private material", async () => {
    const jwks = await publicJwks(env);

    expect(jwks.keys).toHaveLength(1);
    expect(required(jwks.keys[0], "a published key").kid).toBeString();
    expect(jwks.keys.every((key) => !key.d)).toBe(true);
  });

  it("accepts an expired logout hint it signed", async () => {
    const [key] = (await publicJwks(env)).keys;
    const kid = required(key?.kid, "the signing key's kid");
    const now = Math.floor(Date.now() / 1000);

    const hint = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer("http://example.test")
      .setSubject("usr_logout")
      .setAudience("cli_logout")
      .setIssuedAt(now - 600)
      .setExpirationTime(now - 300)
      .sign(signingKey);

    await expect(claimsFromIdTokenHint(env, hint)).resolves.toEqual({
      clientId: "cli_logout",
      subject: "usr_logout",
    });
  });

  it("refuses a hint signed by another key", async () => {
    const { privateKey } = await generateKeyPair("RS256");

    const hint = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "another-key" })
      .setIssuer("http://example.test")
      .setSubject("usr_logout")
      .setAudience("cli_logout")
      .sign(privateKey);

    await expect(claimsFromIdTokenHint(env, hint)).rejects.toThrow();
  });
});
