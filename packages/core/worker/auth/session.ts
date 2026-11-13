import {
  and,
  desc,
  eq,
  exists,
  gt,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { sessions, users } from "../db/schema";
import type { AppEnv } from "../env";
import type { BatchStatements } from "../lib/batch";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { cloudflareClientIp } from "../lib/request";
import { moduleHookStatements } from "../modules";
import {
  DEV_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./constants";
import { AuthRequestError } from "./errors";

const MAX_SESSIONS = 10;

// D1 owns the shorter renewable lease. The long browser cookie avoids rotating
// a bearer from ordinary requests, so a slow response cannot restore an older
// token after a fresh sign-in.
const BROWSER_COOKIE_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export type SessionCommitInput = {
  authenticatedAt: Date;
  sessionId: string;
  sessionTokenHash: string;
};

export type SessionAtomicAction = {
  precondition: SQL;
  commit: BatchItem<"sqlite">;
  /** Throws unless the commit statement changed its row. */
  assertCommitted: (committed: boolean) => void;
};

export type SessionAtomicActionFactory = (
  input: SessionCommitInput
) => SessionAtomicAction;

/**
 * The session cookie's name and attributes for this request. Everywhere but
 * local development over plain HTTP it is `__Host-op_session`: Secure,
 * Path=/, no Domain. Local development is a mock-auth workspace (the
 * ALLOW_MOCK_AUTH flag that `bun run dev` and the test stacks set) served
 * over HTTP; anything served over HTTPS always gets the Secure cookie.
 */
export function sessionCookie(
  request: Request,
  env: Pick<AppEnv["Bindings"], "ALLOW_MOCK_AUTH">,
  expires?: Date
) {
  const localHttp =
    env.ALLOW_MOCK_AUTH === "true" && new URL(request.url).protocol === "http:";

  return {
    name: localHttp ? DEV_SESSION_COOKIE : SESSION_COOKIE,
    options: {
      httpOnly: true,
      sameSite: "Lax" as const,
      secure: !localHttp,
      path: "/",
      expires,
    },
  };
}

function sessionExpiresAt(from: Date) {
  return new Date(from.getTime() + SESSION_TTL_MS);
}

/** The parts of Cloudflare's `request.cf` a session's location shows; any can be missing. */
const requestPlaceSchema = z
  .object({
    city: z.string().optional().catch(undefined),
    region: z.string().optional().catch(undefined),
    country: z.string().optional().catch(undefined),
  })
  .catch({});

function requestLocation(request: Request) {
  const part = (value: string | null | undefined) => value?.trim() || null;
  const cf = requestPlaceSchema.parse(request.cf);

  const values = [
    part(cf.city),
    part(cf.region),
    part(cf.country) ?? part(request.headers.get("cf-ipcountry")),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(values)].join(", ") || null;
}

function sessionExists(db: Database, sessionId: string, tokenHash: string) {
  return exists(
    db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.tokenHash, tokenHash)))
  );
}

function insertSession(
  db: Database,
  values: {
    id: string;
    userId: string;
    tokenHash: string;
    userAgent: string | null;
    location: string | null;
    ipAddress: string | null;
    expiresAt: Date;
    createdAt: Date;
  },
  condition?: SQL
) {
  if (!condition) {
    return db.insert(sessions).values(values).returning({ id: sessions.id });
  }

  // The conditional insert and the optional OIDC state transition execute in
  // one D1 batch. A consumed login transaction therefore cannot mint a session.
  return db
    .insert(sessions)
    .select(sql`
    select
      ${values.id},
      ${values.userId},
      ${values.tokenHash},
      ${values.userAgent},
      ${values.location},
      ${values.ipAddress},
      ${values.expiresAt.getTime()},
      ${values.createdAt.getTime()}
    where ${condition}
  `)
    .returning({ id: sessions.id });
}

function pruneUserSessions(
  db: Database,
  userId: string,
  protectedSessionId: string,
  protectedTokenHash: string
) {
  const newestOtherSessions = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), ne(sessions.id, protectedSessionId))
    )
    .orderBy(desc(sessions.createdAt), desc(sessions.id))
    .limit(MAX_SESSIONS - 1);

  return db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        ne(sessions.id, protectedSessionId),
        sessionExists(db, protectedSessionId, protectedTokenHash),
        notInArray(sessions.id, newestOtherSessions)
      )
    );
}

/** A write's `returning({ id })` result when it changed its row. */
const returnedRowSchema = z.array(z.object({ id: z.string() })).min(1);

