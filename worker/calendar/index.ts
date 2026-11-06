import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, gte, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/calendar/migrations.js";
import {
  formatRecurrenceRule,
  MAX_CALENDAR_COUNT,
  MAX_REMINDER_MINUTES,
  parseRecurrenceRule,
  type CalendarAttendee,
  type CalendarEditScope,
  type CalendarOrganizer,
  type InvitationResponse,
  type ItipMethod,
  type CalendarEventStatus,
  type CalendarReminderPushJob,
  type CalendarTransparency,
} from "../../shared/calendar";
import { createId } from "../lib/ids";
import { parseIcs, serializeCalendar, type IcsSkip, type ParsedIcsEvent } from "./ics";
import { calendarModuleEnabled } from "./module";
import {
  countOccurrencesBefore,
  expandOccurrences,
  formatIcsUtc,
  type ExpandedOccurrence,
} from "./recurrence";
import {
  calendars,
  events,
  type CalendarEventRecord,
  type CalendarRecord,
} from "./schema";

const schema = { calendars, events };
type CalendarDatabase = DrizzleSqliteDODatabase<typeof schema>;

const DEFAULT_CALENDAR_COLOR = "#2563eb";
const REMINDER_CURSOR_KEY = "reminderCursor";
/** Reminders older than this when the alarm finally runs are dropped. */
const STALE_REMINDER_MS = 15 * 60_000;
const REMINDER_HORIZON_MS = 30 * 86_400_000;

export type CalendarEventFields = {
  title: string;
  description: string;
  location: string;
  startsAt: number;
  endsAt: number;
  timeZone: string;
  allDay: boolean;
  status: CalendarEventStatus;
  transparency: CalendarTransparency;
  rrule: string | null;
  reminders: number[];
  organizer: CalendarOrganizer | null;
  attendees: CalendarAttendee[];
};

export type CreateCalendarEventInput = Partial<CalendarEventFields>
  & Pick<CalendarEventFields, "title" | "startsAt" | "endsAt" | "timeZone">
  & { calendarId?: string };

export type UpdateCalendarEventInput = Partial<CalendarEventFields> & {
  calendarId?: string;
  scope?: CalendarEditScope;
  occurrenceStart?: number;
};

export type CalendarResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404; message: string };

const notFound = { ok: false, status: 404, message: "Event not found" } as const;
const badRequest = (message: string) => ({ ok: false, status: 400, message }) as const;

export type CalendarOccurrence = {
  /** Row to pass back for updates: the series master or an override. */
  eventId: string;
  seriesId: string | null;
  calendarId: string;
  uid: string;
  occurrenceStart: number | null;
  title: string;
  description: string;
  location: string;
  startsAt: number;
  endsAt: number;
  timeZone: string;
  allDay: boolean;
  status: CalendarEventStatus;
  transparency: CalendarTransparency;
  rrule: string | null;
  reminders: number[];
  organizer: CalendarOrganizer | null;
  attendees: CalendarAttendee[];
};

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function calendarView(calendar: CalendarRecord) {
  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.color,
    visible: calendar.visible,
    feedToken: calendar.feedToken,
  };
}

export type CalendarView = ReturnType<typeof calendarView>;

/**
 * Ends a series just before `at`: COUNT becomes the number of earlier
 * occurrences so the rule stays equivalent, otherwise UNTIL is set.
 */
function truncateRule(master: CalendarEventRecord, at: number) {
  const parsed = parseRecurrenceRule(master.rrule ?? "");
  if ("error" in parsed) return { rrule: null, remaining: undefined };
  const before = countOccurrencesBefore(master, at);
  const { count, until: _until, ...rest } = parsed.rule;
  return {
    rrule: formatRecurrenceRule({ ...rest, until: formatIcsUtc(at - 1_000) }),
    remaining: count === undefined ? undefined : Math.max(1, count - before),
    before,
  };
}

