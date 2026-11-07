import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../worker/db/client";
import { pushSubscriptions, users } from "../worker/db/schema";
import type { PushBindings } from "../worker/env";
import { parseIcs } from "../worker/calendar/ics";
import { consumePushNotifications } from "../worker/mail/push-notifications";

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected a session cookie");
  return cookie;
}

function call(cookie: string | null, path: string, init: { method?: string; json?: unknown } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
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
  const admin = sessionCookie(bootstrap);

  const memberId = `usr_calendar_member_${crypto.randomUUID()}`;
  const now = new Date();
  await createDb(env.DB).insert(users).values({
    id: memberId,
    name: "Member",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const login = await call(null, "/api/auth/mock/login", { method: "POST", json: { userId: memberId } });
  expect(login.status).toBe(200);
  return { admin, member: sessionCookie(login), memberId };
}

describe("calendar module", () => {
  it("is off by default, gated by admins, private per user, and serves revocable feeds", async () => {
    const { admin, member, memberId } = await signIn();

    // Off by default: routes, feeds and the navigation flag all behave as absent.
    expect((await call(admin, "/api/calendar/calendars")).status).toBe(404);
    expect((await call(null, "/ics/anything.ics")).status).toBe(404);
    expect(await (await call(admin, "/api/auth/state")).json()).toMatchObject({
      modules: { calendar: false },
    });
    expect(await (await call(admin, "/api/admin/state")).json()).toMatchObject({
      calendarEnabled: false,
    });
    expect((await call(member, "/api/admin/calendar", { method: "PUT", json: { enabled: true } })).status)
      .toBe(403);
    expect((await call(admin, "/api/admin/calendar", { method: "PUT", json: { enabled: true } })).status)
      .toBe(200);
    expect(await (await call(member, "/api/auth/state")).json()).toMatchObject({
      modules: { calendar: true },
    });

    // The first listing creates a default calendar.
    const calendars = await (await call(admin, "/api/calendar/calendars")).json<{
      calendars: Array<{ id: string; name: string; feedUrl: string | null }>;
    }>();
    expect(calendars.calendars).toMatchObject([{ name: "Personal", feedUrl: null }]);
    const calendarId = calendars.calendars[0]!.id;

    const created = await call(admin, "/api/calendar/events", {
      method: "POST",
      json: {
        calendarId,
        title: "Board meeting",
        startsAt: "2026-03-02T09:00:00-05:00",
        endsAt: "2026-03-02T10:00:00-05:00",
        timeZone: "America/New_York",
        rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
        reminders: [15],
      },
    });
    expect(created.status).toBe(200);
    const event = (await created.json<{ event: { id: string } }>()).event;
    expect((await call(admin, "/api/calendar/events", {
      method: "POST",
      json: {
        title: "Bad rule",
        startsAt: 0,
        endsAt: 1_000,
        timeZone: "UTC",
        rrule: "FREQ=HOURLY",
      },
    })).status).toBe(400);

    const range = "from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z";
    const listed = await (await call(admin, `/api/calendar/events?${range}`)).json<{
      events: Array<{ startsAt: number }>;
    }>();
    expect(listed.events.map((item) => new Date(item.startsAt).toISOString())).toEqual([
      "2026-03-02T14:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
      "2026-03-16T13:00:00.000Z",
    ]);
    expect(await (await call(admin, `/api/calendar/freebusy?${range}`)).json()).toMatchObject({
      busy: [{ startsAt: Date.parse("2026-03-02T14:00:00Z") }, {}, {}],
    });

    // Another user only ever reaches their own calendar object.
    const memberCalendars = await (await call(member, "/api/calendar/calendars")).json<{
      calendars: Array<{ id: string }>;
    }>();
    expect(memberCalendars.calendars.map((item) => item.id)).not.toContain(calendarId);
    expect(await (await call(member, `/api/calendar/events?${range}`)).json()).toMatchObject({ events: [] });
    expect(await (await call(member, `/api/calendar/freebusy?${range}`)).json()).toMatchObject({ busy: [] });
    expect((await call(member, `/api/calendar/events/${event.id}`)).status).toBe(404);
    expect((await call(member, `/api/calendar/events/${event.id}`, {
      method: "PATCH",
      json: { title: "Hijacked" },
    })).status).toBe(404);
    expect((await call(member, `/api/calendar/events/${event.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(member, `/api/calendar/calendars/${calendarId}/feed`, { method: "POST" })).status)
      .toBe(404);
    expect((await call(null, "/api/calendar/calendars")).status).toBe(401);

    // Feed: create, read, regenerate, revoke.
    const feed = await (await call(admin, `/api/calendar/calendars/${calendarId}/feed`, { method: "POST" }))
      .json<{ feedUrl: string }>();
    const feedPath = new URL(feed.feedUrl).pathname;
    expect(feedPath).toMatch(/^\/ics\/[\w-]+\.ics$/u);
    const served = await call(null, feedPath);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    const parsed = parseIcs(await served.text());
    expect(parsed.events).toMatchObject([{
      title: "Board meeting",
      rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      startsAt: Date.parse("2026-03-02T14:00:00Z"),
      timeZone: "America/New_York",
      reminders: [15],
    }]);
    expect(await (await call(admin, "/api/calendar/calendars")).json()).toMatchObject({
      calendars: [{ feedUrl: feed.feedUrl }],
    });

    const regenerated = await (await call(admin, `/api/calendar/calendars/${calendarId}/feed`, { method: "POST" }))
      .json<{ feedUrl: string }>();
    expect(regenerated.feedUrl).not.toBe(feed.feedUrl);
    expect((await call(null, feedPath)).status).toBe(404);
    const regeneratedPath = new URL(regenerated.feedUrl).pathname;
    expect((await call(null, regeneratedPath)).status).toBe(200);
    expect((await call(admin, `/api/calendar/calendars/${calendarId}/feed`, { method: "DELETE" })).status)
      .toBe(200);
    expect((await call(null, regeneratedPath)).status).toBe(404);

    // Import reports what it could not take.
    const imported = await call(member, `/api/calendar/calendars/${memberCalendars.calendars[0]!.id}/import`, {
      method: "POST",
      json: {
        timeZone: "Europe/Berlin",
        ics: [
          "BEGIN:VCALENDAR",
          "BEGIN:VEVENT",
          "UID:ok@example.test",
          "SUMMARY:Lunch",
          "DTSTART:20260305T120000",
          "DTEND:20260305T130000",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:bad@example.test",
          "SUMMARY:Hourly",
          "DTSTART:20260305T120000Z",
          "RRULE:FREQ=HOURLY",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      },
    });
    expect(await imported.json()).toMatchObject({
      imported: 1,
      skipped: [{ uid: "bad@example.test", reason: "Unsupported FREQ \"HOURLY\"" }],
    });
    expect(await (await call(member, `/api/calendar/events?${range}`)).json()).toMatchObject({
      events: [{ title: "Lunch", startsAt: Date.parse("2026-03-05T11:00:00Z"), timeZone: "Europe/Berlin" }],
    });

    // Reminder push jobs fan out to the owner's devices only.
    const memberSession = await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ? LIMIT 1")
      .bind(memberId).first<{ id: string }>();
    await createDb(env.DB).insert(pushSubscriptions).values({
      id: "push_calendar_member",
      userId: memberId,
      sessionId: memberSession!.id,
      endpoint: "https://fcm.googleapis.com/fcm/send/calendar-member",
      p256dh: "BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oEKgPpWC5cW8OCzVrOQRv-1npXRWk8udnW3oYhIO4475rds",
      auth: "5I2Bu2oKdyy9CwL8QVF0NQ",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sendBatch = vi.fn(async () => undefined);
    const ack = vi.fn();
    await consumePushNotifications({
      queue: "openworkspace-push-notifications",
      messages: [{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        ack,
        retry: vi.fn(),
        body: {
          type: "calendar-reminder",
          userId: memberId,
          eventId: "evt_x",
          occurrenceStart: 0,
          occurredAt: Date.now(),
          title: "Lunch",
          body: "In 10 min",
        },
      }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, { ...env, PUSH_NOTIFICATIONS: { sendBatch } } as unknown as Env & PushBindings);
    expect(ack).toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledWith([
      { body: expect.objectContaining({ type: "calendar-reminder", targetSubscriptionId: "push_calendar_member" }) },
    ]);

    // MCP tools go through the same routes.
    const token = (await (await call(admin, "/api/auth/api-tokens", { method: "POST", json: { name: "Calendar" } }))
      .json<{ token: { token: string } }>()).token.token;
    const mcp = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await exports.default.fetch(new Request("http://example.test/mcp", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "mcp-method": method,
          "mcp-protocol-version": "2026-07-28",
          ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "calendar-test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }));
      return (await response.json<{ result?: Record<string, unknown> }>()).result;
    };
    const tools = (await mcp("tools/list"))?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_calendar_events",
      "create_calendar_event",
      "update_calendar_event",
      "delete_calendar_event",
      "get_free_busy",
    ]));
    expect(await mcp("tools/call", {
      name: "get_free_busy",
      arguments: { from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
    })).toMatchObject({ structuredContent: { busy: [{}, {}, {}] } });

    // Turning the module off hides everything again.
    await call(admin, "/api/admin/calendar", { method: "PUT", json: { enabled: false } });
    expect((await call(admin, "/api/calendar/calendars")).status).toBe(404);
    expect((await call(admin, `/api/calendar/events?${range}`)).status).toBe(404);
  });
});
