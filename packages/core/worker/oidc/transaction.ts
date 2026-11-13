import { and, eq, exists, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { SessionAtomicActionFactory } from "../auth/session";
import type { Database } from "../db/client";
import { oidcAuthorizationRequests, oidcClients, sessions } from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { AUTHORIZATION_REQUEST_TTL_MS } from "./constants";
import { OidcError } from "./errors";

function cookieName(requestId: string) {
  return `op_oidc_${requestId.replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;
}

function cookieOptions(request: Request, expires?: Date) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    expires,
  };
}

export async function createLoginTransaction(
  db: Database,
  input: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    resource: string | null;
    state?: string | null;
    nonce?: string | null;
    codeChallenge: string;
    forceConsent: boolean;
  }
) {
  const id = createId("req");
  const browserSecret = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AUTHORIZATION_REQUEST_TTL_MS);
  await db.insert(oidcAuthorizationRequests).values({
    id,
    clientId: input.clientId,
    userId: null,
    status: "awaiting_login",
    browserSecretHash: await hashToken(browserSecret),
    forceConsent: input.forceConsent,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    resource: input.resource,
    state: input.state ?? null,
    nonce: input.nonce ?? null,
    codeChallenge: input.codeChallenge,
    authTime: null,
    expiresAt,
    createdAt: now,
  });

  return { id, browserSecret, expiresAt };
}

export function setLoginTransactionCookie(
  c: Context<AppEnv>,
  transaction: {
    id: string;
    browserSecret: string;
    expiresAt: Date;
  }
) {
  setCookie(
    c,
    cookieName(transaction.id),
    transaction.browserSecret,
    cookieOptions(c.req.raw, transaction.expiresAt)
  );
}

export function clearLoginTransactionCookie(
  c: Context<AppEnv>,
  requestId: string
) {
  deleteCookie(c, cookieName(requestId), cookieOptions(c.req.raw));
}

export async function browserLoginTransaction(
  db: Database,
  c: Context<AppEnv>,
  requestId: string
) {
  const browserSecret = getCookie(c, cookieName(requestId));

  if (!browserSecret) {
    throw new OidcError(
      "invalid_request",
      "OIDC login transaction is not bound to this browser"
    );
  }

  const [transaction] = await db
    .select({
      id: oidcAuthorizationRequests.id,
      clientId: oidcAuthorizationRequests.clientId,
      clientName: oidcClients.name,
      browserSecretHash: oidcAuthorizationRequests.browserSecretHash,
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
        eq(oidcAuthorizationRequests.status, "awaiting_login"),
        eq(oidcClients.enabled, true),
        gt(oidcAuthorizationRequests.expiresAt, new Date())
      )
    )
    .limit(1);

  if (
    !transaction?.browserSecretHash ||
    (await hashToken(browserSecret)) !== transaction.browserSecretHash
  ) {
    throw new OidcError(
      "invalid_request",
      "OIDC login transaction is invalid or expired"
    );
  }

  return transaction;
}

export function prepareLoginTransactionCommit(
  db: Database,
  requestId: string,
  userId: string
): SessionAtomicActionFactory {
  return ({ authenticatedAt, sessionId, sessionTokenHash }) => {
    const now = new Date();

    const pendingTransaction = exists(
      db
        .select({ id: oidcAuthorizationRequests.id })
        .from(oidcAuthorizationRequests)
        .where(
          and(
            eq(oidcAuthorizationRequests.id, requestId),
            eq(oidcAuthorizationRequests.status, "awaiting_login"),
            gt(oidcAuthorizationRequests.expiresAt, now)
          )
        )
    );

    const committedSession = exists(
      db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.tokenHash, sessionTokenHash)
          )
        )
    );

    return {
      precondition: pendingTransaction,
      commit: db
        .update(oidcAuthorizationRequests)
        .set({
          userId,
          authTime: authenticatedAt,
          status: "authenticated",
          browserSecretHash: null,
        })
        .where(
          and(
            eq(oidcAuthorizationRequests.id, requestId),
            eq(oidcAuthorizationRequests.status, "awaiting_login"),
            gt(oidcAuthorizationRequests.expiresAt, now),
            committedSession
          )
        )
        .returning({ id: oidcAuthorizationRequests.id }),
      assertCommitted(committed: boolean) {
        if (committed) return;
        throw new OidcError(
          "invalid_request",
          "OIDC login transaction is invalid or expired"
        );
      },
    };
  };
}
