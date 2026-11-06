import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createDb } from "../db/client";
import { settings } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";

const CALENDAR_MODULE_KEY = "calendar_enabled";

/** The calendar is an optional module, off until an administrator enables it. */
export async function calendarModuleEnabled(binding: D1Database) {
  const [setting] = await createDb(binding)
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, CALENDAR_MODULE_KEY))
    .limit(1);
  return setting?.value === "true";
}

export async function setCalendarModuleEnabled(binding: D1Database, enabled: boolean) {
  const now = new Date();
  await createDb(binding)
    .insert(settings)
    .values({ key: CALENDAR_MODULE_KEY, value: String(enabled), updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(enabled), updatedAt: now },
    });
  return { enabled };
}

/** Disabled modules answer exactly like routes that do not exist. */
export const requireCalendarModule = createMiddleware<AppEnv>(async (c, next) => {
  if (!await calendarModuleEnabled(c.env.DB)) {
    return apiError(c, 404, "NOT_FOUND", "Not found");
  }
  await next();
});
