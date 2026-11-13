import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { AccessLinkKind } from "../../shared/auth";
import { mailDomainAllowed, mailDomainRefusal } from "../config/mail-domains";
import type { Database } from "../db/client";
import { violatesConstraintOn } from "../db/errors";
import { challengePayloadSchema } from "../db/json";
import { mailboxAddressSql } from "../db/mailboxes";
import {
  accessLinkClaims,
  accessLinks,
  mailboxes,
  passkeyCredentials,
  users,
} from "../db/schema";
import { hashToken } from "../lib/crypto";
import type { RelyingPartyEnv } from "../lib/http";
import { createId, normalizeMailboxAddress } from "../lib/ids";
import { AuthRequestError, authConflict } from "./errors";
import {
  FirstAccountTakenError,
  provisionBootstrapAccount,
} from "./personal-account";
import { revokeUserAccess } from "./revocation";
import {
  beginAuthentication,
  beginRegistration,
  consumeChallenge,
  finishAuthentication,
  finishRegistration,
} from "./webauthn";

/** The first administrator's records, or a conflict when another setup got there first. */
async function provisionFirstAccount(
  ...args: Parameters<typeof provisionBootstrapAccount>
) {
  try {
    return await provisionBootstrapAccount(...args);
  } catch (error) {
    if (error instanceof FirstAccountTakenError) {
      throw authConflict(error.message);
    }

    throw error;
  }
}

export async function hasUsers(db: Database) {
  const [user] = await db.select({ id: users.id }).from(users).limit(1);

  return Boolean(user);
}

export async function beginBootstrap(
  db: Database,
  env: RelyingPartyEnv,
  input: { name: string; email: string }
) {
  if (await hasUsers(db)) throw authConflict("Account is already set up");

  if (!mailDomainAllowed(input.email)) {
    throw new AuthRequestError(mailDomainRefusal());
  }

  const userId = createId("usr");

  // userId lives in payload only — the users row is created on verify, so the
  // auth_challenges.user_id FK must stay null during bootstrap.
  return beginRegistration(db, env, {
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

/** What `beginBootstrap` keeps for the first account. */
const bootstrapPayloadSchema = challengePayloadSchema.required({
  name: true,
  email: true,
});

export async function finishBootstrap(
  db: Database,
  challengeId: string | undefined,
  response: RegistrationResponseJSON
) {
  const challenge = await consumeChallenge(db, challengeId, "bootstrap");

  const parsed = bootstrapPayloadSchema.safeParse(challenge.payload);
  const userId = parsed.data?.userId ?? challenge.userId;

  if (!parsed.success || !userId) {
    throw new AuthRequestError("Bootstrap challenge is invalid");
  }

  const payload = parsed.data;

  const credential = await finishRegistration(challenge, response);
  const mailboxId = createId("mbx");
  const now = new Date();
  await provisionFirstAccount(db, {
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
  env: RelyingPartyEnv,
  identityRequest?: { oidcRequestId?: string; samlRequestId?: string }
) {
  if (!(await hasUsers(db))) {
    throw new AuthRequestError("Set up the first account first");
  }

  return beginAuthentication(
    db,
    env,
    identityRequest?.oidcRequestId || identityRequest?.samlRequestId
      ? identityRequest
      : undefined
  );
}

export async function finishLogin(
  db: Database,
  challengeId: string | undefined,
  response: AuthenticationResponseJSON
) {
  const challenge = await consumeChallenge(db, challengeId, "authentication");
  const userId = await finishAuthentication(db, challenge, response);
  const payload = challengePayloadSchema.safeParse(challenge.payload).data;

  return {
    userId,
    oidcRequestId: payload?.oidcRequestId,
    samlRequestId: payload?.samlRequestId,
  };
}

async function findAccessLink(
  db: Database,
  token: string,
  kind: AccessLinkKind
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
      and(eq(mailboxes.ownerUserId, users.id), eq(mailboxes.isPrimary, true))
    )
    .where(
      and(
        eq(accessLinks.kind, kind),
        eq(accessLinks.tokenHash, tokenHash),
        isNull(accessLinks.consumedAt),
        gt(accessLinks.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!link) {
    throw new AuthRequestError(
      `${kind === "invitation" ? "Invitation" : "Recovery link"} is invalid or has expired`
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
  kind: AccessLinkKind
) {
  const link = await findAccessLink(db, token, kind);

  return {
    name: link.name,
    email: link.email,
  };
}

export async function beginAccessLinkRegistration(
  db: Database,
  env: RelyingPartyEnv,
  token: string,
  kind: AccessLinkKind
) {
  const link = await findAccessLink(db, token, kind);

  return beginRegistration(db, env, {
    kind,
    userId: link.userId,
    userName: link.email,
    userDisplayName: link.name,
    accessLinkId: link.id,
  });
}

export async function finishAccessLinkRegistration(
  env: Env,
  db: Database,
  challengeId: string | undefined,
  response: RegistrationResponseJSON,
  kind: AccessLinkKind,
  defer: (task: Promise<unknown>) => void
) {
  const challenge = await consumeChallenge(db, challengeId, kind);

  if (!challenge.userId || !challenge.accessLinkId) {
    throw new AuthRequestError("Access-link challenge is invalid");
  }

  const credential = await finishRegistration(challenge, response);
  const now = new Date();
  const { accessLinkId } = challenge;

  // The claim takes the link's id only while the link is this person's, of
  // this kind, unused and unexpired; otherwise the id is NULL, the NOT NULL
  // primary key fails, and the whole batch (passkey included) rolls back.
  // Of two redemptions at once, the second finds the link consumed.
  const claim = db.insert(accessLinkClaims).values({
    accessLinkId: sql`(
      SELECT ${accessLinks.id} FROM ${accessLinks}
      WHERE ${accessLinks.id} = ${accessLinkId}
        AND ${accessLinks.userId} = ${challenge.userId}
        AND ${accessLinks.kind} = ${kind}
        AND ${accessLinks.consumedAt} IS NULL
        AND ${accessLinks.expiresAt} > ${now.getTime()}
    )`,
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

  try {
    if (kind === "recovery") {
      // The new passkey replaces every old one, and whoever held an old one or
      // a session keeps nothing: apps' tokens and consents go as on disabling.
      await revokeUserAccess(env, db, challenge.userId, {
        alongside: [
          claim,
          db
            .delete(passkeyCredentials)
            .where(eq(passkeyCredentials.userId, challenge.userId)),
          insertCredential,
          consumeLink,
        ],
        keepAccessLinkId: challenge.accessLinkId,
        defer,
      });
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
  } catch (error) {
    if (violatesConstraintOn(error, "access_link_claims.access_link_id")) {
      throw new AuthRequestError("Access link is invalid or expired", {
        cause: error,
      });
    }

    throw error;
  }

  return challenge.userId;
}
