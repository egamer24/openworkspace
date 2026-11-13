import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { required } from "../../shared/invariant";
import { isPrivilegedScope } from "../../shared/oidc";
import { avatarUrl } from "../auth/avatar";
import type { Database } from "../db/client";
import type { OidcAuditDetail } from "../db/json";
import { mailboxAddressSql } from "../db/mailboxes";
import {
  teamMembership,
  teams,
  mailboxes,
  oidcAccessTokens,
  oidcAuditEvents,
  oidcAuthorizationCodes,
  oidcAuthorizationRequests,
  oidcClientAccess,
  oidcClientAccessTeams,
  oidcClients,
  oidcGrants,
  oidcRefreshTokens,
  users,
} from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { groupValues } from "../sso/access";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  MAX_GROUP_CLAIMS,
  REFRESH_TOKEN_TTL_MS,
} from "./constants";
import { OidcError } from "./errors";
import { oidcIssuer, signIdToken } from "./keys";
import { selfRegisteredScopes } from "./mcp-clients";
import { coveredScopes } from "./scopes";

const ABANDONED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

export type OidcClient = typeof oidcClients.$inferSelect;

export async function findEnabledClient(db: Database, clientId: string) {
  const [client] = await db
    .select()
    .from(oidcClients)
    .where(and(eq(oidcClients.id, clientId), eq(oidcClients.enabled, true)))
    .limit(1);

  if (!client) throw new OidcError("invalid_request", "Unknown OIDC client");

  return client;
}

export async function assertUserCanUseClient(
  db: Database,
  client: OidcClient,
  userId: string
) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "active")))
    .limit(1);

  if (!user) {
    throw new OidcError("access_denied", "User account is not active", 403);
  }

  const [access] = await db
    .select({ userId: oidcClientAccess.userId })
    .from(oidcClientAccess)
    .where(
      and(
        eq(oidcClientAccess.clientId, client.id),
        eq(oidcClientAccess.userId, userId)
      )
    )
    .limit(1);

  if (!access) {
    throw new OidcError(
      "access_denied",
      "You are not in a team that may use this application",
      403
    );
  }
}

/**
 * Of the scopes a request asked for, those this person may grant now
 * (oidc/scopes.ts); the rest are left out of what the app gets.
 */
export async function grantableScopes(
  db: Database,
  userId: string,
  scopes: readonly string[]
) {
  const [user] = await db
    .select({ role: users.role, permissions: users.permissions })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "active")))
    .limit(1);

  return user ? coveredScopes(user, scopes) : [];
}

/**
 * Scopes a code or refresh token already carries, checked against what the
 * client may still hold. Unlike a request, an empty list stays empty.
 */
function validateGrantedScopes(client: OidcClient, scopes: string[]) {
  if (!scopes.length) return scopes;

  if (client.registration !== "admin") return selfRegisteredScopes(scopes);

  if (scopes.some((scope) => !client.allowedScopes.includes(scope))) {
    throw new OidcError(
      "invalid_scope",
      "One or more granted scopes are no longer allowed"
    );
  }

  return scopes;
}

export function validateRequestedScopes(
  client: OidcClient,
  requested: string[]
): string[] {
  // Self-registered clients are MCP clients: OAuth only, no identity scopes.
  if (client.registration !== "admin") return selfRegisteredScopes(requested);
  const unique = [...new Set(requested)];

  if (!unique.includes("openid")) {
    throw new OidcError("invalid_scope", "The openid scope is required");
  }

  if (unique.some((scope) => !client.allowedScopes.includes(scope))) {
    throw new OidcError(
      "invalid_scope",
      "One or more requested scopes are not allowed"
    );
  }

  return unique;
}

/**
 * Whether a request may go straight back to the app: it is trusted, or the
 * person approved these scopes before. Never when it asks for mail or
 * administration; the person sees that request every time.
 */
export function consentMaySkip(
  client: Pick<OidcClient, "trusted">,
  scopes: readonly string[],
  hasExistingGrant: boolean
) {
  if (scopes.some(isPrivilegedScope)) return false;

  return client.trusted || hasExistingGrant;
}

export async function hasGrant(
  db: Database,
  clientId: string,
  userId: string,
  scopes: string[]
) {
  const [grant] = await db
    .select({ scopes: oidcGrants.scopes })
    .from(oidcGrants)
    .where(
      and(eq(oidcGrants.clientId, clientId), eq(oidcGrants.userId, userId))
    )
    .limit(1);

  return Boolean(
    grant && scopes.every((scope) => grant.scopes.includes(scope))
  );
}

