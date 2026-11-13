import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { clearAuthCookies } from "../auth/session";
import { revokeUserSession, sessionsForUser } from "../auth/session-records";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";

export const userSessionAdminRoutes = new Hono<AppEnv>()
  .get("/users/:userId/sessions", async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.req.param("userId");

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return apiError(c, 404, "NOT_FOUND", "User not found");

    const sessions = await sessionsForUser(db, userId, c.get("sessionId"));

    return c.json({ ok: true as const, sessions });
  })
  .delete("/users/:userId/sessions/:sessionId", async (c) => {
    const userId = c.req.param("userId");
    const sessionId = c.req.param("sessionId");

    const revoked = await revokeUserSession(
      createDb(c.env.DB),
      userId,
      sessionId
    );

    if (!revoked) {
      return apiError(c, 404, "NOT_FOUND", "Session not found");
    }

    const current = sessionId === c.get("sessionId");

    if (current) clearAuthCookies(c);

    return c.json({ ok: true as const, revokedSessionId: sessionId, current });
  });