export async function establishSession(
  db: Database,
  c: Context<AppEnv>,
  userId: string,
  atomicActionFactory?: SessionAtomicActionFactory
) {
  const authenticatedAt = new Date();
  const previousToken = getCookie(c, sessionCookie(c.req.raw, c.env).name);

  const previousTokenHash = previousToken
    ? await hashToken(previousToken)
    : null;

  const token = randomToken();
  const tokenHash = await hashToken(token);
  const sessionId = createId("ses");

  const atomicAction = atomicActionFactory?.({
    authenticatedAt,
    sessionId,
    sessionTokenHash: tokenHash,
  });

  const currentSession = sessionExists(db, sessionId, tokenHash);

  const writes: BatchStatements = [
    insertSession(
      db,
      {
        id: sessionId,
        userId,
        tokenHash,
        userAgent: c.req.header("user-agent") ?? null,
        location: requestLocation(c.req.raw),
        ipAddress: cloudflareClientIp(c.req.raw),
        expiresAt: sessionExpiresAt(authenticatedAt),
        createdAt: authenticatedAt,
      },
      atomicAction?.precondition
    ),
  ];

  if (previousTokenHash) {
    writes.push(
      db
        .delete(sessions)
        .where(
          and(
            eq(sessions.tokenHash, previousTokenHash),
            ne(sessions.id, sessionId),
            currentSession
          )
        )
    );
  }

  writes.push(pruneUserSessions(db, userId, sessionId, tokenHash));

  if (atomicAction) writes.push(atomicAction.commit);

  const results = await db.batch(writes);

  if (!returnedRowSchema.safeParse(results[0]).success) {
    throw new AuthRequestError("Authentication changed; try again");
  }

  if (atomicAction) {
    atomicAction.assertCommitted(
      returnedRowSchema.safeParse(results.at(-1)).success
    );
  }

  const cookie = sessionCookie(
    c.req.raw,
    c.env,
    new Date(authenticatedAt.getTime() + BROWSER_COOKIE_TTL_MS)
  );

  setCookie(c, cookie.name, token, cookie.options);

  return { authenticatedAt };
}

/**
 * A statement run in the same D1 batch as the session lookup, so a route's
 * first authorization query costs no extra round trip. It must constrain
 * itself to the session with `tokenHash` (and the same validity rules) when
 * its result depends on who is signed in; the result is used only when the
 * session itself is valid.
 */
export type SessionCompanion = (input: {
  c: Context<AppEnv>;
  db: Database;
  tokenHash: string;
  now: Date;
}) => BatchItem<"sqlite"> | null;

export async function readSessionFromContext(
  c: Context<AppEnv>,
  companion?: SessionCompanion
) {
  const { session, companions } = await lookupSession(
    c,
    companion ? [companion] : []
  );

  return session ? { ...session, companion: companions[0] } : null;
}

/**
 * The session of the request's cookie, with what `companions` returned from
 * the same D1 batch (in their order; `undefined` for one that returned no
 * statement). Without a cookie, nothing runs. Companion results come back
 * even when the session is not valid, for statements that do not depend on
 * it; ones that do must not be trusted then.
 */
export async function lookupSession(
  c: Context<AppEnv>,
  companions: readonly SessionCompanion[]
) {
  const token = getCookie(c, sessionCookie(c.req.raw, c.env).name);

  if (!token) return { session: null, companions: [] };

  const db = createDb(c.env.DB);
  const tokenHash = await hashToken(token);
  const now = new Date();

  const sessionQuery = db
    .select({
      // Aliased: in a D1 batch, rows come back keyed by column name, and a
      // second "id" would shift every following field.
      sessionId: sql<string>`${sessions.id}`.as("session_id"),
      id: users.id,
      name: users.name,
      avatarId: users.avatarId,
      role: users.role,
      status: users.status,
      permissions: users.permissions,
      authTime: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, now),
        eq(users.status, "active")
      )
    )
    .limit(1);

  const statements = companions.map((companion) =>
    companion({ c, db, tokenHash, now })
  );

  const batched = statements.filter((statement) => statement !== null);

  const [rows, ...results] = batched.length
    ? await db.batch([sessionQuery, ...batched])
    : [await sessionQuery];

  let next = 0;

  const companionResults = statements.map((statement) =>
    statement ? results[next++] : undefined
  );

  const [row] = rows;

  if (!row) return { session: null, companions: companionResults };

  const { authTime, expiresAt, sessionId, ...user } = row;

  if (expiresAt.getTime() <= now.getTime() + SESSION_TTL_MS / 2) {
    await db
      .update(sessions)
      .set({ expiresAt: sessionExpiresAt(now) })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now),
          lte(sessions.expiresAt, new Date(now.getTime() + SESSION_TTL_MS / 2))
        )
      );
  }

  return {
    session: { id: sessionId, user, authTime, tokenHash },
    companions: companionResults,
  };
}

export async function destroySession(
  db: Database,
  c: Context<AppEnv>,
  identity: {
    sessionId: string;
    userId: string;
  }
) {
  // What the modules keep for the device goes in the same batch, so a
  // failure leaves the session to sign out of again rather than orphans.
  await db.batch([
    db
      .delete(sessions)
      .where(
        and(
          eq(sessions.id, identity.sessionId),
          eq(sessions.userId, identity.userId)
        )
      ),
    ...moduleHookStatements("sessionRevoked", db, identity),
  ]);
  clearAuthCookies(c);
}

export function clearAuthCookies(c: Context<AppEnv>) {
  const cookie = sessionCookie(c.req.raw, c.env);
  deleteCookie(c, cookie.name, cookie.options);
}