export async function createAuthorizationRequest(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    scopes: string[];
    resource: string | null;
    state?: string | null;
    nonce?: string | null;
    codeChallenge: string;
    authTime: Date;
  }
) {
  const id = createId("req");
  const now = new Date();
  await db.insert(oidcAuthorizationRequests).values({
    id,
    ...input,
    status: "awaiting_consent",
    forceConsent: true,
    state: input.state ?? null,
    nonce: input.nonce ?? null,
    expiresAt: new Date(now.getTime() + AUTHORIZATION_REQUEST_TTL_MS),
    createdAt: now,
  });

  return id;
}

export async function getAuthorizationRequest(
  db: Database,
  requestId: string,
  userId: string
) {
  const [request] = await db
    .select({
      id: oidcAuthorizationRequests.id,
      clientId: oidcAuthorizationRequests.clientId,
      clientName: oidcClients.name,
      clientRegistration: oidcClients.registration,
      redirectUri: oidcAuthorizationRequests.redirectUri,
      scopes: oidcAuthorizationRequests.scopes,
      resource: oidcAuthorizationRequests.resource,
      expiresAt: oidcAuthorizationRequests.expiresAt,
    })
    .from(oidcAuthorizationRequests)
    .innerJoin(
      oidcClients,
      eq(oidcAuthorizationRequests.clientId, oidcClients.id)
    )
    .where(
      and(
        eq(oidcAuthorizationRequests.id, requestId),
        eq(oidcAuthorizationRequests.userId, userId),
        eq(oidcAuthorizationRequests.status, "awaiting_consent"),
        gt(oidcAuthorizationRequests.expiresAt, new Date()),
        eq(oidcClients.enabled, true)
      )
    )
    .limit(1);

  if (!request) {
    throw new OidcError(
      "invalid_request",
      "Authorization request is invalid or expired"
    );
  }

  return request;
}

export async function finishAuthorizationRequest(
  db: Database,
  input: {
    requestId: string;
    userId: string;
    approved: boolean;
  }
) {
  const [request] = await db
    .delete(oidcAuthorizationRequests)
    .where(
      and(
        eq(oidcAuthorizationRequests.id, input.requestId),
        eq(oidcAuthorizationRequests.userId, input.userId),
        eq(oidcAuthorizationRequests.status, "awaiting_consent"),
        gt(oidcAuthorizationRequests.expiresAt, new Date())
      )
    )
    .returning();

  if (!request) {
    throw new OidcError(
      "invalid_request",
      "Authorization request is invalid or expired"
    );
  }

  if (!input.approved) {
    await insertOidcAudit(db, {
      eventType: "authorization.denied",
      subjectUserId: input.userId,
      clientId: request.clientId,
    });

    return authorizationErrorRedirect(
      request.redirectUri,
      "access_denied",
      request.state
    );
  }

  if (!request.authTime) {
    throw new OidcError(
      "invalid_request",
      "Authorization request has no authentication time"
    );
  }

  const client = await findEnabledClient(db, request.clientId);

  if (!client.redirectUris.includes(request.redirectUri)) {
    throw new OidcError(
      "invalid_request",
      "The registered redirect URI has changed"
    );
  }

  await assertUserCanUseClient(db, client, input.userId);

  // What the person may not grant was shown to them as unavailable, and is left out.
  const scopes = await grantableScopes(
    db,
    input.userId,
    validateRequestedScopes(client, request.scopes)
  );

  const now = new Date();

  const [existingGrant] = await db
    .select({ scopes: oidcGrants.scopes })
    .from(oidcGrants)
    .where(
      and(
        eq(oidcGrants.clientId, request.clientId),
        eq(oidcGrants.userId, input.userId)
      )
    )
    .limit(1);

  const grantedScopes = [
    ...new Set([...(existingGrant?.scopes ?? []), ...scopes]),
  ];

  await db
    .insert(oidcGrants)
    .values({
      clientId: request.clientId,
      userId: input.userId,
      scopes: grantedScopes,
      grantedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [oidcGrants.clientId, oidcGrants.userId],
      set: { scopes: grantedScopes, updatedAt: now },
    });

  const redirectTo = await issueAuthorizationCode(db, {
    ...request,
    scopes,
    userId: input.userId,
    authTime: request.authTime,
  });

  await insertOidcAudit(db, {
    eventType: "authorization.approved",
    subjectUserId: input.userId,
    clientId: request.clientId,
    detail: { scopes: grantedScopes },
  });

  return redirectTo;
}

