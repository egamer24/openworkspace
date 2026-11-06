import {
  isValidTimeZone,
  MAX_REMINDER_MINUTES,
  MAX_REMINDERS_PER_EVENT,
  formatRecurrenceRule,
  parseRecurrenceRule,
  wallClock,
  zonedToUtc,
  zoneOffset,
  type CalendarEventStatus,
} from "../../shared/calendar";
import { formatIcsDate, formatIcsLocal, formatIcsUtc } from "./recurrence";
import type { CalendarEventRecord } from "./schema";

const CRLF = "\r\n";
const encoder = new TextEncoder();
const DAY_MS = 86_400_000;

export function escapeIcsText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r\n|\r|\n/gu, "\\n");
}

/** Folds a content line at 75 octets without splitting UTF-8 sequences. */
export function foldIcsLine(line: string) {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    const limit = chunks.length ? 74 : 75;
    if (bytes + size > limit) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  chunks.push(current);
  return chunks.join(`${CRLF} `);
}

function formatOffset(ms: number) {
  const sign = ms < 0 ? "-" : "+";
  const total = Math.abs(Math.round(ms / 1_000));
  const hours = String(Math.floor(total / 3_600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3_600) / 60)).padStart(2, "0");
  const seconds = total % 60;
  return `${sign}${hours}${minutes}${seconds ? String(seconds).padStart(2, "0") : ""}`;
}

/**
 * Builds a VTIMEZONE from the runtime's IANA data: one observance per actual
 * offset change between `fromYear` and `toYear`, found by weekly probing and
 * a binary search to the second. Single-onset observances avoid guessing the
 * zone's yearly rule and stay exact for the years a feed needs.
 */
