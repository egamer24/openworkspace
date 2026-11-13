import { Hono } from "hono";

import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { requireSessionAuth } from "./middleware";
import { clearAuthCookies } from "./session";
import { revokeUserSession, sessionsForUser } from "./session-records";

export const accountSessionRoutes = new Hono<AppEnv>()
  .use("*", requireSessionAuth)
  .get("/", async (c) => {
    const sessions = await sessionsForUser(
      createDb(c.env.DB),
      c.get("user").id,
      c.get("sessionId")
    );

    return c.json({ ok: true as const, sessions });
  })
  .delete("/:id", async (c) => {
    const sessionId = c.req.param("id");

    const revoked = await revokeUserSession(
      createDb(c.env.DB),
      c.get("user").id,
      sessionId
    );

    if (!revoked) {
      return apiError(c, 404, "NOT_FOUND", "Session not found");
    }

    const current = sessionId === c.get("sessionId");

    if (current) clearAuthCookies(c);

    return c.json({ ok: true as const, revokedSessionId: sessionId, current });
  });
