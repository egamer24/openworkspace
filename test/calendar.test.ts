import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarStub } from "../worker/calendar";
import { foldIcsLine, parseIcs, serializeCalendar } from "../worker/calendar/ics";
import { setCalendarModuleEnabled } from "../worker/calendar/module";
import { expandOccurrences } from "../worker/calendar/recurrence";
import type { CalendarEventRecord } from "../worker/calendar/schema";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function row(overrides: Partial<CalendarEventRecord>): CalendarEventRecord {
  return {
    id: "evt_test",
    calendarId: "cal_test",
    uid: "test@example.test",
    recurrenceId: null,
    title: "Standup",
    description: "",
    location: "",
    startsAt: Date.parse("2026-03-02T14:00:00Z"),
    endsAt: Date.parse("2026-03-02T14:30:00Z"),
    timeZone: "America/New_York",
    allDay: false,
    status: "confirmed",
    transparency: "busy",
    sequence: 0,
    rrule: null,
    exdates: [],
    reminders: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function calendar() {
  return calendarStub(env, `usr_calendar_${crypto.randomUUID()}`);
}

afterEach(() => vi.restoreAllMocks());

describe("recurrence expansion", () => {
  it("keeps the wall-clock time across a DST change", () => {
    // 09:00 New York on Monday 2 March 2026; DST starts on 8 March.
    const occurrences = expandOccurrences(
      [row({ rrule: "FREQ=WEEKLY;COUNT=3" })],
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-04-01T00:00:00Z"),
    );
    expect(occurrences.map((item) => iso(item.startsAt))).toEqual([
      "2026-03-02T14:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
      "2026-03-16T13:00:00.000Z",
    ]);
    expect(occurrences.every((item) => item.endsAt - item.startsAt === 30 * 60_000)).toBe(true);
  });

  it("expands all-day events by date regardless of the event zone", () => {
    const occurrences = expandOccurrences(
      [row({
        allDay: true,
        timeZone: "Pacific/Auckland",
        startsAt: Date.parse("2026-04-03T00:00:00Z"),
        endsAt: Date.parse("2026-04-04T00:00:00Z"),
        rrule: "FREQ=DAILY;COUNT=3",
      })],
      Date.parse("2026-04-04T00:00:00Z"),
      Date.parse("2026-04-10T00:00:00Z"),
    );
    // Auckland leaves DST on 5 April; dates must not move.
    expect(occurrences.map((item) => iso(item.startsAt))).toEqual([
      "2026-04-04T00:00:00.000Z",
      "2026-04-05T00:00:00.000Z",
    ]);
  });

  it("supports BYDAY ordinals, BYMONTHDAY, UNTIL and EXDATEs", () => {
    const lastFriday = expandOccurrences(
      [row({ rrule: "FREQ=MONTHLY;BYDAY=-1FR;COUNT=2", startsAt: Date.parse("2026-01-30T15:00:00Z"), endsAt: Date.parse("2026-01-30T16:00:00Z") })],
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-12-01T00:00:00Z"),
    );
    expect(lastFriday.map((item) => iso(item.startsAt).slice(0, 10))).toEqual(["2026-01-30", "2026-02-27"]);

    const monthDays = expandOccurrences(
      [row({
        rrule: "FREQ=MONTHLY;BYMONTHDAY=1,15;UNTIL=20260415T000000Z",
        startsAt: Date.parse("2026-03-01T14:00:00Z"),
        endsAt: Date.parse("2026-03-01T15:00:00Z"),
        exdates: [Date.parse("2026-03-15T13:00:00Z")],
      })],
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-12-01T00:00:00Z"),
    );
    expect(monthDays.map((item) => iso(item.startsAt))).toEqual([
      "2026-03-01T14:00:00.000Z",
      "2026-04-01T13:00:00.000Z",
    ]);
  });
});

describe("iCalendar text", () => {
  it("folds long lines at 75 octets without splitting characters", () => {
    const line = `DESCRIPTION:${"é".repeat(60)}${"x".repeat(40)}`;
    const folded = foldIcsLine(line);
    const encoder = new TextEncoder();
    for (const part of folded.split("\r\n")) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /gu, "")).toBe(line);
  });

  it("round-trips series, exceptions, escaping and all-day events", () => {
    const master = row({
      title: "Planning; budget, Q3",
      description: "Line one\nLine two \\ done",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      exdates: [Date.parse("2026-03-04T14:00:00Z")],
      reminders: [10],
    });
    const override = row({
      id: "evt_override",
      recurrenceId: Date.parse("2026-03-09T13:00:00Z"),
      startsAt: Date.parse("2026-03-09T15:00:00Z"),
      endsAt: Date.parse("2026-03-09T16:00:00Z"),
      title: "Moved planning",
    });
    const allDay = row({
      id: "evt_holiday",
      uid: "holiday@example.test",
      allDay: true,
      title: "Holiday",
      startsAt: Date.parse("2026-07-03T00:00:00Z"),
      endsAt: Date.parse("2026-07-04T00:00:00Z"),
    });
    const text = serializeCalendar({ name: "Work", events: [master, override, allDay] });
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n/u);
    expect(text).toContain("BEGIN:VTIMEZONE\r\nTZID:America/New_York");
    expect(text).toContain("DTSTART;TZID=America/New_York:20260302T090000");
    expect(text).toContain("EXDATE;TZID=America/New_York:20260304T090000");
    expect(text).toContain("RECURRENCE-ID;TZID=America/New_York:20260309T090000");
    expect(text).toContain("DTSTART;VALUE=DATE:20260703");
    expect(text).toContain("SUMMARY:Planning\\; budget\\, Q3");
    expect(text.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);

    const parsed = parseIcs(text);
    expect(parsed.skipped).toEqual([]);
    const byKey = (event: { uid: string; recurrenceId: number | null }) => `${event.uid}/${event.recurrenceId}`;
    const back = new Map(parsed.events.map((event) => [byKey(event), event]));
    for (const original of [master, override, allDay]) {
      expect(back.get(byKey(original))).toMatchObject({
        title: original.title,
        description: original.description,
        startsAt: original.startsAt,
        endsAt: original.endsAt,
        allDay: original.allDay,
        rrule: original.rrule,
        exdates: original.exdates,
        reminders: original.reminders,
      });
    }
    const range = [Date.parse("2026-03-01T00:00:00Z"), Date.parse("2026-04-01T00:00:00Z")] as const;
    const reparsedRows = parsed.events.map((event, index) => row({ ...event, id: `evt_${index}` }));
    expect(expandOccurrences(reparsedRows, ...range).map((item) => [item.startsAt, item.row.title]))
      .toEqual(expandOccurrences([master, override, allDay], ...range).map((item) => [item.startsAt, item.row.title]));
  });

  it("reports unsupported rules instead of importing them", () => {
    const parsed = parseIcs([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a@example.test",
      "SUMMARY:Second Tuesday",
      "DTSTART;TZID=Europe/Berlin:20260310T100000",
      "DTEND;TZID=Europe/Berlin:20260310T110000",
      "RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b@example.test",
      "SUMMARY:Daily",
      "DTSTART:20260310T090000Z",
      "DURATION:PT45M",
      "RRULE:FREQ=DAILY;UNTIL=20260320",
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"));
    expect(parsed.skipped).toEqual([
      { uid: "a@example.test", title: "Second Tuesday", reason: "Unsupported rule part BYSETPOS" },
    ]);
    expect(parsed.events).toMatchObject([{
      uid: "b@example.test",
      endsAt: Date.parse("2026-03-10T09:45:00Z"),
      rrule: "FREQ=DAILY;UNTIL=20260320T235959Z",
      timeZone: "UTC",
      reminders: [15],
    }]);
  });
});

describe("calendar durable object", () => {
  const from = Date.parse("2026-03-01T00:00:00Z");
  const to = Date.parse("2026-04-01T00:00:00Z");

  it("splits a series for this-and-following edits", async () => {
    const stub = calendar();
    const created = await stub.createEvent({
      title: "Daily",
      startsAt: Date.parse("2026-03-02T14:00:00Z"),
      endsAt: Date.parse("2026-03-02T14:30:00Z"),
      timeZone: "America/New_York",
      rrule: "FREQ=DAILY;COUNT=10",
    });
    if (!created.ok) throw new Error(created.message);
    const fourth = Date.parse("2026-03-05T14:00:00Z");
    const split = await stub.updateEvent(created.value.id, {
      scope: "following",
      occurrenceStart: fourth,
      title: "Daily (new)",
    });
    if (!split.ok) throw new Error(split.message);
    expect(split.value.uid).not.toBe(created.value.uid);
    expect(split.value.rrule).toBe("FREQ=DAILY;COUNT=7");

    const occurrences = await stub.listOccurrences(from, to);
    expect(occurrences).toHaveLength(10);
    expect(occurrences.slice(0, 3).every((item) => item.title === "Daily")).toBe(true);
    expect(occurrences.slice(3).every((item) => item.title === "Daily (new)")).toBe(true);
    expect((await stub.getEvent(created.value.id))?.rrule).toBe("FREQ=DAILY;UNTIL=20260305T135959Z");
    // The new series keeps 09:00 local after DST starts on 8 March.
    expect(iso(occurrences[9]!.startsAt)).toBe("2026-03-11T13:00:00.000Z");
  });

  it("applies overrides, EXDATEs and series-wide shifts", async () => {
    const stub = calendar();
    const created = await stub.createEvent({
      title: "Weekly",
      startsAt: Date.parse("2026-03-02T14:00:00Z"),
      endsAt: Date.parse("2026-03-02T15:00:00Z"),
      timeZone: "America/New_York",
      rrule: "FREQ=WEEKLY;COUNT=4",
    });
    if (!created.ok) throw new Error(created.message);
    const second = Date.parse("2026-03-09T13:00:00Z");
    const third = Date.parse("2026-03-16T13:00:00Z");
    const moved = await stub.updateEvent(created.value.id, {
      scope: "this",
      occurrenceStart: second,
      startsAt: second + 2 * HOUR,
      endsAt: second + 3 * HOUR,
      title: "Moved",
    });
    expect(moved.ok).toBe(true);
    expect((await stub.deleteEvent(created.value.id, { scope: "this", occurrenceStart: third })).ok).toBe(true);

    let occurrences = await stub.listOccurrences(from, to);
    expect(occurrences.map((item) => [iso(item.startsAt), item.title])).toEqual([
      ["2026-03-02T14:00:00.000Z", "Weekly"],
      ["2026-03-09T15:00:00.000Z", "Moved"],
      ["2026-03-23T13:00:00.000Z", "Weekly"],
    ]);
    expect(occurrences[1]).toMatchObject({ seriesId: created.value.id, occurrenceStart: second });

    // Shift the whole series by an hour from its last occurrence.
    const last = occurrences[2]!;
    const shifted = await stub.updateEvent(last.eventId, {
      scope: "all",
      occurrenceStart: last.occurrenceStart!,
      startsAt: last.startsAt + HOUR,
      endsAt: last.endsAt + HOUR,
    });
    expect(shifted.ok).toBe(true);
    occurrences = await stub.listOccurrences(from, to);
    expect(occurrences.map((item) => [iso(item.startsAt), item.title])).toEqual([
      ["2026-03-02T15:00:00.000Z", "Weekly"],
      ["2026-03-09T15:00:00.000Z", "Moved"],
      ["2026-03-23T14:00:00.000Z", "Weekly"],
    ]);

    expect(await stub.freeBusy(from, to)).toEqual([
      { startsAt: Date.parse("2026-03-02T15:00:00Z"), endsAt: Date.parse("2026-03-02T16:00:00Z") },
      { startsAt: Date.parse("2026-03-09T15:00:00Z"), endsAt: Date.parse("2026-03-09T16:00:00Z") },
      { startsAt: Date.parse("2026-03-23T14:00:00Z"), endsAt: Date.parse("2026-03-23T15:00:00Z") },
    ]);

    // Editing the series from a moved override is relative to where it is shown.
    const fromOverride = occurrences[1]!;
    expect((await stub.updateEvent(fromOverride.eventId, {
      scope: "all",
      occurrenceStart: fromOverride.occurrenceStart!,
      startsAt: fromOverride.startsAt,
      endsAt: fromOverride.endsAt,
      title: "Renamed",
    })).ok).toBe(true);
    occurrences = await stub.listOccurrences(from, to);
    expect(occurrences.map((item) => [iso(item.startsAt), item.title])).toEqual([
      ["2026-03-02T15:00:00.000Z", "Renamed"],
      ["2026-03-09T15:00:00.000Z", "Moved"],
      ["2026-03-23T14:00:00.000Z", "Renamed"],
    ]);

    // Export, re-import into another user's calendar, and compare.
    const [own] = await stub.listCalendars();
    const exported = await stub.exportCalendar(own!.id);
    const other = calendar();
    const [target] = await other.listCalendars();
    expect(await other.importIcs(target!.id, exported!, "UTC")).toEqual({ imported: 2, skipped: [] });
    const reimported = await other.listOccurrences(from, to);
    expect(reimported.map((item) => [item.startsAt, item.endsAt, item.title]))
      .toEqual(occurrences.map((item) => [item.startsAt, item.endsAt, item.title]));
    expect(await other.importIcs(target!.id, exported!, "UTC")).toMatchObject({ imported: 0 });
    expect(await other.deleteCalendar(target!.id)).toBe(true);
    expect(await other.listOccurrences(from, to)).toEqual([]);
  });

  it("schedules reminders with the alarm and sends a push job", async () => {
    await setCalendarModuleEnabled(env.DB, true);
    const stub = calendar();
    // In the future, so the real alarm never fires on its own during the test.
    const now = Math.ceil(Date.now() / 60_000) * 60_000 + 7 * DAY;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const created = await stub.createEvent({
      title: "Dentist",
      location: "Main St",
      startsAt: now + HOUR,
      endsAt: now + 2 * HOUR,
      timeZone: "America/New_York",
      reminders: [10],
    });
    expect(created.ok).toBe(true);
    const sent = await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.getAlarm()).toBe(now + HOUR - 10 * 60_000);
      const send = vi.spyOn(
        (Reflect.get(instance, "bindings") as Env).PUSH_NOTIFICATIONS,
        "sendBatch",
      ).mockResolvedValue(undefined as never);
      vi.spyOn(Date, "now").mockReturnValue(now + HOUR - 10 * 60_000 + 500);
      await instance.alarm!();
      // The next scan waits for the horizon since nothing else is due.
      expect(await state.storage.getAlarm()).toBe(now + HOUR - 10 * 60_000 + 500 + 30 * DAY);
      return send.mock.calls.flatMap(([jobs]) => [...jobs].map((job) => job.body));
    });
    expect(sent).toMatchObject([{
      type: "calendar-reminder",
      eventId: created.ok ? created.value.id : "",
      occurrenceStart: now + HOUR,
      title: "Dentist",
    }]);
    expect(String((sent[0] as { body: string }).body)).toContain("In 10 min");
  });

  it("sends no reminders while the module is disabled", async () => {
    await setCalendarModuleEnabled(env.DB, false);
    const stub = calendar();
    // In the future, so the real alarm never fires on its own during the test.
    const now = Math.ceil(Date.now() / 60_000) * 60_000 + 7 * DAY;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await stub.createEvent({
      title: "Quiet",
      startsAt: now + HOUR,
      endsAt: now + 2 * HOUR,
      timeZone: "UTC",
      reminders: [0],
    });
    const calls = await runInDurableObject(stub, async (instance) => {
      const send = vi.spyOn(
        (Reflect.get(instance, "bindings") as Env).PUSH_NOTIFICATIONS,
        "sendBatch",
      ).mockResolvedValue(undefined as never);
      vi.spyOn(Date, "now").mockReturnValue(now + HOUR + 1_000);
      await instance.alarm!();
      return send.mock.calls.length;
    });
    expect(calls).toBe(0);
  });
});
