import {
  apiError,
  oauthScope,
  requireAuth,
  requirePermission,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { Hono } from "hono";

import {
  MAIL_ARCHIVE_SCOPE,
  MANAGE_MAIL_ARCHIVE,
} from "../../shared/permissions";
import { archiveStatus, runArchiveTick } from "./archive";

/** Administration → Mail archive, at /api/mail/archive. */
export const mailArchiveRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .use("*", oauthScope(MAIL_ARCHIVE_SCOPE))
  .use("*", requirePermission(MANAGE_MAIL_ARCHIVE))
  .get("/", async (c) =>
    c.json({ ok: true as const, ...(await archiveStatus(c.env)) })
  )
  /** Archive now: every open entry, without waiting for its backoff. */
  .post("/run", (c) => {
    if (!c.env.MAIL_ARCHIVE) {
      return apiError(
        c,
        409,
        "NOT_READY",
        "The mail archive is off: deploy with Email({ archive: { years } })"
      );
    }

    c.executionCtx.waitUntil(runArchiveTick(c.env, new Date(), true));

    return c.json({ ok: true as const }, 202);
  });
