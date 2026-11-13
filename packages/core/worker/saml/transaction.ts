import { and, eq, exists, gt, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { SessionAtomicActionFactory } from "../auth/session";
import type { Database } from "../db/client";
import { samlApplications, samlAuthnRequests, sessions } from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { SAML_REQUEST_TTL_MS, samlReplayCleanupBefore } from "./constants";
import { SamlError } from "./errors";

function cookieName(requestId: string) {
  return `op_saml_${requestId.replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;
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

export async function createSamlTransaction(
  db: Database,
  input: {
    applicationId: string;
    spRequestId: string | null;
    acsUrl: string;
    relayState: string | null;
    requestedSpNameQualifier: string | null;
    allowNameIdCreation: boolean;
    authenticated?: { userId: string; authTime: Date };
  }
) {
  const id = createId("samlreq");
  const browserSecret = input.authenticated ? null : randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SAML_REQUEST_TTL_MS);
  await db
    .delete(samlAuthnRequests)
    .where(lt(samlAuthnRequests.expiresAt, samlReplayCleanupBefore(now)));

  try {
    await db.insert(samlAuthnRequests).values({
      id,
      applicationId: input.applicationId,
      userId: input.authenticated?.userId ?? null,
      spRequestId: input.spRequestId,
      acsUrl: input.acsUrl,
      relayState: input.relayState,
      requestedSpNameQualifier: input.requestedSpNameQualifier,
      allowNameIdCreation: input.allowNameIdCreation,
      status: input.authenticated ? "authenticated" : "awaiting_login",
      browserSecretHash: browserSecret ? await hashToken(browserSecret) : null,
      authTime: input.authenticated?.authTime ?? null,
      expiresAt,
      createdAt: now,
    });
  } catch (error) {
    if (input.spRequestId) {
      const [existing] = await db
        .select({ id: samlAuthnRequests.id })
        .from(samlAuthnRequests)
        .where(
          and(
            eq(samlAuthnRequests.applicationId, input.applicationId),
            eq(samlAuthnRequests.spRequestId, input.spRequestId)
          )
        )
        .limit(1);

      if (existing) {
        throw new SamlError("AuthnRequest has already been used", 409);
      }
    }

    throw error;
  }

  return { id, browserSecret, expiresAt };
}

export function setSamlTransactionCookie(
  c: Context<AppEnv>,
  transaction: { id: string; browserSecret: string | null; expiresAt: Date }
) {
  if (!transaction.browserSecret) return;
  setCookie(
    c,
    cookieName(transaction.id),
    transaction.browserSecret,
    cookieOptions(c.req.raw, transaction.expiresAt)
  );
}

export function clearSamlTransactionCookie(
  c: Context<AppEnv>,
  requestId: string
) {
  deleteCookie(c, cookieName(requestId), cookieOptions(c.req.raw));
}

export async function browserSamlTransaction(
  db: Database,
  c: Context<AppEnv>,
  requestId: string
) {
  const browserSecret = getCookie(c, cookieName(requestId));

  if (!browserSecret) {
    throw new SamlError("SAML login transaction is not bound to this browser");
  }

  const [transaction] = await db
    .select({
      id: samlAuthnRequests.id,
      applicationId: samlAuthnRequests.applicationId,
      applicationName: samlApplications.name,
      browserSecretHash: samlAuthnRequests.browserSecretHash,
      expiresAt: samlAuthnRequests.expiresAt,
    })
    .from(samlAuthnRequests)
    .innerJoin(
      samlApplications,
      eq(samlAuthnRequests.applicationId, samlApplications.id)
    )
    .where(
      and(
        eq(samlAuthnRequests.id, requestId),
        eq(samlAuthnRequests.status, "awaiting_login"),
        eq(samlApplications.enabled, true),
        gt(samlAuthnRequests.expiresAt, new Date())
      )
    )
    .limit(1);

  if (
    !transaction?.browserSecretHash ||
    (await hashToken(browserSecret)) !== transaction.browserSecretHash
  ) {
    throw new SamlError("SAML login transaction is invalid or expired");
  }

  return transaction;
}

export function prepareSamlTransactionCommit(
  db: Database,
  requestId: string,
  userId: string
): SessionAtomicActionFactory {
  return ({ authenticatedAt, sessionId, sessionTokenHash }) => {
    const now = new Date();

    const pendingTransaction = exists(
      db
        .select({ id: samlAuthnRequests.id })
        .from(samlAuthnRequests)
        .where(
          and(
            eq(samlAuthnRequests.id, requestId),
            eq(samlAuthnRequests.status, "awaiting_login"),
            gt(samlAuthnRequests.expiresAt, now)
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
        .update(samlAuthnRequests)
        .set({
          userId,
          authTime: authenticatedAt,
          status: "authenticated",
          browserSecretHash: null,
        })
        .where(
          and(
            eq(samlAuthnRequests.id, requestId),
            eq(samlAuthnRequests.status, "awaiting_login"),
            gt(samlAuthnRequests.expiresAt, now),
            committedSession
          )
        )
        .returning({ id: samlAuthnRequests.id }),
      assertCommitted(committed: boolean) {
        if (committed) return;
        throw new SamlError("SAML login transaction is invalid or expired");
      },
    };
  };
}
