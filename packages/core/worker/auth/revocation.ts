import { and, eq, isNull, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { required } from "../../shared/invariant";
import type { Database } from "../db/client";
import {
  accessLinks,
  authChallenges,
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcAuthorizationRequests,
  oidcGrants,
  oidcRefreshTokens,
  samlAuthnRequests,
  sessions,
} from "../db/schema";
import { nonEmptyBatch } from "../lib/batch";
import { runModuleHooks } from "../modules";
import {
  queueBackchannelLogouts,
  userBackchannelSessions,
} from "../oidc/backchannel-logout";

/**
 * Everything that lets a person in, short of their passkeys: browser
 * sessions, pending sign-in challenges and access links, and every app's
 * consents, tokens, codes and pending authorizations, OIDC and SAML.
 * `keepAccessLinkId` spares the link being redeemed in the same batch.
 */
function userAccessRevocations(
  db: Database,
  userId: string,
  keepAccessLinkId?: string
) {
  return [
    db.delete(sessions).where(eq(sessions.userId, userId)),
    db.delete(authChallenges).where(eq(authChallenges.userId, userId)),
    db
      .delete(accessLinks)
      .where(
        and(
          eq(accessLinks.userId, userId),
          isNull(accessLinks.consumedAt),
          ...(keepAccessLinkId ? [ne(accessLinks.id, keepAccessLinkId)] : [])
        )
      ),
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

/**
 * Signs a person out of everything: when they are disabled, and when they
 * recover their account (whoever had their passkey or a session must not
 * keep a way in). `alongside` runs first in the same D1 batch, so the
 * change and the revocation land together. Afterwards the modules drop
 * what they keep per device, and apps with back-channel logout are told.
 */
export async function revokeUserAccess(
  env: Env,
  db: Database,
  userId: string,
  options: {
    alongside?: BatchItem<"sqlite">[];
    keepAccessLinkId?: string;
    defer: (task: Promise<unknown>) => void;
  }
) {
  // Read before the revocations erase who was signed in where.
  const loggedOut = await userBackchannelSessions(db, userId);

  const statements = required(
    nonEmptyBatch([
      ...(options.alongside ?? []),
      ...userAccessRevocations(db, userId, options.keepAccessLinkId),
    ]),
    "The revocations are never empty"
  );

  await db.batch(statements);
  await runModuleHooks("sessionsRevoked", db, userId);

  if (loggedOut.length) {
    options.defer(
      queueBackchannelLogouts(env, loggedOut).catch((error) =>
        console.error("Could not queue back-channel logout", error)
      )
    );
  }
}
