import { and, desc, eq, gt } from "drizzle-orm";

import type { Database } from "../db/client";
import { sessions } from "../db/schema";
import { moduleHookStatements } from "../modules";

export async function sessionsForUser(
  db: Database,
  userId: string,
  currentSessionId: string
) {
  const rows = await db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      location: sessions.location,
      ipAddress: sessions.ipAddress,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.createdAt), desc(sessions.id));

  return rows.map((row) => ({
    ...row,
    isCurrent: row.id === currentSessionId,
  }));
}

/**
 * Ends one of a person's sessions on purpose, with what the modules keep
 * for its device in the same D1 batch; null when they have no such session.
 */
export async function revokeUserSession(
  db: Database,
  userId: string,
  sessionId: string
) {
  const [[revoked]] = await db.batch([
    db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning({ id: sessions.id }),
    ...moduleHookStatements("sessionRevoked", db, { userId, sessionId }),
  ]);

  return revoked ?? null;
}
