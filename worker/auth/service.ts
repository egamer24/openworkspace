import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AccessLinkKind } from "../../shared/auth";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  accessLinkClaims,
  accessLinks,
  accountApiTokens,
  domains,
  mailboxes,
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcAuthorizationRequests,
  oidcGrants,
  oidcRefreshTokens,
  passkeyCredentials,
  pushSubscriptions,
  samlAuthnRequests,
  sessions,
  users,
} from "../db/schema";
import { hashToken } from "../lib/crypto";
import { createId, normalizeMailboxAddress } from "../lib/ids";
import { mailboxAddressSql } from "../db/mailboxes";
import {
  beginAuthentication,
  beginRegistration,
  consumeChallenge,
  finishAuthentication,
  finishRegistration,
} from "./webauthn";
import { provisionBootstrapAccount } from "./personal-account";
import { AuthRequestError, authConflict } from "./errors";

// Everything a relying party can still use on the user's behalf: pending
// OIDC/SAML requests, issued tokens, and remembered consent.
export function federatedAccessRevocations(db: Database, userId: string) {
  return [
    db
      .delete(oidcAuthorizationRequests)
      .where(eq(oidcAuthorizationRequests.userId, userId)),
    db
      .delete(oidcAuthorizationCodes)
      .where(eq(oidcAuthorizationCodes.userId, userId)),
    db.delete(oidcAccessTokens).where(eq(oidcAccessTokens.userId, userId)),
    db.delete(oidcRefreshTokens).where(eq(oidcRefreshTokens.userId, userId)),
    db.delete(oidcGrants).where(eq(oidcGrants.userId, userId)),
    db.delete(samlAuthnRequests).where(eq(samlAuthnRequests.userId, userId)),
  ] as const;
}

export async function hasUsers(db: Database) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .limit(1);
  return Boolean(user);
}

export async function beginBootstrap(
  db: Database,
  request: Request,
  input: { name: string; email: string },
) {
  if (await hasUsers(db)) throw authConflict("Account is already set up");
  const userId = createId("usr");
  // userId lives in payload only — the users row is created on verify, so the
  // auth_challenges.user_id FK must stay null during bootstrap.
  return beginRegistration(db, request, {
    kind: "bootstrap",
    userId,
    userName: normalizeMailboxAddress(input.email),
    userDisplayName: input.name.trim(),
    payload: {
      name: input.name.trim(),
      email: normalizeMailboxAddress(input.email),
      userId,
    },
  });
}

export async function finishBootstrap(
  db: Database,
  challengeId: string | undefined,
  response: RegistrationResponseJSON,
) {
  const challenge = await consumeChallenge(db, challengeId, "bootstrap");
  const payload = challenge.payload as {
    name?: unknown;
    email?: unknown;
    userId?: unknown;
  };
  const userId =
    typeof payload.userId === "string" ? payload.userId : challenge.userId;
  if (
    !userId ||
    typeof payload.name !== "string" ||
    typeof payload.email !== "string"
  ) {
    throw new AuthRequestError("Bootstrap challenge is invalid");
  }
  const credential = await finishRegistration(challenge, response);
  const mailboxId = createId("mbx");
  const now = new Date();
  await provisionBootstrapAccount(db, {
    userId,
    mailboxId,
    name: payload.name,
    email: payload.email,
    role: "admin",
    status: "active",
    createdByUserId: userId,
    now,
    credential: {
      ...credential,
      userId,
      label: "Primary passkey",
      createdAt: now,
    },
  });

  return userId;
}

export async function beginLogin(
  db: Database,
  request: Request,
  identityRequest?: { oidcRequestId?: string; samlRequestId?: string },
) {
  if (!(await hasUsers(db))) {
    throw new AuthRequestError("Set up the first account first");
  }
  return beginAuthentication(
    db,
    request,
    identityRequest?.oidcRequestId || identityRequest?.samlRequestId
      ? identityRequest
      : undefined,
  );
}

export async function finishLogin(
  db: Database,
  challengeId: string | undefined,
  response: AuthenticationResponseJSON,
) {
  const challenge = await consumeChallenge(db, challengeId, "authentication");
  const userId = await finishAuthentication(db, challenge, response);
  return {
    userId,
    oidcRequestId:
      typeof challenge.payload?.oidcRequestId === "string"
        ? challenge.payload.oidcRequestId
        : undefined,
    samlRequestId:
      typeof challenge.payload?.samlRequestId === "string"
        ? challenge.payload.samlRequestId
        : undefined,
  };
}

