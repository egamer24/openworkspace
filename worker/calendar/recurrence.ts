import { RRuleTemporal } from "rrule-temporal";
import { wallClock, type WallClock } from "../../shared/calendar";
import type { CalendarEventRecord } from "./schema";

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

export function formatIcsDate(value: WallClock) {
  return `${pad(value.year, 4)}${pad(value.month)}${pad(value.day)}`;
}

export function formatIcsLocal(value: WallClock) {
  return `${formatIcsDate(value)}T${pad(value.hour)}${pad(value.minute)}${pad(value.second)}`;
}

export function formatIcsUtc(ms: number) {
  return `${formatIcsLocal(wallClock(ms, "UTC"))}Z`;
}

type RecurringEvent = Pick<
  CalendarEventRecord,
  "startsAt" | "timeZone" | "allDay" | "rrule"
>;

function ruleFor(event: RecurringEvent) {
  // All-day events are stored as UTC midnights, so they recur in UTC and
  // never drift a day when a zone changes its offset.
  const timeZone = event.allDay ? "UTC" : event.timeZone;
  return new RRuleTemporal({
    rruleString: `DTSTART;TZID=${timeZone}:${formatIcsLocal(wallClock(event.startsAt, timeZone))}\nRRULE:${event.rrule}`,
  });
}

/** Occurrence starts of a recurring event with `from <= start <= to`. */
export function recurrenceStarts(event: RecurringEvent, from: number, to: number) {
  return ruleFor(event)
    .between(new Date(from), new Date(to), true)
    .map((date) => date.epochMilliseconds);
}

/** Number of occurrences that start before `at`. */
export function countOccurrencesBefore(event: RecurringEvent, at: number) {
  return ruleFor(event).all((date) => date.epochMilliseconds < at).length;
}

export type ExpandedOccurrence = {
  row: CalendarEventRecord;
  startsAt: number;
  endsAt: number;
  /** Original start of the occurrence inside its series (RECURRENCE-ID). */
  occurrenceStart: number | null;
};

/**
 * Expands masters and overrides into concrete occurrences. With `overlap`,
 * anything intersecting `[from, to)` is returned; otherwise only occurrences
 * that start inside it.
 */
export function expandOccurrences(
  rows: CalendarEventRecord[],
  from: number,
  to: number,
  overlap = true,
) {
  const overridden = new Map<string, Set<number>>();
  for (const row of rows) {
    if (row.recurrenceId === null) continue;
    const set = overridden.get(row.uid) ?? new Set();
    set.add(row.recurrenceId);
    overridden.set(row.uid, set);
  }
  const inRange = (start: number, end: number) => overlap
    ? start < to && Math.max(end, start + 1) > from
    : start >= from && start < to;
  const result: ExpandedOccurrence[] = [];
  for (const row of rows) {
    const duration = row.endsAt - row.startsAt;
    if (row.recurrenceId !== null || !row.rrule) {
      if (inRange(row.startsAt, row.endsAt)) {
        result.push({
          row,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          occurrenceStart: row.recurrenceId,
        });
      }
      continue;
    }
    const skipped = new Set([...row.exdates, ...overridden.get(row.uid) ?? []]);
    for (const start of recurrenceStarts(row, overlap ? from - duration : from, to)) {
      if (skipped.has(start) || !inRange(start, start + duration)) continue;
      result.push({ row, startsAt: start, endsAt: start + duration, occurrenceStart: start });
    }
  }
  return result.sort((a, b) => a.startsAt - b.startsAt);
}
