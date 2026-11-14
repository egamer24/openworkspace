import { Hono } from "hono";

import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { readBounded } from "../lib/stream";
import { zValidator } from "../lib/validator";
import { workspaceModules } from "../modules";
import { coreBackupSchema, restoreCoreBackup } from "./core-data";
import { backupStatus, runBackupTick, startBackupRun } from "./job";

/** How long Run now works after it answers; the hourly cron does the rest. */
const RUN_NOW_BUDGET_MS = 20_000;

/** A restored line and its object: mail's 25 MiB, and room for the line. */
const MAX_RESTORE_BYTES = 26 * 1024 * 1024;

/**
 * Administration → Backups, at /api/admin/backups: administrators only (the
 * admin access guard keeps sections without a permission to them), and an
 * app needs `admin.workspace`.
 */
export const backupAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) =>
    c.json({ ok: true as const, ...(await backupStatus(c.env)) })
  )
  .post("/run", async (c) => {
    if (!(await backupStatus(c.env)).enabled) {
      return apiError(
        c,
        409,
        "NOT_READY",
        "Backups are off: deploy with OpenWorkspace({ backups: {} })"
      );
    }

    const id = await startBackupRun(c.env);

    if (!id) return apiError(c, 409, "CONFLICT", "A backup is already running");
    c.executionCtx.waitUntil(
      runBackupTick(c.env, new Date(), RUN_NOW_BUDGET_MS)
    );

    return c.json({ ok: true as const, id }, 202);
  })
  /** `import backup`: core.json, before any module's lines. */
  .post("/restore", zValidator("json", coreBackupSchema), async (c) => {
    const restored = await restoreCoreBackup(
      c.env,
      createDb(c.env.DB),
      c.req.valid("json"),
      c.get("user").id
    );

    return c.json({ ok: true as const, restored });
  })
  /**
   * `import backup`: one line of a module's part, as JSON, then a newline
   * and the bytes of the object it names, if any.
   */
  .post("/restore/:module", async (c) => {
    const module = workspaceModules().find(
      (candidate) => candidate.name === c.req.param("module")
    );

    if (!module?.backup) {
      return apiError(c, 404, "NOT_FOUND", "No such module backs up here");
    }

    const { bytes, complete } = await readBounded(
      c.req.raw.body,
      MAX_RESTORE_BYTES
    );

    if (!complete) {
      return apiError(c, 413, "TOO_LARGE", "The line and object are too large");
    }

    const newline = bytes.indexOf(10);
    let line: unknown;

    try {
      line = JSON.parse(
        new TextDecoder().decode(
          newline === -1 ? bytes : bytes.subarray(0, newline)
        )
      );
    } catch {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "The body starts with a JSON line"
      );
    }

    const object = newline === -1 ? null : bytes.subarray(newline + 1);

    const result = await module.backup.restore(c, {
      folder: c.req.query("folder") ?? "",
      line,
      object: object?.byteLength ? object : null,
    });

    return c.json({ ok: true as const, ...result });
  });
