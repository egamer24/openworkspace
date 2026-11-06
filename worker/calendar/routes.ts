import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import { calendarFeeds, users } from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
import { apiError } from "../lib/http";
import { calendarStub, type CalendarResult } from ".";
import { bookingHostRoutes } from "./booking-routes";
import { calendarModuleEnabled, requireCalendarModule } from "./module";
import {
  calendarInputSchema,
  calendarPatchSchema,
  createEventSchema,
  deleteEventQuerySchema,
  importSchema,
  rangeQuerySchema,
  updateEventSchema,
} from "./schemas";

function feedUrl(c: Context<AppEnv>, token: string | null) {
  return token ? new URL(`/ics/${token}.ics`, c.req.url).toString() : null;
}

function result<T>(c: Context<AppEnv>, value: CalendarResult<T>) {
  return value.ok
    ? null
    : apiError(c, value.status, value.status === 404 ? "NOT_FOUND" : "BAD_REQUEST", value.message);
}

async function revokeFeed(env: Env, userId: string, calendarId: string) {
  await createDb(env.DB)
    .delete(calendarFeeds)
    .where(and(eq(calendarFeeds.userId, userId), eq(calendarFeeds.calendarId, calendarId)));
}

/**
 * Everything is scoped to the signed-in user's own calendar Durable Object,
 * so there is no path that reaches another user's calendars.
 */
