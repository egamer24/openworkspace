import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  SignJWT,
} from "jose";
import type { JWK, JWTPayload } from "jose";
import { z } from "zod";

import type { AppEnv } from "../env";
import {
  identityProviderOrigin,
  IdentityProviderOriginError,
} from "../lib/identity-provider-origin";
import { createId } from "../lib/ids";
import { ID_TOKEN_TTL_SECONDS } from "./constants";
import { OidcError } from "./errors";

type OidcConfig = {
  issuer: string;
  privateJwk: JWK & { kid: string };
  publicJwks: { keys: JWK[] };
};

let cached:
  | {
      source: string;
      origin: string | undefined;
      config: OidcConfig;
      key: CryptoKey;
      verifyKey: CryptoKey;
    }
  | undefined;

const LOGOUT_TOKEN_TTL_SECONDS = 120;

export function oidcIssuer(
  env: Pick<AppEnv["Bindings"], "IDENTITY_PROVIDER_ORIGIN" | "ALLOW_MOCK_AUTH">
) {
  try {
    return identityProviderOrigin(env);
  } catch (error) {
    if (!(error instanceof IdentityProviderOriginError)) throw error;
    throw new OidcError("server_error", error.message, 500);
  }
}

/** A signing key's algorithm as WebCrypto reports it: RS256 with a strong modulus. */
const strongRsaAlgorithmSchema = z.object({
  name: z.literal("RSASSA-PKCS1-v1_5"),
  modulusLength: z.number().min(2048),
});

function isStrongRsaCryptoKey(key: CryptoKey | Uint8Array): key is CryptoKey {
  return (
    key instanceof CryptoKey &&
    strongRsaAlgorithmSchema.safeParse(key.algorithm).success
  );
}

/** `OIDC_SIGNING_PRIVATE_JWK`: an RSA private key; other members are dropped. */
const privateRsaJwkSchema = z.object({
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
  d: z.string().min(1),
  p: z.string().optional(),
  q: z.string().optional(),
  dp: z.string().optional(),
  dq: z.string().optional(),
  qi: z.string().optional(),
  kid: z.string().optional(),
});

async function loadConfig(env: AppEnv["Bindings"]) {
  const source = env.OIDC_SIGNING_PRIVATE_JWK;

  if (!source) {
    throw new OidcError(
      "temporarily_unavailable",
      "OIDC signing key is not configured",
      503
    );
  }

  if (
    cached?.source === source &&
    cached.origin === env.IDENTITY_PROVIDER_ORIGIN
  ) {
    return cached;
  }

  let json: unknown;

  try {
    json = JSON.parse(source);
  } catch {
    throw new OidcError("server_error", "OIDC signing key is invalid", 500);
  }

  const jwk = privateRsaJwkSchema.safeParse(json);

  if (!jwk.success) {
    throw new OidcError(
      "server_error",
      "OIDC signing key must be a private RSA JWK",
      500
    );
  }

  const parsed = jwk.data;

  const kid = parsed.kid ?? (await calculateJwkThumbprint(parsed));
  const privateJwk = { ...parsed, alg: "RS256", use: "sig", kid };
  const key = await importJWK(privateJwk, "RS256");

  if (!isStrongRsaCryptoKey(key)) {
    throw new OidcError(
      "server_error",
      "OIDC signing key must use RSA with at least 2048 bits",
      500
    );
  }

  const publicJwk = publicOnly(privateJwk);
  const verifyKey = await importJWK(publicJwk, "RS256");

  if (!(verifyKey instanceof CryptoKey)) {
    throw new OidcError(
      "server_error",
      "OIDC verification key is invalid",
      500
    );
  }

  const config: OidcConfig = {
    issuer: oidcIssuer(env),
    privateJwk,
    publicJwks: { keys: [publicJwk] },
  };

  cached = {
    source,
    origin: env.IDENTITY_PROVIDER_ORIGIN,
    config,
    key,
    verifyKey,
  };

  return cached;
}

/** The key's public half, as the JWKS publishes it. */
function publicOnly(
  jwk: Pick<JWK, "kty" | "n" | "e" | "alg" | "use"> & { kid: string }
) {
  return {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    alg: jwk.alg,
    use: jwk.use,
    kid: jwk.kid,
  } satisfies JWK;
}

export async function publicJwks(env: AppEnv["Bindings"]) {
  return (await loadConfig(env)).config.publicJwks;
}

export async function signIdToken(
  env: AppEnv["Bindings"],
  input: {
    clientId: string;
    userId: string;
    authTime: Date;
    nonce?: string | null;
    claims: JWTPayload;
  }
) {
  const loaded = await loadConfig(env);
  const now = Math.floor(Date.now() / 1000);

  const payload: JWTPayload = {
    ...input.claims,
    auth_time: Math.floor(input.authTime.getTime() / 1000),
    amr: ["webauthn"],
  };

  if (input.nonce) payload.nonce = input.nonce;

  return new SignJWT(payload)
    .setProtectedHeader({
      alg: "RS256",
      kid: loaded.config.privateJwk.kid,
      typ: "JWT",
    })
    .setIssuer(loaded.config.issuer)
    .setSubject(input.userId)
    .setAudience(input.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
    .setJti(createId("jwt"))
    .sign(loaded.key);
}

/** OpenID Connect Back-Channel Logout 1.0: ends every session of one user at one client. */
export async function signLogoutToken(
  env: AppEnv["Bindings"],
  input: { clientId: string; userId: string }
) {
  const loaded = await loadConfig(env);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: loaded.config.privateJwk.kid,
      typ: "logout+jwt",
    })
    .setIssuer(loaded.config.issuer)
    .setSubject(input.userId)
    .setAudience(input.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + LOGOUT_TOKEN_TTL_SECONDS)
    .setJti(createId("jwt"))
    .sign(loaded.key);
}

/** The claims of an ID token this provider issued that a logout reads. */
const idTokenHintClaimsSchema = z
  .object({
    iss: z.string(),
    sub: z.string(),
    iat: z.number(),
    exp: z.number(),
    aud: z
      .union([z.string().transform((aud) => [aud]), z.array(z.string())])
      .default([]),
  })
  .refine((claims) => claims.exp > claims.iat);

export async function claimsFromIdTokenHint(
  env: AppEnv["Bindings"],
  idToken: string
) {
  const loaded = await loadConfig(env);

  try {
    const header = decodeProtectedHeader(idToken);

    const verificationKey =
      header.kid === loaded.config.privateJwk.kid
        ? loaded.verifyKey
        : undefined;

    if (!verificationKey) {
      throw new Error("Unknown signing key");
    }

    const verified = await compactVerify(idToken, verificationKey, {
      algorithms: ["RS256"],
    });

    const payload = idTokenHintClaimsSchema
      .refine((claims) => claims.iss === loaded.config.issuer)
      .parse(JSON.parse(new TextDecoder().decode(verified.payload)));

    // One client: a token for several names none of them.
    const clientId = payload.aud.length === 1 ? payload.aud[0] : undefined;

    if (clientId) {
      return { clientId, subject: payload.sub };
    }
  } catch {
    throw new OidcError("invalid_request", "id_token_hint is invalid");
  }

  throw new OidcError(
    "invalid_request",
    "id_token_hint has an invalid audience"
  );
}