export async function authenticatedAuthorizationRequest(
  db: Database,
  requestId: string,
  userId: string
) {
  const [request] = await db
    .select()
    .from(oidcAuthorizationRequests)
    .where(
      and(
        eq(oidcAuthorizationRequests.id, requestId),
        eq(oidcAuthorizationRequests.userId, userId),
        eq(oidcAuthorizationRequests.status, "authenticated"),
        gt(oidcAuthorizationRequests.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!request?.userId || !request.authTime) {
    throw new OidcError(
      "invalid_request",
      "Authorization transaction is invalid or expired"
    );
  }

  return {
    ...request,
    userId: request.userId,
    authTime: request.authTime,
  };
}

export async function resumeAuthorizationRequest(
  db: Database,
  request: Awaited<ReturnType<typeof authenticatedAuthorizationRequest>>
) {
  const client = await findEnabledClient(db, request.clientId);

  if (!client.redirectUris.includes(request.redirectUri)) {
    throw new OidcError(
      "invalid_request",
      "The registered redirect URI has changed"
    );
  }

  await assertUserCanUseClient(db, client, request.userId);

  const scopes = await grantableScopes(
    db,
    request.userId,
    validateRequestedScopes(client, request.scopes)
  );

  const existingGrant = await hasGrant(db, client.id, request.userId, scopes);

  if (
    !request.forceConsent &&
    consentMaySkip(client, request.scopes, existingGrant)
  ) {
    const [consumed] = await db
      .delete(oidcAuthorizationRequests)
      .where(
        and(
          eq(oidcAuthorizationRequests.id, request.id),
          eq(oidcAuthorizationRequests.status, "authenticated")
        )
      )
      .returning({ id: oidcAuthorizationRequests.id });

    if (!consumed) {
      throw new OidcError(
        "invalid_request",
        "Authorization transaction was already used"
      );
    }

    return issueAuthorizationCode(db, { ...request, scopes });
  }

  const [continued] = await db
    .update(oidcAuthorizationRequests)
    .set({ status: "awaiting_consent" })
    .where(
      and(
        eq(oidcAuthorizationRequests.id, request.id),
        eq(oidcAuthorizationRequests.status, "authenticated")
      )
    )
    .returning({ id: oidcAuthorizationRequests.id });

  if (!continued) {
    throw new OidcError(
      "invalid_request",
      "Authorization transaction was already used"
    );
  }

  return `/oidc/consent/${encodeURIComponent(request.id)}`;
}

export async function issueAuthorizationCode(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    scopes: string[];
    resource: string | null;
    state?: string | null;
    nonce?: string | null;
    codeChallenge: string;
    authTime: Date;
  }
) {
  const code = randomToken();
  const now = new Date();
  await db.insert(oidcAuthorizationCodes).values({
    tokenHash: await hashToken(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    resource: input.resource,
    nonce: input.nonce ?? null,
    codeChallenge: input.codeChallenge,
    authTime: input.authTime,
    expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
    createdAt: now,
  });
  const target = new URL(input.redirectUri);
  target.searchParams.set("code", code);

  if (input.state) target.searchParams.set("state", input.state);

  return target.toString();
}

export function authorizationErrorRedirect(
  redirectUri: string,
  code: string,
  state?: string | null,
  description?: string
) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", code);

  if (state) target.searchParams.set("state", state);

  if (description) target.searchParams.set("error_description", description);

  return target.toString();
}

export async function exchangeAuthorizationCode(
  db: Database,
  env: AppEnv["Bindings"],
  input: {
    code: string;
    client: OidcClient;
    redirectUri: string;
    codeVerifier: string;
    /** The resource the token request names, if it names one. */
    resource: string | null;
  }
) {
  const tokenHash = await hashToken(input.code);

  const [authorizationCode] = await db
    .select()
    .from(oidcAuthorizationCodes)
    .where(
      and(
        eq(oidcAuthorizationCodes.tokenHash, tokenHash),
        eq(oidcAuthorizationCodes.clientId, input.client.id)
      )
    )
    .limit(1);

  if (!authorizationCode) {
    throw new OidcError(
      "invalid_grant",
      "Authorization code is invalid or expired"
    );
  }

  if (authorizationCode.usedAt) {
    await revokeAuthorizationCodeIssuance(db, authorizationCode);
    throw new OidcError("invalid_grant", "Authorization code was already used");
  }

  if (authorizationCode.expiresAt <= new Date()) {
    throw new OidcError(
      "invalid_grant",
      "Authorization code is invalid or expired"
    );
  }

  if (authorizationCode.redirectUri !== input.redirectUri) {
    throw new OidcError("invalid_grant", "Redirect URI does not match");
  }

  if (!input.client.redirectUris.includes(input.redirectUri)) {
    throw new OidcError(
      "invalid_grant",
      "Redirect URI is no longer registered"
    );
  }

  // An empty challenge means the app was allowed to skip PKCE; a verifier
  // sent anyway is refused so a stolen code cannot be downgraded (RFC 9700).
  if (authorizationCode.codeChallenge === "") {
    if (input.codeVerifier) {
      throw new OidcError(
        "invalid_grant",
        "PKCE was not used for this authorization code"
      );
    }
  } else if (
    !input.codeVerifier ||
    (await hashToken(input.codeVerifier)) !== authorizationCode.codeChallenge
  ) {
    throw new OidcError("invalid_grant", "PKCE verification failed");
  }

  assertSameResource(authorizationCode.resource, input.resource);
  const scopes = validateGrantedScopes(input.client, authorizationCode.scopes);
  await assertUserCanUseClient(db, input.client, authorizationCode.userId);

  const prepared = await prepareTokenSet(db, env, {
    client: input.client,
    userId: authorizationCode.userId,
    scopes,
    resource: authorizationCode.resource,
    authTime: authorizationCode.authTime,
    nonce: authorizationCode.nonce,
  });

  const [consumed] = await db.batch([
    db
      .update(oidcAuthorizationCodes)
      .set({
        usedAt: prepared.now,
        issuedAccessTokenHash: prepared.accessTokenValues.tokenHash,
        issuedRefreshFamilyId: prepared.accessTokenValues.familyId,
      })
      .where(
        and(
          eq(oidcAuthorizationCodes.tokenHash, tokenHash),
          eq(oidcAuthorizationCodes.clientId, input.client.id),
          isNull(oidcAuthorizationCodes.usedAt),
          gt(oidcAuthorizationCodes.expiresAt, prepared.now)
        )
      )
      .returning({ tokenHash: oidcAuthorizationCodes.tokenHash }),
    conditionalTokenInsert(db, {
      table: "access",
      values: prepared.accessTokenValues,
      from: "authorization_code",
      codeHash: tokenHash,
      accessTokenHash: prepared.accessTokenValues.tokenHash,
    }),
    ...(prepared.refreshTokenValues
      ? [
          conditionalTokenInsert(db, {
            table: "refresh",
            values: prepared.refreshTokenValues,
            from: "authorization_code",
            codeHash: tokenHash,
            accessTokenHash: prepared.accessTokenValues.tokenHash,
          }),
        ]
      : []),
  ]);

  if (consumed.length === 0) {
    const [current] = await db
      .select()
      .from(oidcAuthorizationCodes)
      .where(eq(oidcAuthorizationCodes.tokenHash, tokenHash))
      .limit(1);

    if (current?.usedAt) {
      await revokeAuthorizationCodeIssuance(db, current);
      throw new OidcError(
        "invalid_grant",
        "Authorization code was already used"
      );
    }

    throw new OidcError(
      "invalid_grant",
      "Authorization code is invalid or expired"
    );
  }

  await recordTokenUsage(db, {
    clientId: input.client.id,
    userId: authorizationCode.userId,
    scopes,
    now: prepared.now,
  });

  return prepared.response;
}

/**
 * RFC 8707: a token request may name the resource again, and then it must be
 * the one authorized; the token is always for that one.
 */
function assertSameResource(
  authorized: string | null,
  requested: string | null
) {
  if (requested !== null && requested !== authorized) {
    throw new OidcError(
      "invalid_target",
      "resource is not the one this grant is for"
    );
  }
}

/** The OpenID Connect claims the granted scopes release. */
type IdentityClaims = {
  name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  groups?: string[];
};

async function identityClaims(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    scopes: string[];
    /** The issuer's origin, where the `picture` is served. */
    origin: string;
  }
) {
  const [identity] = await db
    .select({
      name: users.name,
      id: users.id,
      avatarId: users.avatarId,
      email: mailboxAddressSql,
    })
    .from(users)
    .innerJoin(
      mailboxes,
      and(eq(mailboxes.ownerUserId, users.id), eq(mailboxes.isPrimary, true))
    )
    .where(and(eq(users.id, input.userId), eq(users.status, "active")))
    .limit(1);

  if (!identity) {
    throw new OidcError("invalid_grant", "User identity is unavailable");
  }

  const claims: IdentityClaims = {};

  if (input.scopes.includes("profile")) {
    claims.name = identity.name;
    const picture = avatarUrl(input.origin, identity);

    if (picture) claims.picture = picture;
  }

  if (input.scopes.includes("email")) {
    claims.email = identity.email;
    claims.email_verified = true;
  }

  if (input.scopes.includes("groups")) {
    const rows = await db
      .select({
        slug: teams.slug,
        everyone: teams.everyone,
        sentAs: oidcClientAccessTeams.sentAs,
      })
      .from(teamMembership)
      .innerJoin(
        oidcClientAccessTeams,
        and(
          eq(oidcClientAccessTeams.teamId, teamMembership.teamId),
          eq(oidcClientAccessTeams.clientId, input.clientId)
        )
      )
      .innerJoin(teams, eq(teams.id, teamMembership.teamId))
      .where(eq(teamMembership.userId, input.userId))
      .limit(MAX_GROUP_CLAIMS + 1);

    const groups = groupValues(rows);

    if (rows.length > MAX_GROUP_CLAIMS) {
      throw new OidcError(
        "server_error",
        "Group claim exceeds the configured limit",
        500
      );
    }

    claims.groups = groups;
  }

  return claims;
}

