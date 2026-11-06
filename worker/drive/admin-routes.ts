import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { DEFAULT_DRIVE_QUOTA_BYTES } from "../../shared/drive";
import { createDb } from "../db/client";
import { driveQuotas, users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { driveQuotaSchema, driveToggleSchema } from "./schemas";
import { driveEnabled, setDriveEnabled } from "./service";

/** Mounted under the admin router, which already requires an administrator. */
export const driveAdminRoutes = new Hono<AppEnv>()
  .get("/drive", async (c) => {
    const [enabled, quotas] = await Promise.all([
      driveEnabled(c.env.DB),
      createDb(c.env.DB)
        .select({
          userId: users.id,
          name: users.name,
          quotaBytes: driveQuotas.quotaBytes,
          usedBytes: sql<number>`(SELECT coalesce(sum(size), 0) FROM drive_items WHERE owner_user_id = ${users.id})`,
        })
        .from(users)
        .leftJoin(driveQuotas, eq(driveQuotas.userId, users.id))
        .orderBy(users.name),
    ]);
    return c.json({
      ok: true as const,
      enabled,
      defaultQuotaBytes: DEFAULT_DRIVE_QUOTA_BYTES,
      quotas,
    });
  })
  .put("/drive", zValidator("json", driveToggleSchema), async (c) => {
    const setting = await setDriveEnabled(c.env.DB, c.req.valid("json").enabled);
    return c.json({ ok: true as const, enabled: setting.enabled });
  })
  .put("/drive/quotas/:userId", zValidator("json", driveQuotaSchema), async (c) => {
    const userId = c.req.param("userId");
    const { quotaBytes } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return apiError(c, 404, "NOT_FOUND", "User not found");
    // Lowering a quota below current usage blocks new uploads; nothing is deleted.
    if (quotaBytes === null) {
      await db.delete(driveQuotas).where(eq(driveQuotas.userId, userId));
    } else {
      const now = new Date();
      await db
        .insert(driveQuotas)
        .values({ userId, quotaBytes, updatedAt: now })
        .onConflictDoUpdate({ target: driveQuotas.userId, set: { quotaBytes, updatedAt: now } });
    }
    return c.json({ ok: true as const, userId, quotaBytes });
  });