export class CalendarDO extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private readonly db: CalendarDatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx;
    this.bindings = env;
    this.db = drizzle(ctx.storage, { schema });
    ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  private get userId() {
    return this.state.id.name ?? "unknown-user";
  }

  listCalendars(): CalendarView[] {
    let rows = this.db.select().from(calendars).orderBy(asc(calendars.createdAt)).all();
    if (!rows.length) {
      const calendar = {
        id: createId("cal"),
        name: "Personal",
        color: DEFAULT_CALENDAR_COLOR,
        visible: true,
        feedToken: null,
        createdAt: Date.now(),
      };
      this.db.insert(calendars).values(calendar).run();
      rows = [calendar];
    }
    return rows.map(calendarView);
  }

  createCalendar(input: { name: string; color: string }): CalendarResult<CalendarView> {
    const count = this.db.select({ count: sql<number>`count(*)` }).from(calendars).get()?.count ?? 0;
    if (count >= MAX_CALENDAR_COUNT) {
      return badRequest(`A user can have at most ${MAX_CALENDAR_COUNT} calendars`);
    }
    const calendar = {
      id: createId("cal"),
      name: input.name,
      color: input.color,
      visible: true,
      feedToken: null,
      createdAt: Date.now(),
    };
    this.db.insert(calendars).values(calendar).run();
    return { ok: true, value: calendarView(calendar) };
  }

  updateCalendar(
    calendarId: string,
    patch: { name?: string; color?: string; visible?: boolean },
  ) {
    const row = this.db.update(calendars).set(patch).where(eq(calendars.id, calendarId)).returning().get();
    return row ? calendarView(row) : null;
  }

  async deleteCalendar(calendarId: string) {
    const deleted = this.db.transaction((tx) => {
      tx.delete(events).where(eq(events.calendarId, calendarId)).run();
      return tx.delete(calendars).where(eq(calendars.id, calendarId)).returning().get();
    });
    if (deleted) await this.scheduleReminders();
    return Boolean(deleted);
  }

  /** Stores (or clears) the plain feed token shown to the owner. */
  setFeedToken(calendarId: string, token: string | null) {
    return Boolean(this.db.update(calendars)
      .set({ feedToken: token })
      .where(eq(calendars.id, calendarId))
      .returning()
      .get());
  }

  /** Serves a feed only while the token still matches the calendar. */
  feed(calendarId: string, token: string) {
    const calendar = this.db.select().from(calendars).where(eq(calendars.id, calendarId)).get();
    if (!calendar?.feedToken || calendar.feedToken !== token) return null;
    return serializeCalendar({
      name: calendar.name,
      events: this.db.select().from(events).where(eq(events.calendarId, calendarId)).all(),
    });
  }

  exportCalendar(calendarId: string) {
    const calendar = this.db.select().from(calendars).where(eq(calendars.id, calendarId)).get();
    if (!calendar) return null;
    return serializeCalendar({
      name: calendar.name,
      events: this.db.select().from(events).where(eq(events.calendarId, calendarId)).all(),
    });
  }

  private rowsOverlapping(from: number, to: number, calendarId?: string) {
    return this.db.select().from(events).where(and(
      calendarId ? eq(events.calendarId, calendarId) : undefined,
      or(
        isNotNull(events.rrule),
        isNotNull(events.recurrenceId),
        and(sql`${events.startsAt} < ${to}`, sql`max(${events.endsAt}, ${events.startsAt} + 1) > ${from}`),
      ),
    )).all();
  }

  async listOccurrences(from: number, to: number, calendarId?: string) {
    await this.ensureReminderAlarm();
    return expandOccurrences(this.rowsOverlapping(from, to, calendarId), from, to)
      .map((occurrence) => this.occurrenceView(occurrence));
  }

  private occurrenceView({ row, startsAt, endsAt, occurrenceStart }: ExpandedOccurrence): CalendarOccurrence {
    const partOfSeries = Boolean(row.rrule) || row.recurrenceId !== null;
    const master = row.recurrenceId === null ? row : this.master(row.uid);
    return {
      eventId: row.id,
      seriesId: partOfSeries ? master?.id ?? null : null,
      calendarId: row.calendarId,
      uid: row.uid,
      occurrenceStart: partOfSeries ? occurrenceStart : null,
      title: row.title,
      description: row.description,
      location: row.location,
      startsAt,
      endsAt,
      timeZone: row.timeZone,
      allDay: row.allDay,
      status: row.status,
      transparency: row.transparency,
      rrule: master?.rrule ?? null,
      reminders: row.reminders,
      organizer: row.organizer,
      attendees: row.attendees,
    };
  }

  /** Busy intervals, merged, ignoring free and cancelled events. */
  freeBusy(from: number, to: number, excludeUid?: string) {
    const busy = expandOccurrences(this.rowsOverlapping(from, to), from, to)
      .filter(({ row }) => row.transparency === "busy" && row.status !== "cancelled" && row.uid !== excludeUid)
      .map(({ startsAt, endsAt }) => ({ startsAt: Math.max(startsAt, from), endsAt: Math.min(endsAt, to) }))
      .filter((interval) => interval.endsAt > interval.startsAt);
    const merged: Array<{ startsAt: number; endsAt: number }> = [];
    for (const interval of busy) {
      const last = merged.at(-1);
      if (last && interval.startsAt <= last.endsAt) last.endsAt = Math.max(last.endsAt, interval.endsAt);
      else merged.push({ ...interval });
    }
    return merged;
  }

  getEvent(eventId: string) {
    return this.db.select().from(events).where(eq(events.id, eventId)).get() ?? null;
  }

  /** The series master (or single event) first, then its overrides. */
  seriesRows(uid: string) {
    return this.db.select().from(events)
      .where(eq(events.uid, uid))
      .orderBy(sql`${events.recurrenceId} IS NOT NULL`, asc(events.recurrenceId))
      .all();
  }

  /** The viewer's own answer to an invitation already on this calendar. */
  invitationResponse(uid: string, address: string) {
    const master = this.master(uid);
    return master?.attendees.find((attendee) => sameAddress(attendee.address, address))?.partstat ?? null;
  }

  /**
   * Answers an invitation organized by someone else: accepted and tentative
   * events are added (or replaced by the newer copy), declined ones removed
   * so they stop counting as busy. `parsed` holds the VEVENTs of one UID.
   */
  async respondToInvitation(input: {
    parsed: ParsedIcsEvent[];
    address: string;
    name: string | null;
    partstat: InvitationResponse;
  }): Promise<CalendarResult<{ eventId: string | null }>> {
    const uid = input.parsed[0]?.uid;
    if (!uid) return badRequest("The invitation has no event");
    const existing = this.master(uid);
    if (existing?.organizer?.mailboxId) return badRequest("You organize this event");
    const now = Date.now();
    const withAnswer = (event: ParsedIcsEvent) => {
      const own = event.attendees.some((attendee) => sameAddress(attendee.address, input.address));
      const attendees = event.attendees.map((attendee) =>
        sameAddress(attendee.address, input.address)
          ? { ...attendee, partstat: input.partstat, rsvp: false }
          : attendee);
      return {
        ...event,
        // Invited through an alias or a list: record the answer anyway.
        attendees: own ? attendees : [...attendees, {
          address: input.address,
          name: input.name,
          role: "REQ-PARTICIPANT" as const,
          partstat: input.partstat,
          rsvp: false,
        }],
        status: input.partstat === "TENTATIVE" && event.status === "confirmed" ? "tentative" as const : event.status,
      };
    };
    const hasMaster = input.parsed.some((event) => event.recurrenceId === null);
    const declined = input.partstat === "DECLINED";
    const calendarId = existing?.calendarId ?? this.listCalendars()[0]!.id;
    const eventId = this.db.transaction((tx) => {
      const insert = (event: ParsedIcsEvent, recurrenceId: number | null) => tx.insert(events).values({
        ...withAnswer(event),
        id: createId("evt"),
        calendarId,
        recurrenceId,
        rrule: recurrenceId === null ? event.rrule : null,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: events.id }).get().id;
      if (hasMaster) {
        // A full REQUEST carries the series and every override: replace them.
        tx.delete(events).where(eq(events.uid, uid)).run();
        if (declined) return null;
        const ordered = [...input.parsed].sort((a, b) =>
          Number(a.recurrenceId !== null) - Number(b.recurrenceId !== null));
        return ordered.map((event) => insert(event, event.recurrenceId))[0] ?? null;
      }
      // Only some occurrences were sent: update those of a known series, or
      // keep a lone occurrence as a single event.
      if (!existing?.rrule) {
        tx.delete(events).where(eq(events.uid, uid)).run();
        return declined ? null : insert(input.parsed[0]!, null);
      }
      let first: string | null = null;
      for (const event of input.parsed) {
        tx.delete(events).where(and(eq(events.uid, uid), eq(events.recurrenceId, event.recurrenceId!))).run();
        if (!declined) first ??= insert(event, event.recurrenceId);
      }
      if (declined) {
        tx.update(events).set({
          exdates: [...new Set([...existing.exdates, ...input.parsed.map((event) => event.recurrenceId!)])],
          updatedAt: now,
        }).where(eq(events.id, existing.id)).run();
      }
      return first;
    });
    await this.scheduleReminders();
    return { ok: true, value: { eventId } };
  }

  /**
   * Applies an incoming REPLY or CANCEL. Strict: a REPLY must come from an
   * invited attendee of an event this mailbox organizes, a CANCEL from the
   * organizer of an event someone else organizes. Returns whether it applied.
   */
  async applyItip(input: {
    method: Exclude<ItipMethod, "REQUEST">;
    uid: string;
    recurrenceId: number | null;
    sender: string;
    mailboxId: string;
    attendees: CalendarAttendee[];
  }) {
    const master = this.master(input.uid);
    if (!master?.organizer) return false;
    const now = Date.now();
    if (input.method === "REPLY") {
      if (master.organizer.mailboxId !== input.mailboxId) return false;
      const answer = input.attendees.find((attendee) => sameAddress(attendee.address, input.sender));
      if (!answer || !master.attendees.some((attendee) => sameAddress(attendee.address, input.sender))) {
        return false;
      }
      // ponytail: a reply for one occurrence updates the whole series; per-occurrence answers need override rows.
      for (const row of this.seriesRows(input.uid)) {
        this.db.update(events).set({
          attendees: row.attendees.map((attendee) => sameAddress(attendee.address, input.sender)
            ? { ...attendee, partstat: answer.partstat }
            : attendee),
          updatedAt: now,
        }).where(eq(events.id, row.id)).run();
      }
      return true;
    }
    if (master.organizer.mailboxId !== null || !sameAddress(master.organizer.address, input.sender)) {
      return false;
    }
    if (input.recurrenceId !== null && master.rrule) {
      this.db.transaction((tx) => {
        tx.delete(events).where(and(eq(events.uid, input.uid), eq(events.recurrenceId, input.recurrenceId!))).run();
        tx.update(events).set({
          exdates: [...new Set([...master.exdates, input.recurrenceId!])],
          updatedAt: now,
        }).where(eq(events.id, master.id)).run();
      });
    } else {
      this.db.update(events).set({ status: "cancelled", updatedAt: now }).where(eq(events.uid, input.uid)).run();
    }
    await this.scheduleReminders();
    return true;
  }

  private master(uid: string) {
    return this.db.select().from(events)
      .where(and(eq(events.uid, uid), isNull(events.recurrenceId)))
      .get();
  }

  private calendarExists(calendarId: string) {
    return Boolean(this.db.select({ id: calendars.id }).from(calendars).where(eq(calendars.id, calendarId)).get());
  }

  async createEvent(input: CreateCalendarEventInput): Promise<CalendarResult<CalendarEventRecord>> {
    const calendarId = input.calendarId ?? this.listCalendars()[0]!.id;
    if (!this.calendarExists(calendarId)) return { ok: false, status: 404, message: "Calendar not found" };
    const now = Date.now();
    const row = this.db.insert(events).values({
      description: "",
      location: "",
      allDay: false,
      status: "confirmed",
      transparency: "busy",
      rrule: null,
      reminders: [],
      organizer: null,
      attendees: [],
      ...input,
      id: createId("evt"),
      calendarId,
      uid: `${crypto.randomUUID()}@openworkspace`,
      recurrenceId: null,
      sequence: 0,
      exdates: [],
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    await this.scheduleReminders();
    return { ok: true, value: row };
  }

  /**
   * Applies an edit. For an occurrence of a series, `scope` picks between an
   * override of that occurrence, splitting the series at it, or editing the
   * series. Time changes on "all" are applied as a shift relative to the
   * edited occurrence so exceptions keep matching.
   */
  async updateEvent(
    eventId: string,
    input: UpdateCalendarEventInput,
  ): Promise<CalendarResult<CalendarEventRecord>> {
    const { scope = "all", occurrenceStart: requestedStart, calendarId, ...fields } = input;
    const row = this.getEvent(eventId);
    if (!row) return notFound;
    if (calendarId !== undefined && !this.calendarExists(calendarId)) {
      return { ok: false, status: 404, message: "Calendar not found" };
    }
    const now = Date.now();
    const master = row.recurrenceId === null ? row : this.master(row.uid);
    if (!master) return notFound;

    // Single event, or an override edited by itself.
    if (!master.rrule || (row.recurrenceId !== null && scope === "this")) {
      const updated = this.db.update(events).set({
        ...fields,
        ...(row.recurrenceId === null && calendarId ? { calendarId } : {}),
        ...(row.recurrenceId !== null ? { rrule: null } : {}),
        sequence: row.sequence + 1,
        updatedAt: now,
      }).where(eq(events.id, row.id)).returning().get();
      await this.scheduleReminders();
      return { ok: true, value: updated! };
    }

    const occurrenceStart = row.recurrenceId ?? requestedStart;
    if (scope !== "all" && occurrenceStart === undefined) {
      return badRequest("occurrenceStart is required to edit one occurrence");
    }

    if (scope === "this") {
      const existing = this.db.select({ id: events.id }).from(events)
        .where(and(eq(events.uid, master.uid), eq(events.recurrenceId, occurrenceStart!)))
        .get();
      if (existing) return this.updateEvent(existing.id, { ...fields, scope: "this" });
      const duration = master.endsAt - master.startsAt;
      const override = this.db.insert(events).values({
        ...master,
        ...fields,
        id: createId("evt"),
        recurrenceId: occurrenceStart!,
        startsAt: fields.startsAt ?? occurrenceStart!,
        endsAt: fields.endsAt ?? (fields.startsAt ?? occurrenceStart!) + duration,
        rrule: null,
        exdates: [],
        sequence: master.sequence + 1,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
      await this.scheduleReminders();
      return { ok: true, value: override };
    }

    // Times arrive as the edited occurrence's new times; turn them into a
    // shift and a duration change for the series. An override is displayed
    // at its own (possibly moved) time, so that is what the edit is relative to.
    const masterDuration = master.endsAt - master.startsAt;
    const shownStart = row.recurrenceId !== null ? row.startsAt : occurrenceStart ?? master.startsAt;
    const shownDuration = row.recurrenceId !== null ? row.endsAt - row.startsAt : masterDuration;
    const newStart = fields.startsAt ?? shownStart;
    const newDuration = fields.endsAt === undefined ? shownDuration : fields.endsAt - newStart;
    const shift = newStart - shownStart;
    const duration = Math.max(0, masterDuration + newDuration - shownDuration);

    if (scope === "following" && occurrenceStart! > master.startsAt) {
      const created = this.splitSeries(master, occurrenceStart!, {
        ...fields,
        calendarId,
        startsAt: occurrenceStart! + shift,
        endsAt: occurrenceStart! + shift + duration,
      }, now);
      await this.scheduleReminders();
      return created;
    }

    // "all" (or "following" from the first occurrence).
    const ruleChanged = fields.rrule !== undefined && fields.rrule !== master.rrule;
    const updated = this.db.transaction((tx) => {
      if (ruleChanged) {
        tx.delete(events).where(and(eq(events.uid, master.uid), isNotNull(events.recurrenceId))).run();
      } else if (shift) {
        for (const override of tx.select().from(events)
          .where(and(eq(events.uid, master.uid), isNotNull(events.recurrenceId))).all()) {
          tx.update(events)
            .set({ recurrenceId: override.recurrenceId! + shift })
            .where(eq(events.id, override.id))
            .run();
        }
      }
      if (calendarId) {
        tx.update(events).set({ calendarId }).where(eq(events.uid, master.uid)).run();
      }
      return tx.update(events).set({
        ...fields,
        startsAt: master.startsAt + shift,
        endsAt: master.startsAt + shift + duration,
        exdates: ruleChanged ? [] : master.exdates.map((value) => value + shift),
        sequence: master.sequence + 1,
        updatedAt: now,
      }).where(eq(events.id, master.id)).returning().get();
    });
    await this.scheduleReminders();
    return { ok: true, value: updated! };
  }

  /** "This and following": end the old series and start a new one at `at`. */
  private splitSeries(
    master: CalendarEventRecord,
    at: number,
    fields: Partial<CalendarEventFields> & { calendarId?: string; startsAt: number; endsAt: number },
    now: number,
  ): CalendarResult<CalendarEventRecord> {
    const truncated = truncateRule(master, at);
    if (!truncated.rrule) return badRequest("The series has an invalid recurrence rule");
    const original = parseRecurrenceRule(master.rrule!);
    if ("error" in original) return badRequest(original.error);
    const continued = formatRecurrenceRule({ ...original.rule, count: truncated.remaining });
    const { startsAt } = fields;
    const shift = startsAt - at;
    const { calendarId, ...eventFields } = fields;
    return {
      ok: true,
      value: this.db.transaction((tx) => {
        tx.delete(events).where(and(
          eq(events.uid, master.uid),
          isNotNull(events.recurrenceId),
          gte(events.recurrenceId, at),
        )).run();
        tx.update(events).set({
          rrule: truncated.rrule,
          exdates: master.exdates.filter((value) => value < at),
          sequence: master.sequence + 1,
          updatedAt: now,
        }).where(eq(events.id, master.id)).run();
        return tx.insert(events).values({
          ...master,
          ...eventFields,
          id: createId("evt"),
          calendarId: calendarId ?? master.calendarId,
          uid: `${crypto.randomUUID()}@openworkspace`,
          startsAt,
          endsAt: fields.endsAt,
          rrule: fields.rrule !== undefined ? fields.rrule : continued,
          exdates: fields.rrule !== undefined
            ? []
            : master.exdates.filter((value) => value >= at).map((value) => value + shift),
          sequence: 0,
          createdAt: now,
          updatedAt: now,
        }).returning().get();
      }),
    };
  }

  async deleteEvent(
    eventId: string,
    input: { scope?: CalendarEditScope; occurrenceStart?: number },
  ): Promise<CalendarResult<{ deleted: true }>> {
    const row = this.getEvent(eventId);
    if (!row) return notFound;
    const master = row.recurrenceId === null ? row : this.master(row.uid);
    const scope = input.scope ?? "all";
    const occurrenceStart = row.recurrenceId ?? input.occurrenceStart;
    const now = Date.now();
    if (!master?.rrule || scope === "all" || (scope === "following" && occurrenceStart !== undefined && occurrenceStart <= master.startsAt)) {
      this.db.delete(events).where(eq(events.uid, row.uid)).run();
    } else if (occurrenceStart === undefined) {
      return badRequest("occurrenceStart is required to delete one occurrence");
    } else if (scope === "this") {
      this.db.transaction((tx) => {
        tx.delete(events).where(and(eq(events.uid, master.uid), eq(events.recurrenceId, occurrenceStart))).run();
        tx.update(events).set({
          exdates: [...new Set([...master.exdates, occurrenceStart])],
          sequence: master.sequence + 1,
          updatedAt: now,
        }).where(eq(events.id, master.id)).run();
      });
    } else {
      const truncated = truncateRule(master, occurrenceStart);
      this.db.transaction((tx) => {
        tx.delete(events).where(and(
          eq(events.uid, master.uid),
          isNotNull(events.recurrenceId),
          gte(events.recurrenceId, occurrenceStart),
        )).run();
        tx.update(events).set({
          rrule: truncated.rrule,
          exdates: master.exdates.filter((value) => value < occurrenceStart),
          sequence: master.sequence + 1,
          updatedAt: now,
        }).where(eq(events.id, master.id)).run();
      });
    }
    await this.scheduleReminders();
    return { ok: true, value: { deleted: true } };
  }

  /**
   * Imports VEVENTs into a calendar. Events whose UID already exists are
   * skipped so repeating an import is harmless.
   */
  async importIcs(calendarId: string, text: string, floatingZone: string) {
    if (!this.calendarExists(calendarId)) return null;
    const parsed = parseIcs(text, floatingZone);
    const skipped: IcsSkip[] = [...parsed.skipped];
    const now = Date.now();
    let imported = 0;
    const ordered = [...parsed.events].sort((a, b) =>
      Number(a.recurrenceId !== null) - Number(b.recurrenceId !== null));
    for (const event of ordered) {
      const skip = (reason: string) => skipped.push({ uid: event.uid, title: event.title, reason });
      if (event.recurrenceId === null) {
        if (this.master(event.uid)) {
          skip("An event with this UID already exists");
          continue;
        }
      } else {
        const master = this.master(event.uid);
        if (!master?.rrule || master.calendarId !== calendarId) {
          skip("Occurrence override without its series");
          continue;
        }
        if (this.db.select({ id: events.id }).from(events)
          .where(and(eq(events.uid, event.uid), eq(events.recurrenceId, event.recurrenceId))).get()) {
          skip("This occurrence override already exists");
          continue;
        }
      }
      this.db.insert(events).values({
        ...event,
        id: createId("evt"),
        calendarId,
        rrule: event.recurrenceId === null ? event.rrule : null,
        createdAt: now,
        updatedAt: now,
      }).run();
      imported++;
    }
    await this.scheduleReminders();
    return { imported, skipped };
  }

  /** Reminder triggers `start - minutes` with `from < trigger <= to`. */
  private reminderTriggers(from: number, to: number) {
    const rows = this.db.select().from(events).where(and(
      ne(events.reminders, sql`'[]'`),
      ne(events.status, "cancelled"),
    )).all();
    if (!rows.length) return { triggers: [], hasReminders: false };
    // Masters without reminders still matter: their overrides and exdates
    // decide which occurrences exist.
    const uids = new Set(rows.map((row) => row.uid));
    const related = this.db.select().from(events).all().filter((row) => uids.has(row.uid));
    const triggers = expandOccurrences(related, from, to + MAX_REMINDER_MINUTES * 60_000 + 1, false)
      .flatMap((occurrence) => occurrence.row.reminders.map((minutes) => ({
        at: occurrence.startsAt - minutes * 60_000,
        minutes,
        occurrence,
      })))
      .filter((trigger) => trigger.at > from && trigger.at <= to && trigger.occurrence.row.status !== "cancelled")
      .sort((a, b) => a.at - b.at);
    return { triggers, hasReminders: true };
  }

  private async ensureReminderAlarm() {
    if (await this.state.storage.getAlarm() === null) await this.scheduleReminders();
  }

  private async scheduleReminders(now = Date.now()) {
    if (this.state.storage.kv.get(REMINDER_CURSOR_KEY) === undefined) {
      this.state.storage.kv.put(REMINDER_CURSOR_KEY, now);
    }
    const { triggers, hasReminders } = this.reminderTriggers(now, now + REMINDER_HORIZON_MS);
    if (!hasReminders) {
      await this.state.storage.deleteAlarm();
      return;
    }
    // Nothing inside the horizon: wake up at its edge and scan again.
    await this.state.storage.setAlarm(triggers[0]?.at ?? now + REMINDER_HORIZON_MS);
  }

  /**
   * Sends every reminder due since the last run as a push job, then schedules
   * the next one. Nothing is sent while the calendar module is disabled.
   */
  async alarm() {
    const now = Date.now();
    const cursor = Number(this.state.storage.kv.get(REMINDER_CURSOR_KEY) ?? now);
    if (!await calendarModuleEnabled(this.bindings.DB)) {
      this.state.storage.kv.put(REMINDER_CURSOR_KEY, now);
      return;
    }
    const due = this.reminderTriggers(Math.max(cursor, now - STALE_REMINDER_MS), now).triggers;
    if (due.length) {
      const jobs: MessageSendRequest<CalendarReminderPushJob>[] = due.map(({ minutes, occurrence }) => ({
        body: {
          type: "calendar-reminder",
          userId: this.userId,
          eventId: occurrence.row.id,
          occurrenceStart: occurrence.startsAt,
          occurredAt: now,
          title: occurrence.row.title.slice(0, 500),
          body: reminderBody(occurrence, minutes),
        },
      }));
      for (let index = 0; index < jobs.length; index += 100) {
        await this.bindings.PUSH_NOTIFICATIONS.sendBatch(jobs.slice(index, index + 100));
      }
    }
    this.state.storage.kv.put(REMINDER_CURSOR_KEY, now);
    await this.scheduleReminders(now);
  }
}

function reminderBody(occurrence: ExpandedOccurrence, minutes: number) {
  const when = occurrence.row.allDay
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(occurrence.startsAt)
    : new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: occurrence.row.timeZone,
      }).format(occurrence.startsAt);
  const lead = minutes === 0 ? "Now" : minutes < 60 ? `In ${minutes} min` : when;
  return [lead === when ? when : `${lead} · ${when}`, occurrence.row.location]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 1_000);
}

export function calendarStub(env: Env, userId: string) {
  return env.CALENDAR.getByName(userId);
}