export function vtimezoneLines(timeZone: string, fromYear: number, toYear: number) {
  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  const transitions: Array<{ at: number; from: number; to: number }> = [];
  let previous = zoneOffset(start, timeZone);
  for (let probe = start + 7 * DAY_MS; probe < end + 7 * DAY_MS; probe += 7 * DAY_MS) {
    const offset = zoneOffset(probe, timeZone);
    if (offset === previous) continue;
    let low = probe - 7 * DAY_MS;
    let high = probe;
    while (high - low > 1_000) {
      const middle = Math.floor((low + high) / 2_000) * 1_000;
      if (zoneOffset(middle, timeZone) === previous) low = middle;
      else high = middle;
    }
    transitions.push({ at: high, from: previous, to: offset });
    previous = offset;
  }
  const initial = zoneOffset(start, timeZone);
  const observance = (at: number, from: number, to: number) => {
    const kind = to > from ? "DAYLIGHT" : "STANDARD";
    return [
      `BEGIN:${kind}`,
      `DTSTART:${formatIcsLocal(wallClock(at + from, "UTC"))}`,
      `TZOFFSETFROM:${formatOffset(from)}`,
      `TZOFFSETTO:${formatOffset(to)}`,
      `END:${kind}`,
    ];
  };
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${timeZone}`,
    ...observance(start, initial, initial),
    ...transitions.flatMap((item) => observance(item.at, item.from, item.to)),
    "END:VTIMEZONE",
  ];
}

const statusNames: Record<CalendarEventStatus, string> = {
  confirmed: "CONFIRMED",
  tentative: "TENTATIVE",
  cancelled: "CANCELLED",
};

/**
 * Serializes one calendar as RFC 5545 text. Recurring timed series use
 * `TZID` local times (with a generated VTIMEZONE) so they keep their
 * wall-clock time across DST; everything else uses UTC, which needs no
 * time zone definition. All-day events use `VALUE=DATE`.
 */
export function serializeCalendar(input: {
  name: string;
  events: CalendarEventRecord[];
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const masters = new Map(
    input.events
      .filter((event) => event.recurrenceId === null)
      .map((event) => [event.uid, event]),
  );
  const zoned = (event: CalendarEventRecord) =>
    Boolean(event.rrule) && !event.allDay && event.timeZone !== "UTC";
  const zoneYears = new Map<string, { from: number; to: number }>();
  for (const event of masters.values()) {
    if (!zoned(event)) continue;
    const from = wallClock(event.startsAt, "UTC").year;
    const to = Math.max(from, wallClock(now, "UTC").year) + 10;
    const current = zoneYears.get(event.timeZone);
    zoneYears.set(event.timeZone, {
      from: Math.min(current?.from ?? from, from),
      to: Math.max(current?.to ?? to, to),
    });
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenWorkspace//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.name)}`,
  ];
  for (const [timeZone, years] of zoneYears) {
    lines.push(...vtimezoneLines(timeZone, years.from, years.to));
  }

  for (const event of input.events) {
    const master = event.recurrenceId === null ? event : masters.get(event.uid);
    if (!master) continue;
    const date = (name: string, ms: number, style: CalendarEventRecord) => {
      if (style.allDay) return `${name};VALUE=DATE:${formatIcsDate(wallClock(ms, "UTC"))}`;
      if (zoned(style)) {
        return `${name};TZID=${style.timeZone}:${formatIcsLocal(wallClock(ms, style.timeZone))}`;
      }
      return `${name}:${formatIcsUtc(ms)}`;
    };
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcsText(event.uid)}`,
      `DTSTAMP:${formatIcsUtc(now)}`,
      `CREATED:${formatIcsUtc(event.createdAt)}`,
      `LAST-MODIFIED:${formatIcsUtc(event.updatedAt)}`,
      `SEQUENCE:${event.sequence}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    lines.push(
      `STATUS:${statusNames[event.status]}`,
      `TRANSP:${event.transparency === "free" ? "TRANSPARENT" : "OPAQUE"}`,
      // An override written in the master's style keeps RECURRENCE-ID
      // comparable; its own times can always be UTC.
      date("DTSTART", event.startsAt, event.recurrenceId === null ? event : { ...event, rrule: null }),
      date("DTEND", event.endsAt, event.recurrenceId === null ? event : { ...event, rrule: null }),
    );
    if (event.recurrenceId !== null) {
      lines.push(date("RECURRENCE-ID", event.recurrenceId, master));
    } else if (event.rrule) {
      lines.push(`RRULE:${event.rrule}`);
      for (const exdate of [...event.exdates].sort((a, b) => a - b)) {
        lines.push(date("EXDATE", exdate, event));
      }
    }
    for (const minutes of event.reminders) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(event.title)}`,
        `TRIGGER:-PT${minutes}M`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}

type ContentLine = {
  name: string;
  params: Record<string, string>;
  value: string;
};

function parseContentLine(line: string): ContentLine | null {
  let index = 0;
  let quoted = false;
  for (; index < line.length; index++) {
    const character = line[index];
    if (character === "\"") quoted = !quoted;
    else if (character === ":" && !quoted) break;
  }
  if (index >= line.length) return null;
  const [name = "", ...rawParams] = line.slice(0, index).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/u);
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const [key, ...rest] = param.split("=");
    if (key) params[key.toUpperCase()] = rest.join("=").replace(/^"|"$/gu, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(index + 1) };
}

export function unescapeIcsText(value: string) {
  return value.replace(/\\([\\;,nN])/gu, (_, character: string) =>
    character.toLowerCase() === "n" ? "\n" : character);
}

class UnsupportedEvent extends Error {}

function parseIcsInstant(
  value: string,
  params: Record<string, string>,
  floatingZone: string,
) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u);
  if (!match) throw new UnsupportedEvent(`Invalid date "${value}"`);
  const [, year, month, day, hour, minute, second, utc] = match;
  const clock = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
    second: Number(second ?? 0),
  };
  if (params.VALUE === "DATE" || hour === undefined) {
    return { ms: zonedToUtc(clock, "UTC"), allDay: true, timeZone: null, utc: false };
  }
  if (utc) return { ms: zonedToUtc(clock, "UTC"), allDay: false, timeZone: null, utc: true };
  const timeZone = params.TZID ?? floatingZone;
  if (!isValidTimeZone(timeZone)) {
    throw new UnsupportedEvent(`Unsupported time zone "${timeZone}"`);
  }
  return { ms: zonedToUtc(clock, timeZone), allDay: false, timeZone: params.TZID ?? null, utc: false };
}

function parseDuration(value: string) {
  const match = value.match(
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u,
  );
  if (!match || value === "P" || value.endsWith("T")) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms = (Number(weeks ?? 0) * 7 * DAY_MS)
    + (Number(days ?? 0) * DAY_MS)
    + (Number(hours ?? 0) * 3_600_000)
    + (Number(minutes ?? 0) * 60_000)
    + (Number(seconds ?? 0) * 1_000);
  return sign === "-" ? -ms : ms;
}

export type ParsedIcsEvent = {
  uid: string;
  recurrenceId: number | null;
  title: string;
  description: string;
  location: string;
  startsAt: number;
  endsAt: number;
  timeZone: string;
  allDay: boolean;
  status: CalendarEventStatus;
  transparency: "busy" | "free";
  sequence: number;
  rrule: string | null;
  exdates: number[];
  reminders: number[];
};

export type IcsSkip = { uid: string | null; title: string | null; reason: string };

function unfold(text: string) {
  return text.replace(/\r\n|\r/gu, "\n").replace(/\n[ \t]/gu, "").split("\n");
}

function eventFromLines(lines: ContentLine[], floatingZone: string): ParsedIcsEvent {
  const single = (name: string) => lines.find((line) => line.name === name);
  const uid = single("UID")?.value;
  if (!uid) throw new UnsupportedEvent("Missing UID");
  const startLine = single("DTSTART");
  if (!startLine) throw new UnsupportedEvent("Missing DTSTART");
  if (single("RDATE")) throw new UnsupportedEvent("RDATE is not supported");
  if (lines.filter((line) => line.name === "RRULE").length > 1) {
    throw new UnsupportedEvent("Multiple RRULEs are not supported");
  }
  const start = parseIcsInstant(startLine.value, startLine.params, floatingZone);
  const endLine = single("DTEND");
  const durationLine = single("DURATION");
  let endsAt: number;
  if (endLine) {
    endsAt = parseIcsInstant(endLine.value, endLine.params, floatingZone).ms;
  } else if (durationLine) {
    const duration = parseDuration(durationLine.value);
    if (duration === null || duration < 0) throw new UnsupportedEvent("Invalid DURATION");
    endsAt = start.ms + duration;
  } else {
    endsAt = start.ms + (start.allDay ? DAY_MS : 0);
  }
  if (endsAt < start.ms) throw new UnsupportedEvent("DTEND is before DTSTART");
  if (start.allDay && endsAt === start.ms) endsAt += DAY_MS;

  const ruleLine = single("RRULE");
  let rrule: string | null = null;
  if (ruleLine) {
    // Stored UNTIL is always a UTC date-time; DATE and floating forms are
    // widespread in exports, so normalize them first.
    const value = ruleLine.value.toUpperCase().replace(
      /UNTIL=(\d{8})(T\d{6})?Z?/u,
      (_, day: string, time?: string) =>
        `UNTIL=${day}${time ?? (start.allDay ? "T000000" : "T235959")}Z`,
    );
    const parsed = parseRecurrenceRule(value);
    if ("error" in parsed) throw new UnsupportedEvent(parsed.error);
    rrule = formatRecurrenceRule(parsed.rule);
  }
  const recurrenceLine = single("RECURRENCE-ID");
  const exdates = lines
    .filter((line) => line.name === "EXDATE")
    .flatMap((line) => line.value.split(",").map((value) =>
      parseIcsInstant(value, line.params, floatingZone).ms));
  const reminders = lines
    .filter((line) => line.name === "TRIGGER" && line.params.RELATED !== "END" && line.params.VALUE !== "DATE-TIME")
    .map((line) => parseDuration(line.value))
    .filter((value): value is number => value !== null && value <= 0)
    .map((value) => Math.round(-value / 60_000))
    .filter((value) => value <= MAX_REMINDER_MINUTES)
    .slice(0, MAX_REMINDERS_PER_EVENT);
  const status = single("STATUS")?.value.toUpperCase();
  const sequence = Number(single("SEQUENCE")?.value ?? 0);
  return {
    uid: unescapeIcsText(uid),
    recurrenceId: recurrenceLine
      ? parseIcsInstant(recurrenceLine.value, recurrenceLine.params, floatingZone).ms
      : null,
    title: unescapeIcsText(single("SUMMARY")?.value ?? "").slice(0, 500) || "(no title)",
    description: unescapeIcsText(single("DESCRIPTION")?.value ?? "").slice(0, 10_000),
    location: unescapeIcsText(single("LOCATION")?.value ?? "").slice(0, 500),
    startsAt: start.ms,
    endsAt,
    timeZone: start.timeZone ?? (start.utc && rrule ? "UTC" : floatingZone),
    allDay: start.allDay,
    status: status === "TENTATIVE" ? "tentative" : status === "CANCELLED" ? "cancelled" : "confirmed",
    transparency: single("TRANSP")?.value.toUpperCase() === "TRANSPARENT" ? "free" : "busy",
    sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
    rrule,
    exdates: [...new Set(exdates)],
    reminders: [...new Set(reminders)],
  };
}

/**
 * Parses the VEVENTs of an iCalendar document. VTIMEZONE blocks are skipped:
 * TZIDs must be IANA names, which the runtime resolves itself.
 */
export function parseIcs(text: string, floatingZone = "UTC") {
  const events: ParsedIcsEvent[] = [];
  const skipped: IcsSkip[] = [];
  let current: ContentLine[] | null = null;
  let depth = 0;
  for (const raw of unfold(text)) {
    if (!raw.trim()) continue;
    const line = parseContentLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN" && line.value.toUpperCase() === "VEVENT") {
      current = [];
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (line.name === "BEGIN") depth++;
    else if (line.name === "END" && depth > 0) depth--;
    else if (line.name === "END" && line.value.toUpperCase() === "VEVENT") {
      try {
        events.push(eventFromLines(current, floatingZone));
      } catch (error) {
        if (!(error instanceof UnsupportedEvent)) throw error;
        skipped.push({
          uid: current.find((item) => item.name === "UID")?.value ?? null,
          title: unescapeIcsText(current.find((item) => item.name === "SUMMARY")?.value ?? "") || null,
          reason: error.message,
        });
      }
      current = null;
      continue;
    } else if (depth === 0 || line.name === "TRIGGER") {
      // Nested components only contribute their reminder triggers.
      current.push(line);
    }
  }
  return { events, skipped };
}
