import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  computeSlots,
  formatSlotTime,
  groupSlotsByDay,
  type BookingRules,
} from "../shared/booking";
import { calendarStub } from "../worker/calendar";
import { readBookingToken, signBookingToken, verifyBookingToken } from "../worker/calendar/booking";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const allWeek = (["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const)
  .map((day) => ({ day, start: 0, end: 1_440 }));

function rules(overrides: Partial<BookingRules>): BookingRules {
  return {
    timeZone: "America/New_York",
    durationMinutes: 60,
    slotIntervalMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    maxDaysAhead: 365,
    dailyCap: null,
    weeklyHours: [],
    dateOverrides: [],
    ...overrides,
  };
}

const iso = (values: number[]) => values.map((value) => new Date(value).toISOString());
const NOW = Date.parse("2026-01-01T00:00:00Z");

describe("slot computation", () => {
  it("skips the missing hour when DST starts", () => {
    // Sunday 8 March 2026, New York jumps from 02:00 EST to 03:00 EDT.
    const slots = computeSlots({
      rules: rules({ weeklyHours: [{ day: "SU", start: 0, end: 6 * 60 }] }),
      busy: [],
      bookedStarts: [],
      now: NOW,
      from: Date.parse("2026-03-08T00:00:00Z"),
      to: Date.parse("2026-03-09T00:00:00Z"),
    });
    expect(iso(slots)).toEqual([
      "2026-03-08T05:00:00.000Z", // 00:00 EST
      "2026-03-08T06:00:00.000Z", // 01:00 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT
      "2026-03-08T08:00:00.000Z", // 04:00 EDT
      "2026-03-08T09:00:00.000Z", // 05:00 EDT
    ]);
  });

  it("offers the repeated hour twice when DST ends", () => {
    // Sunday 1 November 2026, 02:00 EDT falls back to 01:00 EST.
    const slots = computeSlots({
      rules: rules({ weeklyHours: [{ day: "SU", start: 0, end: 3 * 60 }] }),
      busy: [],
      bookedStarts: [],
      now: NOW,
      from: Date.parse("2026-11-01T00:00:00Z"),
      to: Date.parse("2026-11-02T00:00:00Z"),
    });
    expect(iso(slots)).toEqual([
      "2026-11-01T04:00:00.000Z", // 00:00 EDT
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T06:00:00.000Z", // 01:00 EST
      "2026-11-01T07:00:00.000Z", // 02:00 EST
    ]);
  });

  it("keeps wall-clock hours on both sides of a DST change", () => {
    const slots = computeSlots({
      rules: rules({ weeklyHours: [{ day: "FR", start: 9 * 60, end: 10 * 60 }] }),
      busy: [],
      bookedStarts: [],
      now: NOW,
      from: Date.parse("2026-03-01T00:00:00Z"),
      to: Date.parse("2026-03-15T00:00:00Z"),
    });
    expect(iso(slots)).toEqual(["2026-03-06T14:00:00.000Z", "2026-03-13T13:00:00.000Z"]);
  });

  it("pads busy time with the buffers", () => {
    const slots = computeSlots({
      rules: rules({
        timeZone: "UTC",
        durationMinutes: 30,
        slotIntervalMinutes: 30,
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 15,
        weeklyHours: [{ day: "MO", start: 9 * 60, end: 12 * 60 }],
      }),
      busy: [{ startsAt: Date.parse("2026-03-02T10:00:00Z"), endsAt: Date.parse("2026-03-02T11:00:00Z") }],
      bookedStarts: [],
      now: NOW,
      from: Date.parse("2026-03-02T00:00:00Z"),
      to: Date.parse("2026-03-03T00:00:00Z"),
    });
    expect(iso(slots)).toEqual(["2026-03-02T09:00:00.000Z", "2026-03-02T11:30:00.000Z"]);
  });

  it("respects minimum notice and the horizon", () => {
    const now = Date.parse("2026-03-02T09:10:00Z");
    const slots = computeSlots({
      rules: rules({ timeZone: "UTC", minimumNoticeMinutes: 120, maxDaysAhead: 1, weeklyHours: allWeek }),
      busy: [],
      bookedStarts: [],
      now,
      from: now - DAY,
      to: now + 5 * DAY,
    });
    expect(new Date(slots[0]!).toISOString()).toBe("2026-03-02T12:00:00.000Z");
    expect(new Date(slots.at(-1)!).toISOString()).toBe("2026-03-03T09:00:00.000Z");
  });

  it("closes a day once its cap is reached, counted in the host's zone", () => {
    const input = {
      rules: rules({ timeZone: "Asia/Tokyo", dailyCap: 1, weeklyHours: allWeek }),
      busy: [],
      now: NOW,
      from: Date.parse("2026-03-01T15:00:00Z"), // 2 March 00:00 Tokyo
      to: Date.parse("2026-03-03T15:00:00Z"),
    };
    // 23:00 UTC on 1 March is 08:00 on 2 March in Tokyo.
    const slots = computeSlots({ ...input, bookedStarts: [Date.parse("2026-03-01T23:00:00Z")] });
    expect(groupSlotsByDay(slots, "Asia/Tokyo").map((day) => day.date)).toEqual(["2026-03-03"]);
    expect(groupSlotsByDay(computeSlots({ ...input, bookedStarts: [] }), "Asia/Tokyo")
      .map((day) => day.date)).toEqual(["2026-03-02", "2026-03-03"]);
  });

  it("applies date overrides and blackout days", () => {
    const slots = computeSlots({
      rules: rules({
        timeZone: "UTC",
        weeklyHours: [{ day: "MO", start: 9 * 60, end: 11 * 60 }, { day: "TU", start: 9 * 60, end: 11 * 60 }],
        dateOverrides: [
          { date: "2026-03-02", ranges: [] },
          { date: "2026-03-03", ranges: [{ start: 14 * 60, end: 15 * 60 }] },
        ],
      }),
      busy: [],
      bookedStarts: [],
      now: NOW,
      from: Date.parse("2026-03-02T00:00:00Z"),
      to: Date.parse("2026-03-04T00:00:00Z"),
    });
    expect(iso(slots)).toEqual(["2026-03-03T14:00:00.000Z"]);
  });
});

describe("guest time zone display", () => {
  it("groups and labels slots in the guest's zone", () => {
    const slot = Date.parse("2026-03-10T23:30:00Z");
    expect(groupSlotsByDay([slot], "Asia/Tokyo")).toEqual([{ date: "2026-03-11", slots: [slot] }]);
    expect(groupSlotsByDay([slot], "America/Los_Angeles")).toEqual([{ date: "2026-03-10", slots: [slot] }]);
    expect(formatSlotTime(slot, "Asia/Tokyo", "en-US")).toBe("8:30 AM");
    expect(formatSlotTime(slot, "America/Los_Angeles", "en-US")).toBe("4:30 PM");
  });
});

describe("manage tokens", () => {
  it("verifies signature and expiry", async () => {
    const payload = { u: "usr_a", b: "bkg_a", e: Math.floor(NOW / 1_000) + 3_600 };
    const token = await signBookingToken("secret", payload);
    expect(readBookingToken(token)).toEqual(payload);
    expect(await verifyBookingToken("secret", token, NOW)).toEqual(payload);
    expect(await verifyBookingToken("other", token, NOW)).toBeNull();
    expect(await verifyBookingToken("secret", token, NOW + 2 * HOUR)).toBeNull();
    const [, signature] = token.split(".");
    const forged = await signBookingToken("secret", { ...payload, b: "bkg_b" });
    expect(await verifyBookingToken("secret", `${forged.split(".")[0]}.${signature}`, NOW)).toBeNull();
    expect(await verifyBookingToken("secret", "garbage", NOW)).toBeNull();
  });
});

describe("booking in the calendar object", () => {
  it("lets exactly one of two concurrent requests take a slot", async () => {
    const calendar = calendarStub(env, `usr_booking_${crypto.randomUUID()}`);
    const created = await calendar.createBookingType({
      slug: "chat",
      name: "Chat",
      durationMinutes: 30,
      timeZone: "UTC",
      weeklyHours: allWeek,
      enabled: true,
    });
    expect(created.ok).toBe(true);
    const now = Date.now();
    const slots = await calendar.availableSlots("chat", now, now + 2 * DAY);
    const start = slots![0]!;
    const guest = { start, name: "Guest", email: "guest@example.com", notes: "", timeZone: "UTC" };
    const results = await Promise.all([calendar.book("chat", guest), calendar.book("chat", { ...guest, name: "Other" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ status: 409 });
    expect(await calendar.availableSlots("chat", now, now + 2 * DAY)).not.toContain(start);
    // The event blocks the slot but the slot list never says why.
    expect(await calendar.freeBusy(start, start + 30 * MINUTE)).toEqual([{ startsAt: start, endsAt: start + 30 * MINUTE }]);
  });

  it("seeds two disabled starter types once", async () => {
    const calendar = calendarStub(env, `usr_booking_${crypto.randomUUID()}`);
    const types = await calendar.listBookingTypes("Europe/Berlin");
    expect(types.map((type) => [type.slug, type.durationMinutes, type.enabled, type.timeZone])).toEqual([
      ["15min", 15, false, "Europe/Berlin"],
      ["30min", 30, false, "Europe/Berlin"],
    ]);
    await calendar.deleteBookingType(types[0]!.id);
    expect(await calendar.listBookingTypes()).toHaveLength(1);
    expect(await calendar.publicBookingTypes()).toEqual([]);
  });
});
