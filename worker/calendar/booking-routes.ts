import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { formatSlotDateTime } from "../../shared/booking";
import { isValidTimeZone, type CalendarReminderPushJob } from "../../shared/calendar";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { checkRateLimit, requestIdentifier } from "../lib/rate-limit";
import { cloudflareClientIp } from "../lib/request";
import { getMailboxAccess } from "../mail/access";
import { calendarStub, type CalendarResult } from ".";
import {
  ensureBookingHandle,
  readBookingToken,
  resolveBookingHandle,
  sendBookingEmail,
  verifyTurnstile,
} from "./booking";
import { serializeCalendar } from "./ics";
import { requireCalendarModule } from "./module";
import type { BookingRecord, BookingTypeRecord, CalendarEventRecord } from "./schema";
import {
  bookingRequestSchema,
  bookingSlotsQuerySchema,
  bookingTypePatchSchema,
  createBookingTypeSchema,
  rescheduleRequestSchema,
} from "./schemas";

function failure(c: Context<AppEnv>, value: Extract<CalendarResult<unknown>, { ok: false }>) {
  const code = value.status === 404 ? "NOT_FOUND" : value.status === 409 ? "CONFLICT" : "BAD_REQUEST";
  return apiError(c, value.status, code, value.message);
}

async function rateLimited(c: Context<AppEnv>, action: string, limit: number, windowMs: number) {
  const rate = await checkRateLimit(c.env.DB, {
    action,
    identifier: requestIdentifier(c.req.raw),
    limit,
    windowMs,
  });
  if (rate.allowed) return null;
  c.header("retry-after", String(rate.retryAfterSeconds));
  return apiError(c, 429, "RATE_LIMITED", "Too many requests, try again later");
}

async function checkSender(c: Context<AppEnv>, mailboxId: string | null | undefined) {
  if (!mailboxId) return null;
  const access = await getMailboxAccess(createDb(c.env.DB), c.get("user").id, mailboxId);
  return access?.canSend ? null : apiError(c, 403, "FORBIDDEN", "Send access to that mailbox is required");
}

type Notice = {
  kind: "booked" | "rescheduled" | "cancelled";
  hostId: string;
  hostName: string;
  booking: BookingRecord;
  type: BookingTypeRecord;
  event: CalendarEventRecord | null;
  token?: string;
  /** Who cancelled; the guest is not told about their own cancellation twice. */
  by?: "guest" | "host";
};

/**
 * Guest email from the booking type's mailbox (through the normal outbound
 * path, so it is kept in Sent) and a push notification to the host. Delivery
 * problems never undo the booking itself.
 */
async function notify(c: Context<AppEnv>, notice: Notice) {
  const { booking, type, event } = notice;
  const guestWhen = formatSlotDateTime(booking.startsAt, booking.guestTimeZone, "en-US");
  const hostWhen = formatSlotDateTime(booking.startsAt, type.timeZone, "en-US");
  const title = `${type.name} with ${notice.hostName}`;
  let emailSent = false;
  if (type.senderMailboxId) {
    const manage = notice.token ? new URL(`/book/manage/${notice.token}`, c.req.url).toString() : null;
    const lines = notice.kind === "cancelled"
      ? [`Your booking "${title}" on ${guestWhen} (${booking.guestTimeZone}) has been cancelled.`]
      : [
          notice.kind === "booked"
            ? `Your booking "${title}" is confirmed.`
            : `Your booking "${title}" has been moved.`,
          "",
          `When: ${guestWhen} (${booking.guestTimeZone})`,
          `Duration: ${type.durationMinutes} minutes`,
          ...(type.location ? [`Where: ${type.location}`] : []),
          "",
          ...(manage ? [`Cancel or reschedule: ${manage}`] : []),
        ];
    const ics = event
      ? serializeCalendar({
          name: title,
          events: [{
            ...event,
            title,
            description: manage ? `Cancel or reschedule: ${manage}` : "",
            reminders: [],
          }],
        })
      : undefined;
    try {
      emailSent = await sendBookingEmail({
        env: c.env,
        requestUrl: c.req.url,
        userId: notice.hostId,
        mailboxId: type.senderMailboxId,
        to: booking.guestEmail,
        subject: notice.kind === "booked"
          ? `Confirmed: ${title}`
          : notice.kind === "rescheduled" ? `Updated: ${title}` : `Cancelled: ${title}`,
        text: lines.join("\n"),
        ics,
      });
    } catch (error) {
      console.error("Could not send the booking email", error);
    }
  }
  if (notice.by !== "host") {
    const job: CalendarReminderPushJob = {
      type: "calendar-reminder",
      userId: notice.hostId,
      eventId: booking.eventId,
      occurrenceStart: booking.startsAt,
      occurredAt: Date.now(),
      title: `${notice.kind === "booked" ? "New booking" : notice.kind === "rescheduled" ? "Booking moved" : "Booking cancelled"}: ${type.name}`.slice(0, 500),
      body: `${booking.guestName} · ${hostWhen}`.slice(0, 1_000),
    };
    try {
      await c.env.PUSH_NOTIFICATIONS.send(job);
    } catch (error) {
      console.error("Could not queue the booking notification", error);
    }
  }
  return emailSent;
}

