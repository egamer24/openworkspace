import { Hono } from "hono";
import { backupStatus, runBackupTick, startBackupRun } from "../backups/job";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";

/** Steps run in the request's waitUntil; the hourly cron continues the rest. */
const RUN_NOW_STEPS = 4;

export const backupAdminRoutes = new Hono<AppEnv>()
  .get("/backups", async (c) => c.json({ ok: true as const, ...await backupStatus(c.env) }))
  .post("/backups/run", async (c) => {
    if (!c.env.BACKUP_STORAGE) {
      return apiError(c, 409, "NOT_READY", "Bind a BACKUP_STORAGE R2 bucket to enable backups");
    }
    const runId = await startBackupRun(c.env);
    if (!runId) return apiError(c, 409, "CONFLICT", "A backup is already running");
    c.executionCtx.waitUntil(runBackupTick(c.env, new Date(), RUN_NOW_STEPS));
    return c.json({ ok: true as const, runId }, 202);
  });