/** RFC 6749 §5.1: an ID token with `openid`, a refresh token with `offline_access`. */
type TokenResponse = {
  token_type: "Bearer";
  access_token: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
};

type PreparedRefreshTokenValues = {
  tokenHash: string;
  familyId: string;
  clientId: string;
  userId: string;
  scopes: string[];
  resource: string | null;
  authTime: Date;
  expiresAt: Date;
  createdAt: Date;
};

async function prepareTokenSet(
  db: Database,
  env: AppEnv["Bindings"],
  input: {
    client: OidcClient;
    userId: string;
    scopes: string[];
    resource: string | null;
    authTime: Date;
    nonce?: string | null;
    familyId?: string;
  }
) {
  // Plain OAuth clients (MCP) get no ID token; it needs the openid scope.
  const idToken = input.scopes.includes("openid")
    ? await signIdToken(env, {
        clientId: input.client.id,
        userId: input.userId,
        authTime: input.authTime,
        nonce: input.nonce,
        claims: await identityClaims(db, {
          clientId: input.client.id,
          userId: input.userId,
          scopes: input.scopes,
          origin: oidcIssuer(env),
        }),
      })
    : null;

  const now = new Date();
  const accessToken = randomToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const familyId = input.familyId ?? createId("fam");

  const accessTokenValues = {
    tokenHash: await hashToken(accessToken),
    familyId,
    clientId: input.client.id,
    userId: input.userId,
    scopes: input.scopes,
    resource: input.resource,
    authTime: input.authTime,
    expiresAt: accessExpiresAt,
    createdAt: now,
  };

  let refreshToken: string | undefined;
  let refreshTokenValues: PreparedRefreshTokenValues | undefined;

  if (input.scopes.includes("offline_access")) {
    refreshToken = randomToken();
    refreshTokenValues = {
      tokenHash: await hashToken(refreshToken),
      familyId,
      clientId: input.client.id,
      userId: input.userId,
      scopes: input.scopes,
      resource: input.resource,
      authTime: input.authTime,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      createdAt: now,
    };
  }

  const response: TokenResponse = {
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: input.scopes.join(" "),
  };

  if (idToken) response.id_token = idToken;

  if (refreshToken) response.refresh_token = refreshToken;

  return { now, accessTokenValues, refreshTokenValues, response };
}

