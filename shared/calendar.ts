export const calendarEventStatuses = ["confirmed", "tentative", "cancelled"] as const;
export type CalendarEventStatus = (typeof calendarEventStatuses)[number];

export const calendarTransparencies = ["busy", "free"] as const;
export type CalendarTransparency = (typeof calendarTransparencies)[number];

/** How an edit or deletion of one occurrence applies to its series. */
export const calendarEditScopes = ["this", "following", "all"] as const;
export type CalendarEditScope = (typeof calendarEditScopes)[number];

export const recurrenceFrequencies = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
export type RecurrenceFrequency = (typeof recurrenceFrequencies)[number];

export const weekdayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type WeekdayCode = (typeof weekdayCodes)[number];

export const MAX_CALENDAR_COUNT = 50;
export const MAX_REMINDERS_PER_EVENT = 5;
/** Four weeks; bounds how far back the reminder scan has to look. */
export const MAX_REMINDER_MINUTES = 40_320;
export const MAX_EVENT_RANGE_DAYS = 400;

export type RecurrenceRule = {
  freq: RecurrenceFrequency;
  interval: number;
  /** `MO`, or with an ordinal for monthly/yearly rules: `2TU`, `-1FR`. */
  byDay?: string[];
  byMonthDay?: number[];
  byMonth?: number[];
  count?: number;
  /** UTC date-time, `YYYYMMDDTHHMMSSZ`. */
  until?: string;
};

const BY_DAY = /^([+-]?(?:[1-9]|[1-4]\d|5[0-3]))?(MO|TU|WE|TH|FR|SA|SU)$/u;
const UNTIL = /^\d{8}T\d{6}Z$/u;

function integerList(value: string, min: number, max: number, allowNegative: boolean) {
  const items = value.split(",").map(Number);
  return items.every((item) =>
    Number.isInteger(item)
    && Math.abs(item) >= min
    && Math.abs(item) <= max
    && (allowNegative || item > 0))
    ? items
    : null;
}

/**
 * Parses the RFC 5545 RRULE subset OpenWorkspace stores. Anything outside the
 * subset is rejected rather than silently dropped so imports can report it.
 */
export function parseRecurrenceRule(
  value: string,
): { rule: RecurrenceRule } | { error: string } {
  const parts = new Map<string, string>();
  for (const part of value.trim().replace(/^RRULE:/iu, "").split(";")) {
    if (!part) continue;
    const [key, raw] = part.split("=", 2);
    if (!key || raw === undefined) return { error: `Invalid rule part "${part}"` };
    parts.set(key.toUpperCase(), raw.toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (!recurrenceFrequencies.includes(freq as RecurrenceFrequency)) {
    return { error: `Unsupported FREQ "${freq ?? ""}"` };
  }
  const rule: RecurrenceRule = { freq: freq as RecurrenceFrequency, interval: 1 };
  for (const [key, raw] of parts) {
    if (key === "FREQ" || key === "WKST") continue;
    if (key === "INTERVAL") {
      const interval = Number(raw);
      if (!Number.isInteger(interval) || interval < 1 || interval > 999) {
        return { error: "INTERVAL must be between 1 and 999" };
      }
      rule.interval = interval;
    } else if (key === "COUNT") {
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 1 || count > 5_000) {
        return { error: "COUNT must be between 1 and 5000" };
      }
      rule.count = count;
    } else if (key === "UNTIL") {
      if (!UNTIL.test(raw)) return { error: "UNTIL must be a UTC date-time" };
      rule.until = raw;
    } else if (key === "BYDAY") {
      const days = raw.split(",");
      if (!days.every((day) => BY_DAY.test(day))) return { error: "Invalid BYDAY" };
      if (
        (rule.freq === "DAILY" || rule.freq === "WEEKLY")
        && days.some((day) => !weekdayCodes.includes(day as WeekdayCode))
      ) {
        return { error: "BYDAY ordinals need a monthly or yearly rule" };
      }
      rule.byDay = days;
    } else if (key === "BYMONTHDAY") {
      const days = integerList(raw, 1, 31, true);
      if (!days) return { error: "Invalid BYMONTHDAY" };
      rule.byMonthDay = days;
    } else if (key === "BYMONTH") {
      const months = integerList(raw, 1, 12, false);
      if (!months) return { error: "Invalid BYMONTH" };
      rule.byMonth = months;
    } else {
      return { error: `Unsupported rule part ${key}` };
    }
  }
  if (rule.count && rule.until) return { error: "COUNT and UNTIL cannot both be set" };
  return { rule };
}

export function formatRecurrenceRule(rule: RecurrenceRule) {
  return [
    `FREQ=${rule.freq}`,
    rule.interval > 1 ? `INTERVAL=${rule.interval}` : null,
    rule.byDay?.length ? `BYDAY=${rule.byDay.join(",")}` : null,
    rule.byMonthDay?.length ? `BYMONTHDAY=${rule.byMonthDay.join(",")}` : null,
    rule.byMonth?.length ? `BYMONTH=${rule.byMonth.join(",")}` : null,
    rule.count ? `COUNT=${rule.count}` : null,
    rule.until ? `UNTIL=${rule.until}` : null,
  ].filter(Boolean).join(";");
}

/** Queue job sent by a calendar Durable Object when a reminder is due. */
export type CalendarReminderPushJob = {
  type: "calendar-reminder";
  userId: string;
  eventId: string;
  occurrenceStart: number;
  occurredAt: number;
  title: string;
  body: string;
  /** Absent on the fan-out job; set on each per-device delivery job. */
  targetSubscriptionId?: string;
};

export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function wallClock(ms: number, timeZone: string): WallClock {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function wallClockAsUtc(value: WallClock) {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

/** UTC offset of `timeZone` at instant `ms`, in milliseconds. */
export function zoneOffset(ms: number, timeZone: string) {
  const whole = Math.floor(ms / 1_000) * 1_000;
  return wallClockAsUtc(wallClock(whole, timeZone)) - whole;
}

/**
 * Converts a wall-clock time in `timeZone` to UTC. Times skipped by a DST jump
 * resolve to the later offset, matching RFC 5545 §3.3.5.
 */
export function zonedToUtc(value: WallClock, timeZone: string) {
  const guess = wallClockAsUtc(value);
  // The offsets a day either side cover any transition near this time.
  const candidates = [...new Set([-86_400_000, 86_400_000]
    .map((delta) => guess - zoneOffset(guess + delta, timeZone)))];
  const exact = candidates.filter((ms) => wallClockAsUtc(wallClock(ms, timeZone)) === guess);
  // Repeated times take the first occurrence; skipped ones the later offset.
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}