export const calendarRoutes = new Hono<AppEnv>()
  .use("*", requireCalendarModule, requireAuth)
  .get("/calendars", async (c) => {
    const calendars = await calendarStub(c.env, c.get("user").id).listCalendars();
    return c.json({
      ok: true as const,
      calendars: calendars.map((calendar) => ({ ...calendar, feedUrl: feedUrl(c, calendar.feedToken) })),
    });
  })
  .post("/calendars", zValidator("json", calendarInputSchema), async (c) => {
    const created = await calendarStub(c.env, c.get("user").id).createCalendar(c.req.valid("json"));
    if (!created.ok) return result(c, created)!;
    return c.json({ ok: true as const, calendar: { ...created.value, feedUrl: null } });
  })
  .patch("/calendars/:calendarId", zValidator("json", calendarPatchSchema), async (c) => {
    const calendar = await calendarStub(c.env, c.get("user").id)
      .updateCalendar(c.req.param("calendarId"), c.req.valid("json"));
    if (!calendar) return apiError(c, 404, "NOT_FOUND", "Calendar not found");
    return c.json({ ok: true as const, calendar: { ...calendar, feedUrl: feedUrl(c, calendar.feedToken) } });
  })
  .delete("/calendars/:calendarId", async (c) => {
    const userId = c.get("user").id;
    const calendarId = c.req.param("calendarId");
    if (!await calendarStub(c.env, userId).deleteCalendar(calendarId)) {
      return apiError(c, 404, "NOT_FOUND", "Calendar not found");
    }
    await revokeFeed(c.env, userId, calendarId);
    return c.json({ ok: true as const });
  })
  .post("/calendars/:calendarId/feed", async (c) => {
    const userId = c.get("user").id;
    const calendarId = c.req.param("calendarId");
    const token = randomToken();
    // Store the new token first so a failed D1 write never leaves a working
    // URL the owner cannot see.
    if (!await calendarStub(c.env, userId).setFeedToken(calendarId, token)) {
      return apiError(c, 404, "NOT_FOUND", "Calendar not found");
    }
    const db = createDb(c.env.DB);
    await db.batch([
      db.delete(calendarFeeds).where(and(
        eq(calendarFeeds.userId, userId),
        eq(calendarFeeds.calendarId, calendarId),
      )),
      db.insert(calendarFeeds).values({
        tokenHash: await hashToken(token),
        userId,
        calendarId,
        createdAt: new Date(),
      }),
    ] as const);
    return c.json({ ok: true as const, feedUrl: feedUrl(c, token)! });
  })
  .delete("/calendars/:calendarId/feed", async (c) => {
    const userId = c.get("user").id;
    const calendarId = c.req.param("calendarId");
    await revokeFeed(c.env, userId, calendarId);
    if (!await calendarStub(c.env, userId).setFeedToken(calendarId, null)) {
      return apiError(c, 404, "NOT_FOUND", "Calendar not found");
    }
    return c.json({ ok: true as const });
  })
  .post("/calendars/:calendarId/import", zValidator("json", importSchema), async (c) => {
    const input = c.req.valid("json");
    const report = await calendarStub(c.env, c.get("user").id)
      .importIcs(c.req.param("calendarId"), input.ics, input.timeZone ?? "UTC");
    if (!report) return apiError(c, 404, "NOT_FOUND", "Calendar not found");
    return c.json({ ok: true as const, ...report });
  })
  .get("/calendars/:calendarId/export", async (c) => {
    const ics = await calendarStub(c.env, c.get("user").id)
      .exportCalendar(c.req.param("calendarId"));
    if (ics === null) return apiError(c, 404, "NOT_FOUND", "Calendar not found");
    return c.body(ics, 200, {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": "attachment; filename=\"calendar.ics\"",
    });
  })
  .get("/events", zValidator("query", rangeQuerySchema), async (c) => {
    const { from, to, calendarId } = c.req.valid("query");
    const occurrences = await calendarStub(c.env, c.get("user").id)
      .listOccurrences(from, to, calendarId);
    return c.json({ ok: true as const, events: occurrences });
  })
  .post("/events", zValidator("json", createEventSchema), async (c) => {
    const created = await calendarStub(c.env, c.get("user").id).createEvent(c.req.valid("json"));
    if (!created.ok) return result(c, created)!;
    return c.json({ ok: true as const, event: created.value });
  })
  .get("/events/:eventId", async (c) => {
    const event = await calendarStub(c.env, c.get("user").id).getEvent(c.req.param("eventId"));
    if (!event) return apiError(c, 404, "NOT_FOUND", "Event not found");
    return c.json({ ok: true as const, event });
  })
  .patch("/events/:eventId", zValidator("json", updateEventSchema), async (c) => {
    const updated = await calendarStub(c.env, c.get("user").id)
      .updateEvent(c.req.param("eventId"), c.req.valid("json"));
    if (!updated.ok) return result(c, updated)!;
    return c.json({ ok: true as const, event: updated.value });
  })
  .delete("/events/:eventId", zValidator("query", deleteEventQuerySchema), async (c) => {
    const deleted = await calendarStub(c.env, c.get("user").id)
      .deleteEvent(c.req.param("eventId"), c.req.valid("query"));
    if (!deleted.ok) return result(c, deleted)!;
    return c.json({ ok: true as const });
  })
  .get("/freebusy", zValidator("query", rangeQuerySchema), async (c) => {
    const { from, to } = c.req.valid("query");
    const busy = await calendarStub(c.env, c.get("user").id).freeBusy(from, to);
    return c.json({ ok: true as const, busy });
  })
  .route("/booking", bookingHostRoutes);

/** Public, token-authenticated, read-only feeds: `/ics/<token>.ics`. */
export const calendarFeedRoutes = new Hono<AppEnv>().get("/:file", async (c) => {
  const notFound = () => c.text("Not found", 404);
  const file = c.req.param("file");
  if (!file.endsWith(".ics") || !await calendarModuleEnabled(c.env.DB)) return notFound();
  const token = file.slice(0, -".ics".length);
  const [feed] = await createDb(c.env.DB)
    .select({ userId: calendarFeeds.userId, calendarId: calendarFeeds.calendarId })
    .from(calendarFeeds)
    .innerJoin(users, eq(calendarFeeds.userId, users.id))
    .where(and(
      eq(calendarFeeds.tokenHash, await hashToken(token)),
      eq(users.status, "active"),
    ))
    .limit(1);
  if (!feed) return notFound();
  const ics = await calendarStub(c.env, feed.userId).feed(feed.calendarId, token);
  if (ics === null) return notFound();
  return c.body(ics, 200, {
    "content-type": "text/calendar; charset=utf-8",
    "cache-control": "private, max-age=300",
  });
});
