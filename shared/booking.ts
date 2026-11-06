import { wallClock, weekdayCodes, zonedToUtc, type WeekdayCode } from "./calendar";

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Minutes after local midnight; `end` may be 1440 (midnight of the next day). */
export type BookingTimeRange = { start: number; end: number };
export type BookingWeeklyRange = BookingTimeRange & { day: WeekdayCode };
/** A date override replaces that date's weekly hours; no ranges = blackout day. */
export type BookingDateOverride = { date: string; ranges: BookingTimeRange[] };

export type BookingRules = {
  /** Host time zone the weekly hours and overrides are written in. */
  timeZone: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  maxDaysAhead: number;
  dailyCap: number | null;
  weeklyHours: BookingWeeklyRange[];
  dateOverrides: BookingDateOverride[];
};

export const BOOKING_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/u;
export const BOOKING_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/u;
/** Path segments under /book that a handle cannot take. */
export const RESERVED_BOOKING_HANDLES = ["manage"] as const;
export const MAX_BOOKING_TYPES = 50;

export function isValidBookingHandle(handle: string) {
  return BOOKING_HANDLE_PATTERN.test(handle)
    && !(RESERVED_BOOKING_HANDLES as readonly string[]).includes(handle);
}
export const MAX_BOOKING_SLOT_RANGE_DAYS = 31;

const pad = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDateKey(ms: number, timeZone: string) {
  const local = wallClock(ms, timeZone);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

/**
 * Free slot starts in `[from, to)`: the weekly hours (or that date's override)
 * minus busy time padded by the buffers, after the minimum notice, inside the
 * horizon and below the per-day cap. Each local date is converted to UTC on
 * its own, so slots keep their wall-clock times across DST changes; ranges
 * that contain a change step in real minutes from the range start.
 * `busy` must be sorted by start (as free/busy returns it).
 */
export function computeSlots(input: {
  rules: BookingRules;
  busy: Array<{ startsAt: number; endsAt: number }>;
  /** Starts of confirmed bookings of this type, for the daily cap. */
  bookedStarts: number[];
  now: number;
  from: number;
  to: number;
}) {
  const { rules, busy } = input;
  const earliest = Math.max(input.from, input.now + rules.minimumNoticeMinutes * MINUTE);
  const latest = Math.min(input.to, input.now + rules.maxDaysAhead * DAY);
  if (earliest >= latest) return [];
  const duration = rules.durationMinutes * MINUTE;
  const step = rules.slotIntervalMinutes * MINUTE;
  const before = rules.bufferBeforeMinutes * MINUTE;
  const after = rules.bufferAfterMinutes * MINUTE;
  const perDay = new Map<string, number>();
  for (const start of input.bookedStarts) {
    const key = localDateKey(start, rules.timeZone);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const overrides = new Map(rules.dateOverrides.map((item) => [item.date, item.ranges]));
  const isBusy = (start: number, end: number) =>
    busy.some((interval) => interval.startsAt < end && interval.endsAt > start);

  const slots = new Set<number>();
  const first = wallClock(earliest - DAY, rules.timeZone);
  for (let index = 0; ; index++) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + index));
    const local = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    const at = (minutes: number) => zonedToUtc({
      ...local,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
      second: 0,
    }, rules.timeZone);
    if (at(0) >= latest) break;
    const key = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
    if (rules.dailyCap !== null && (perDay.get(key) ?? 0) >= rules.dailyCap) continue;
    const weekday = weekdayCodes[(date.getUTCDay() + 6) % 7];
    const ranges = overrides.get(key) ?? rules.weeklyHours.filter((range) => range.day === weekday);
    for (const range of ranges) {
      const end = at(range.end);
      for (let start = at(range.start); start + duration <= end; start += step) {
        if (start < earliest || start >= latest) continue;
        if (isBusy(start - before, start + duration + after)) continue;
        slots.add(start);
      }
    }
  }
  return [...slots].sort((a, b) => a - b);
}

/** Groups slot starts by the guest's local date, for display. */
export function groupSlotsByDay(slots: number[], timeZone: string) {
  const days: Array<{ date: string; slots: number[] }> = [];
  for (const slot of slots) {
    const date = localDateKey(slot, timeZone);
    const last = days.at(-1);
    if (last?.date === date) last.slots.push(slot);
    else days.push({ date, slots: [slot] });
  }
  return days;
}

export function formatSlotTime(ms: number, timeZone: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(ms);
}

export function formatSlotDateTime(ms: number, timeZone: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(ms);
}
