import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { setCalendarModuleEnabled } from "../worker/calendar/module";

const DAY = 86_400_000;
const allWeek = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((day) => ({ day, start: 0, end: 1_440 }));

function call(
  cookie: string | null,
  path: string,
  init: { method?: string; json?: unknown; ip?: string } = {},
) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (init.ip) headers.set("cf-connecting-ip", init.ip);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`http://example.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  }));
}

async function signIn() {
  const bootstrap = await call(null, "/api/auth/mock/bootstrap", {
    method: "POST",
    json: { name: "Admin", email: "admin@example.test" },
  });
  expect(bootstrap.status).toBe(200);
  return bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
}

type Json = Record<string, any>;

describe("booking pages", () => {
  it("serves public booking, cancel and reschedule behind the calendar module", async () => {
    const admin = await signIn();
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;

    // Module off: the public API does not exist.
    expect((await call(null, "/api/public/booking/admin")).status).toBe(404);
    expect((await call(admin, "/api/calendar/booking")).status).toBe(404);
    expect((await call(admin, "/api/admin/calendar", { method: "PUT", json: { enabled: true } })).status).toBe(200);

    const host = await (await call(admin, "/api/calendar/booking?timeZone=UTC")).json<Json>();
    expect(host.handle).toBe("admin");
    expect(host.types.map((type: Json) => type.enabled)).toEqual([false, false]);
    // Disabled starters are not public.
    expect(await (await call(null, "/api/public/booking/admin")).json<Json>()).toMatchObject({ types: [] });

    const mailboxes = await (await call(admin, "/api/mail/mailboxes")).json<Json>();
    const mailboxId = mailboxes.mailboxes[0].id as string;
    const created = await call(admin, "/api/calendar/booking/types", {
      method: "POST",
      json: {
        slug: "intro",
        name: "Intro call",
        durationMinutes: 30,
        timeZone: "UTC",
        weeklyHours: allWeek,
        senderMailboxId: mailboxId,
        enabled: true,
      },
    });
    expect(created.status).toBe(200);
    expect((await call(admin, "/api/calendar/booking/types", {
      method: "POST",
      json: { slug: "intro", name: "Again", durationMinutes: 15, timeZone: "UTC" },
    })).status).toBe(409);

    const listing = await (await call(null, "/api/public/booking/admin")).json<Json>();
    expect(listing.types).toEqual([expect.objectContaining({ slug: "intro", durationMinutes: 30 })]);
    // Nothing about calendars or the sending mailbox is public.
    expect(JSON.stringify(listing)).not.toContain(mailboxId);

    const now = Date.now();
    const slotsPath = `/api/public/booking/admin/intro/slots?from=${now}&to=${now + 3 * DAY}`;
    const { slots } = await (await call(null, slotsPath)).json<{ slots: number[] }>();
    expect(slots.length).toBeGreaterThan(10);
    const guest = { name: "Guest", email: "guest@example.com", timeZone: "Asia/Tokyo" };

    expect((await call(null, "/api/public/booking/admin/intro/bookings", {
      method: "POST",
      ip,
      json: { ...guest, start: slots[0], website: "http://spam.example" },
    })).status).toBe(400);
    expect((await call(null, "/api/public/booking/admin/intro/bookings", {
      method: "POST",
      ip,
      json: { ...guest, email: "not-an-email", start: slots[0] },
    })).status).toBe(400);

    const booked = await call(null, "/api/public/booking/admin/intro/bookings", {
      method: "POST",
      ip,
      json: { ...guest, start: slots[0], notes: "Hello" },
    });
    expect(booked.status).toBe(200);
    const booking = await booked.json<Json>();
    expect(booking).toMatchObject({ booking: { startsAt: slots[0], endsAt: slots[0]! + 30 * 60_000 } });
    expect(booking.emailSent).toBe(true);
    expect((await call(null, "/api/public/booking/admin/intro/bookings", {
      method: "POST",
      ip,
      json: { ...guest, start: slots[0] },
    })).status).toBe(409);

    // The host sees the booking and the event.
    const upcoming = await (await call(admin, "/api/calendar/booking/bookings")).json<Json>();
    expect(upcoming.bookings).toEqual([expect.objectContaining({ guestEmail: "guest@example.com", notes: "Hello" })]);

    const token = booking.manageToken as string;
    const managed = await (await call(null, `/api/public/booking/manage/${token}`)).json<Json>();
    expect(managed).toMatchObject({ booking: { startsAt: slots[0], guestTimeZone: "Asia/Tokyo" }, canReschedule: true });
    expect((await call(null, `/api/public/booking/manage/${token.slice(0, -2)}xx`)).status).toBe(404);

    const moveSlots = await (await call(null, `/api/public/booking/manage/${token}/slots?from=${now}&to=${now + 3 * DAY}`))
      .json<{ slots: number[] }>();
    const target = moveSlots.slots.find((slot) => slot > slots[0]! + DAY)!;
    const moved = await (await call(null, `/api/public/booking/manage/${token}/reschedule`, {
      method: "POST",
      ip,
      json: { start: target },
    })).json<Json>();
    expect(moved.booking.startsAt).toBe(target);
    const events = await (await call(admin, `/api/calendar/events?from=${now}&to=${now + 3 * DAY}`)).json<Json>();
    expect(events.events.map((event: Json) => event.startsAt)).toEqual([target]);

    expect((await call(null, `/api/public/booking/manage/${moved.manageToken}/cancel`, { method: "POST", ip })).status)
      .toBe(200);
    expect((await call(null, `/api/public/booking/manage/${moved.manageToken}/cancel`, { method: "POST", ip })).status)
      .toBe(404);
    expect((await (await call(admin, `/api/calendar/events?from=${now}&to=${now + 3 * DAY}`)).json<Json>()).events)
      .toEqual([]);

    // Admins can change a handle; the old one stops resolving.
    const users = (await (await call(admin, "/api/admin/state")).json<Json>()).users as Json[];
    const self = users.find((user) => user.bookingHandle === "admin")!;
    expect((await call(admin, `/api/admin/users/${self.id}/booking-handle`, {
      method: "PUT",
      json: { handle: "manage" },
    })).status).toBe(400);
    expect((await call(admin, `/api/admin/users/${self.id}/booking-handle`, {
      method: "PUT",
      json: { handle: "team-admin" },
    })).status).toBe(200);
    expect((await call(null, "/api/public/booking/admin")).status).toBe(404);
    expect((await call(null, "/api/public/booking/team-admin")).status).toBe(200);
  });

  it("rate limits booking submissions per IP", async () => {
    await setCalendarModuleEnabled(env.DB, true);
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let index = 0; index < 11; index++) {
      statuses.push((await call(null, "/api/public/booking/nobody/x/bookings", {
        method: "POST",
        ip,
        json: { start: Date.now(), name: "Bot", email: "bot@example.com", timeZone: "UTC" },
      })).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