const timeZoneQuery = z.object({ timeZone: z.string().max(100).optional() });

/** The signed-in host's booking types and bookings; mounted under /calendar. */
export const bookingHostRoutes = new Hono<AppEnv>()
  .get("/", zValidator("query", timeZoneQuery), async (c) => {
    const user = c.get("user");
    const seedZone = c.req.valid("query").timeZone;
    const [handle, types] = await Promise.all([
      ensureBookingHandle(createDb(c.env.DB), user),
      calendarStub(c.env, user.id).listBookingTypes(
        seedZone && isValidTimeZone(seedZone) ? seedZone : "UTC",
      ),
    ]);
    return c.json({
      ok: true as const,
      handle,
      url: new URL(`/book/${handle}`, c.req.url).toString(),
      types,
    });
  })
  .post("/types", zValidator("json", createBookingTypeSchema), async (c) => {
    const input = c.req.valid("json");
    const denied = await checkSender(c, input.senderMailboxId);
    if (denied) return denied;
    const created = await calendarStub(c.env, c.get("user").id).createBookingType(input);
    if (!created.ok) return failure(c, created);
    return c.json({ ok: true as const, type: created.value });
  })
  .patch("/types/:typeId", zValidator("json", bookingTypePatchSchema), async (c) => {
    const input = c.req.valid("json");
    const denied = await checkSender(c, input.senderMailboxId);
    if (denied) return denied;
    const updated = await calendarStub(c.env, c.get("user").id)
      .updateBookingType(c.req.param("typeId"), input);
    if (!updated.ok) return failure(c, updated);
    return c.json({ ok: true as const, type: updated.value });
  })
  .delete("/types/:typeId", async (c) => {
    if (!await calendarStub(c.env, c.get("user").id).deleteBookingType(c.req.param("typeId"))) {
      return apiError(c, 404, "NOT_FOUND", "Booking type not found");
    }
    return c.json({ ok: true as const });
  })
  .get("/bookings", async (c) => {
    const bookings = await calendarStub(c.env, c.get("user").id).listUpcomingBookings();
    return c.json({ ok: true as const, bookings });
  })
  .post("/bookings/:bookingId/cancel", async (c) => {
    const user = c.get("user");
    const cancelled = await calendarStub(c.env, user.id).cancelBooking(c.req.param("bookingId"));
    if (!cancelled) return apiError(c, 404, "NOT_FOUND", "Booking not found");
    const emailSent = await notify(c, {
      kind: "cancelled",
      hostId: user.id,
      hostName: user.name,
      ...cancelled,
      by: "host",
    });
    return c.json({ ok: true as const, emailSent });
  });

async function hostFromToken(c: Context<AppEnv>, token: string) {
  const payload = readBookingToken(token);
  if (!payload) return null;
  const [host] = await createDb(c.env.DB)
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.id, payload.u), eq(users.status, "active")))
    .limit(1);
  return host ?? null;
}

/**
 * Unauthenticated booking API used by the `/book/...` pages. It only ever
 * returns enabled booking types and free slot starts, never event details.
 */