async function findAccessLink(
  db: Database,
  token: string,
  kind: AccessLinkKind,
) {
  const tokenHash = await hashToken(token);
  const [link] = await db
    .select({
      id: accessLinks.id,
      userId: users.id,
      name: users.name,
      status: users.status,
      email: mailboxAddressSql,
    })
    .from(accessLinks)
    .innerJoin(users, eq(accessLinks.userId, users.id))
    .leftJoin(
      mailboxes,
      and(
        eq(mailboxes.ownerUserId, users.id),
        eq(mailboxes.isPrimary, true),
      ),
    )
    .leftJoin(domains, eq(mailboxes.domainId, domains.id))
    .where(
      and(
        eq(accessLinks.kind, kind),
        eq(accessLinks.tokenHash, tokenHash),
        isNull(accessLinks.consumedAt),
        gt(accessLinks.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!link) {
    throw new AuthRequestError(
      `${kind === "invitation" ? "Invitation" : "Recovery link"} is invalid or has expired`,
    );
  }
  if (kind === "invitation" && link.status !== "invited") {
    throw new AuthRequestError("Invitation has already been completed");
  }
  if (kind === "recovery" && link.status !== "active") {
    throw new AuthRequestError("Only an active account can be recovered");
  }
  if (!link.email) {
    throw new AuthRequestError("Account has no personal mailbox");
  }
  return { ...link, email: link.email };
}

export async function getAccessLinkPreview(
  db: Database,
  token: string,
  kind: AccessLinkKind,
) {
  const link = await findAccessLink(db, token, kind);
  return {
    name: link.name,
    email: link.email,
  };
}

export async function beginAccessLinkRegistration(
  db: Database,
  request: Request,
  token: string,
  kind: AccessLinkKind,
) {
  const link = await findAccessLink(db, token, kind);

  return beginRegistration(db, request, {
    kind,
    userId: link.userId,
    userName: link.email,
    userDisplayName: link.name,
    accessLinkId: link.id,
  });
}

export async function finishAccessLinkRegistration(
  db: Database,
  challengeId: string | undefined,
  response: RegistrationResponseJSON,
  kind: AccessLinkKind,
) {
  const challenge = await consumeChallenge(db, challengeId, kind);
  if (!challenge.userId || !challenge.accessLinkId) {
    throw new AuthRequestError("Access-link challenge is invalid");
  }
  const credential = await finishRegistration(challenge, response);
  const now = new Date();
  const [activeLink] = await db
    .select({ id: accessLinks.id })
    .from(accessLinks)
    .where(
      and(
        eq(accessLinks.id, challenge.accessLinkId),
        eq(accessLinks.userId, challenge.userId),
        eq(accessLinks.kind, kind),
        isNull(accessLinks.consumedAt),
        gt(accessLinks.expiresAt, now),
      ),
    )
    .limit(1);
  if (!activeLink) {
    throw new AuthRequestError(
      `${kind === "invitation" ? "Invitation" : "Recovery link"} is invalid or has expired`,
    );
  }
  const claim = db.insert(accessLinkClaims).values({
      accessLinkId: challenge.accessLinkId,
      userId: challenge.userId,
      credentialId: credential.credentialId,
      claimedAt: now,
    });
  const insertCredential = db.insert(passkeyCredentials).values({
      ...credential,
      userId: challenge.userId,
      label: kind === "recovery" ? "Recovered passkey" : "Primary passkey",
      createdAt: now,
    });
  const consumeLink = db
      .update(accessLinks)
      .set({ consumedAt: now })
      .where(eq(accessLinks.id, challenge.accessLinkId));

  if (kind === "recovery") {
    await db.batch([
      claim,
      db
        .delete(passkeyCredentials)
        .where(eq(passkeyCredentials.userId, challenge.userId)),
      db.delete(sessions).where(eq(sessions.userId, challenge.userId)),
      db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, challenge.userId)),
      db
        .delete(accountApiTokens)
        .where(eq(accountApiTokens.userId, challenge.userId)),
      ...federatedAccessRevocations(db, challenge.userId),
      insertCredential,
      consumeLink,
    ] as const);
  } else {
    await db.batch([
      claim,
      insertCredential,
      db
        .update(users)
        .set({ status: "active", updatedAt: now })
        .where(eq(users.id, challenge.userId)),
      consumeLink,
    ] as const);
  }
  return challenge.userId;
}