function accessTokenSelectColumns(
  values: Awaited<ReturnType<typeof prepareTokenSet>>["accessTokenValues"]
) {
  return {
    tokenHash: sql<string>`${values.tokenHash}`.as("token_hash"),
    familyId: sql<string>`${values.familyId}`.as("family_id"),
    clientId: sql<string>`${values.clientId}`.as("client_id"),
    userId: sql<string>`${values.userId}`.as("user_id"),
    scopes: sql<string[]>`${JSON.stringify(values.scopes)}`.as("scopes"),
    resource: sql<string | null>`${values.resource}`.as("resource"),
    authTime: sql<Date>`${values.authTime.getTime()}`.as("auth_time"),
    expiresAt: sql<Date>`${values.expiresAt.getTime()}`.as("expires_at"),
    createdAt: sql<Date>`${values.createdAt.getTime()}`.as("created_at"),
  };
}

function refreshTokenSelectColumns(
  values: NonNullable<
    Awaited<ReturnType<typeof prepareTokenSet>>["refreshTokenValues"]
  >
) {
  return {
    tokenHash: sql<string>`${values.tokenHash}`.as("token_hash"),
    familyId: sql<string>`${values.familyId}`.as("family_id"),
    clientId: sql<string>`${values.clientId}`.as("client_id"),
    userId: sql<string>`${values.userId}`.as("user_id"),
    scopes: sql<string[]>`${JSON.stringify(values.scopes)}`.as("scopes"),
    resource: sql<string | null>`${values.resource}`.as("resource"),
    authTime: sql<Date>`${values.authTime.getTime()}`.as("auth_time"),
    expiresAt: sql<Date>`${values.expiresAt.getTime()}`.as("expires_at"),
    usedAt: sql<Date | null>`NULL`.as("used_at"),
    revokedAt: sql<Date | null>`NULL`.as("revoked_at"),
    replacedByTokenHash: sql<string | null>`NULL`.as("replaced_by_token_hash"),
    createdAt: sql<Date>`${values.createdAt.getTime()}`.as("created_at"),
  };
}