export const publicBookingRoutes = new Hono<AppEnv>()
  .use("*", requireCalendarModule)
  .get("/manage/:token", async (c) => {
    const limited = await rateLimited(c, "booking-read", 120, 60_000);
    if (limited) return limited;
    const token = c.req.param("token");
    const host = await hostFromToken(c, token);
    const managed = host ? await calendarStub(c.env, host.id).managedBooking(token) : null;
    if (!host || !managed) return apiError(c, 404, "NOT_FOUND", "This link is invalid or has expired");
    const { booking } = managed;
    return c.json({
      ok: true as const,
      host: { name: host.name },
      type: managed.type,
      canReschedule: managed.enabled,
      booking: {
        guestName: booking.guestName,
        guestTimeZone: booking.guestTimeZone,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      },
    });
  })
  .get("/manage/:token/slots", zValidator("query", bookingSlotsQuerySchema), async (c) => {
    const limited = await rateLimited(c, "booking-read", 120, 60_000);
    if (limited) return limited;
    const token = c.req.param("token");
    const { from, to } = c.req.valid("query");
    const host = await hostFromToken(c, token);
    const slots = host ? await calendarStub(c.env, host.id).rescheduleSlots(token, from, to) : null;
    if (!slots) return apiError(c, 404, "NOT_FOUND", "This link is invalid or has expired");
    return c.json({ ok: true as const, slots });
  })
  .post("/manage/:token/cancel", async (c) => {
    const limited = await rateLimited(c, "booking-manage", 20, 3_600_000);
    if (limited) return limited;
    const token = c.req.param("token");
    const host = await hostFromToken(c, token);
    const cancelled = host ? await calendarStub(c.env, host.id).cancelByToken(token) : null;
    if (!host || !cancelled) return apiError(c, 404, "NOT_FOUND", "This link is invalid or has expired");
    await notify(c, { kind: "cancelled", hostId: host.id, hostName: host.name, ...cancelled, by: "guest" });
    return c.json({ ok: true as const });
  })
  .post("/manage/:token/reschedule", zValidator("json", rescheduleRequestSchema), async (c) => {
    const limited = await rateLimited(c, "booking-manage", 20, 3_600_000);
    if (limited) return limited;
    const token = c.req.param("token");
    const host = await hostFromToken(c, token);
    if (!host) return apiError(c, 404, "NOT_FOUND", "This link is invalid or has expired");
    const moved = await calendarStub(c.env, host.id).rescheduleByToken(token, c.req.valid("json").start);
    if (!moved.ok) return failure(c, moved);
    const emailSent = await notify(c, { kind: "rescheduled", hostId: host.id, hostName: host.name, ...moved.value });
    return c.json({
      ok: true as const,
      emailSent,
      manageToken: moved.value.token,
      booking: { startsAt: moved.value.booking.startsAt, endsAt: moved.value.booking.endsAt },
    });
  })
  .get("/:handle", async (c) => {
    const limited = await rateLimited(c, "booking-read", 120, 60_000);
    if (limited) return limited;
    const host = await resolveBookingHandle(c.env.DB, c.req.param("handle"));
    if (!host) return apiError(c, 404, "NOT_FOUND", "Booking page not found");
    const types = await calendarStub(c.env, host.userId).publicBookingTypes();
    return c.json({ ok: true as const, host: { name: host.name }, types });
  })
  .get("/:handle/:slug", async (c) => {
    const limited = await rateLimited(c, "booking-read", 120, 60_000);
    if (limited) return limited;
    const host = await resolveBookingHandle(c.env.DB, c.req.param("handle"));
    const type = host ? await calendarStub(c.env, host.userId).publicBookingType(c.req.param("slug")) : null;
    if (!host || !type) return apiError(c, 404, "NOT_FOUND", "Booking page not found");
    return c.json({
      ok: true as const,
      host: { name: host.name },
      type,
      turnstileSiteKey: c.env.TURNSTILE_SECRET_KEY ? c.env.TURNSTILE_SITE_KEY ?? null : null,
    });
  })
  .get("/:handle/:slug/slots", zValidator("query", bookingSlotsQuerySchema), async (c) => {
    const limited = await rateLimited(c, "booking-read", 120, 60_000);
    if (limited) return limited;
    const { from, to } = c.req.valid("query");
    const host = await resolveBookingHandle(c.env.DB, c.req.param("handle"));
    const slots = host
      ? await calendarStub(c.env, host.userId).availableSlots(c.req.param("slug"), from, to)
      : null;
    if (!host || !slots) return apiError(c, 404, "NOT_FOUND", "Booking page not found");
    return c.json({ ok: true as const, slots });
  })
  .post("/:handle/:slug/bookings", zValidator("json", bookingRequestSchema), async (c) => {
    const limited = await rateLimited(c, "booking-submit", 10, 3_600_000);
    if (limited) return limited;
    const { website, turnstileToken, ...input } = c.req.valid("json");
    if (website) return apiError(c, 400, "BAD_REQUEST", "The booking could not be completed");
    const secret = c.env.TURNSTILE_SECRET_KEY;
    if (secret && !await verifyTurnstile(secret, turnstileToken, cloudflareClientIp(c.req.raw))) {
      return apiError(c, 403, "FORBIDDEN", "The human check failed, please try again");
    }
    const host = await resolveBookingHandle(c.env.DB, c.req.param("handle"));
    if (!host) return apiError(c, 404, "NOT_FOUND", "Booking page not found");
    const booked = await calendarStub(c.env, host.userId).book(c.req.param("slug"), input);
    if (!booked.ok) return failure(c, booked);
    const emailSent = await notify(c, { kind: "booked", hostId: host.userId, hostName: host.name, ...booked.value });
    return c.json({
      ok: true as const,
      emailSent,
      manageToken: booked.value.token,
      booking: { startsAt: booked.value.booking.startsAt, endsAt: booked.value.booking.endsAt },
    });
  });