function conditionalTokenInsert(
  db: Database,
  input:
    | {
        table: "access";
        values: Awaited<
          ReturnType<typeof prepareTokenSet>
        >["accessTokenValues"];
        from: "refresh_rotation";
        previousTokenHash: string;
        replacementTokenHash: string;
      }
    | {
        table: "refresh";
        values: NonNullable<
          Awaited<ReturnType<typeof prepareTokenSet>>["refreshTokenValues"]
        >;
        from: "refresh_rotation";
        previousTokenHash: string;
        replacementTokenHash: string;
      }
    | {
        table: "access";
        values: Awaited<
          ReturnType<typeof prepareTokenSet>
        >["accessTokenValues"];
        from: "authorization_code";
        codeHash: string;
        accessTokenHash: string;
      }
    | {
        table: "refresh";
        values: NonNullable<
          Awaited<ReturnType<typeof prepareTokenSet>>["refreshTokenValues"]
        >;
        from: "authorization_code";
        codeHash: string;
        accessTokenHash: string;
      }
) {
  const source =
    input.from === "refresh_rotation"
      ? oidcRefreshTokens
      : oidcAuthorizationCodes;

  // The row that issues the tokens; without it the insert must select nothing.
  const gate = required(
    input.from === "refresh_rotation"
      ? and(
          eq(oidcRefreshTokens.tokenHash, input.previousTokenHash),
          eq(oidcRefreshTokens.replacedByTokenHash, input.replacementTokenHash)
        )
      : and(
          eq(oidcAuthorizationCodes.tokenHash, input.codeHash),
          eq(
            oidcAuthorizationCodes.issuedAccessTokenHash,
            input.accessTokenHash
          ),
          ...(input.table === "refresh"
            ? [
                eq(
                  oidcAuthorizationCodes.issuedRefreshFamilyId,
                  input.values.familyId
                ),
              ]
            : [])
        ),
    "and() of defined conditions is a condition"
  );

  if (input.table === "access") {
    return db
      .insert(oidcAccessTokens)
      .select(
        db
          .select(accessTokenSelectColumns(input.values))
          .from(source)
          .where(gate)
      );
  }

  return db
    .insert(oidcRefreshTokens)
    .select(
      db
        .select(refreshTokenSelectColumns(input.values))
        .from(source)
        .where(gate)
    );
}

async function revokeAuthorizationCodeIssuance(
  db: Database,
  code: {
    clientId: string;
    issuedAccessTokenHash: string | null;
    issuedRefreshFamilyId: string | null;
  }
) {
  if (code.issuedRefreshFamilyId) {
    await revokeTokenFamily(db, code.issuedRefreshFamilyId);

    return;
  }

  if (code.issuedAccessTokenHash) {
    await db
      .delete(oidcAccessTokens)
      .where(
        and(
          eq(oidcAccessTokens.tokenHash, code.issuedAccessTokenHash),
          eq(oidcAccessTokens.clientId, code.clientId)
        )
      );
  }
}

async function revokeTokenFamily(db: Database, familyId: string) {
  await db.batch([
    db
      .update(oidcRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oidcRefreshTokens.familyId, familyId)),
    db.delete(oidcAccessTokens).where(eq(oidcAccessTokens.familyId, familyId)),
  ]);
}

async function recordTokenUsage(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    scopes: string[];
    now: Date;
  }
) {
  try {
    await db.batch([
      db
        .update(oidcClients)
        .set({ lastUsedAt: input.now, updatedAt: input.now })
        .where(eq(oidcClients.id, input.clientId)),
      insertOidcAudit(db, {
        eventType: "token.issued",
        subjectUserId: input.userId,
        clientId: input.clientId,
        detail: { scopes: input.scopes },
      }),
    ]);
  } catch (error) {
    console.error("Could not record OIDC token usage", error);
  }
}

export async function exchangeRefreshToken(
  db: Database,
  env: AppEnv["Bindings"],
  input: {
    refreshToken: string;
    client: OidcClient;
    resource: string | null;
  }
) {
  const tokenHash = await hashToken(input.refreshToken);

  const [stored] = await db
    .select()
    .from(oidcRefreshTokens)
    .where(
      and(
        eq(oidcRefreshTokens.tokenHash, tokenHash),
        eq(oidcRefreshTokens.clientId, input.client.id)
      )
    )
    .limit(1);

  if (!stored) throw new OidcError("invalid_grant", "Refresh token is invalid");

  if (stored.expiresAt <= new Date()) {
    throw new OidcError("invalid_grant", "Refresh token is expired");
  }

  if (stored.usedAt || stored.revokedAt) {
    await revokeTokenFamily(db, stored.familyId);
    throw new OidcError("invalid_grant", "Refresh token reuse was detected");
  }

  assertSameResource(stored.resource, input.resource);
  await assertUserCanUseClient(db, input.client, stored.userId);
  validateGrantedScopes(input.client, stored.scopes);

  const prepared = await prepareTokenSet(db, env, {
    client: input.client,
    userId: stored.userId,
    scopes: stored.scopes,
    resource: stored.resource,
    authTime: stored.authTime,
    familyId: stored.familyId,
  });

  if (!prepared.refreshTokenValues) {
    throw new OidcError(
      "server_error",
      "Refresh token scopes cannot produce a replacement",
      500
    );
  }

  const replacementTokenHash = prepared.refreshTokenValues.tokenHash;

  const [consumed] = await db.batch([
    db
      .update(oidcRefreshTokens)
      .set({
        usedAt: prepared.now,
        replacedByTokenHash: replacementTokenHash,
      })
      .where(
        and(
          eq(oidcRefreshTokens.tokenHash, tokenHash),
          isNull(oidcRefreshTokens.usedAt),
          isNull(oidcRefreshTokens.revokedAt),
          isNull(oidcRefreshTokens.replacedByTokenHash),
          gt(oidcRefreshTokens.expiresAt, prepared.now)
        )
      )
      .returning({ tokenHash: oidcRefreshTokens.tokenHash }),
    conditionalTokenInsert(db, {
      table: "access",
      values: prepared.accessTokenValues,
      from: "refresh_rotation",
      previousTokenHash: tokenHash,
      replacementTokenHash,
    }),
    conditionalTokenInsert(db, {
      table: "refresh",
      values: prepared.refreshTokenValues,
      from: "refresh_rotation",
      previousTokenHash: tokenHash,
      replacementTokenHash,
    }),
  ]);

  if (consumed.length === 0) {
    const [current] = await db
      .select()
      .from(oidcRefreshTokens)
      .where(eq(oidcRefreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!current || current.expiresAt <= new Date()) {
      throw new OidcError("invalid_grant", "Refresh token is expired");
    }

    await revokeTokenFamily(db, current.familyId);
    throw new OidcError("invalid_grant", "Refresh token was already used");
  }

  await recordTokenUsage(db, {
    clientId: input.client.id,
    userId: stored.userId,
    scopes: stored.scopes,
    now: prepared.now,
  });

  return prepared.response;
}

export async function userInfoForAccessToken(
  db: Database,
  rawToken: string,
  /** The issuer's origin, where the `picture` is served. */
  origin: string
) {
  const [token] = await db
    .select({
      clientId: oidcAccessTokens.clientId,
      userId: oidcAccessTokens.userId,
      scopes: oidcAccessTokens.scopes,
    })
    .from(oidcAccessTokens)
    .where(
      and(
        eq(oidcAccessTokens.tokenHash, await hashToken(rawToken)),
        gt(oidcAccessTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!token) {
    throw new OidcError("invalid_token", "Access token is invalid", 401);
  }

  const client = await findEnabledClient(db, token.clientId);
  await assertUserCanUseClient(db, client, token.userId);

  return {
    client,
    claims: {
      sub: token.userId,
      ...(await identityClaims(db, { ...token, origin })),
    },
  };
}

export async function revokeToken(
  db: Database,
  rawToken: string,
  clientId: string
) {
  const tokenHash = await hashToken(rawToken);

  const [refresh] = await db
    .select({
      familyId: oidcRefreshTokens.familyId,
      userId: oidcRefreshTokens.userId,
    })
    .from(oidcRefreshTokens)
    .where(
      and(
        eq(oidcRefreshTokens.tokenHash, tokenHash),
        eq(oidcRefreshTokens.clientId, clientId)
      )
    )
    .limit(1);

  if (refresh) {
    await revokeTokenFamily(db, refresh.familyId);
  } else {
    await db
      .delete(oidcAccessTokens)
      .where(
        and(
          eq(oidcAccessTokens.tokenHash, tokenHash),
          eq(oidcAccessTokens.clientId, clientId)
        )
      );
  }

  await insertOidcAudit(db, {
    eventType: "token.revoked",
    clientId,
  });
}

export async function cleanupExpiredOidcArtifacts(db: Database) {
  const now = new Date();

  const usedCodeRetentionCutoff = new Date(
    now.getTime() - REFRESH_TOKEN_TTL_MS
  );

  await db.batch([
    db
      .delete(oidcAuthorizationRequests)
      .where(lte(oidcAuthorizationRequests.expiresAt, now)),
    db
      .delete(oidcAuthorizationCodes)
      .where(
        or(
          and(
            isNull(oidcAuthorizationCodes.usedAt),
            lte(oidcAuthorizationCodes.expiresAt, now)
          ),
          and(
            isNotNull(oidcAuthorizationCodes.usedAt),
            lte(oidcAuthorizationCodes.usedAt, usedCodeRetentionCutoff)
          )
        )
      ),
    db.delete(oidcAccessTokens).where(lte(oidcAccessTokens.expiresAt, now)),
    db.delete(oidcRefreshTokens).where(lte(oidcRefreshTokens.expiresAt, now)),
    // Self-registered clients nobody authorized within a day are abandoned
    // registrations (or spam); everything they own cascades with them.
    db.delete(oidcClients).where(
      and(
        sql`${oidcClients.registration} <> 'admin'`,
        // One an administrator turned off stays, so it cannot come back.
        eq(oidcClients.enabled, true),
        lte(
          oidcClients.createdAt,
          new Date(now.getTime() - ABANDONED_CLIENT_TTL_MS)
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${oidcGrants} WHERE ${oidcGrants.clientId} = ${oidcClients.id})`
      )
    ),
  ]);
}

/**
 * Everything that lets `clientId` act for people: tokens, consents, codes and
 * authorizations in progress; for one person, or for everyone.
 */
export function clientAccessRevocations(
  db: Database,
  clientId: string,
  userId?: string
) {
  const revoke = (
    table:
      | typeof oidcAccessTokens
      | typeof oidcRefreshTokens
      | typeof oidcGrants
      | typeof oidcAuthorizationCodes
      | typeof oidcAuthorizationRequests
  ) =>
    db
      .delete(table)
      .where(
        and(
          eq(table.clientId, clientId),
          userId ? eq(table.userId, userId) : undefined
        )
      );

  return [
    revoke(oidcAccessTokens),
    revoke(oidcRefreshTokens),
    revoke(oidcGrants),
    revoke(oidcAuthorizationCodes),
    revoke(oidcAuthorizationRequests),
  ] as const;
}

type OidcAuditInput = {
  eventType: string;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  clientId?: string | null;
  detail?: OidcAuditDetail;
};

export function insertOidcAudit(db: Database, input: OidcAuditInput) {
  return db.insert(oidcAuditEvents).values({
    id: createId("evt"),
    eventType: input.eventType,
    actorUserId: input.actorUserId ?? null,
    subjectUserId: input.subjectUserId ?? null,
    clientId: input.clientId ?? null,
    detail: input.detail,
  });
}
