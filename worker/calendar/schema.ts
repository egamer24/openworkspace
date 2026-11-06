import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { BookingDateOverride, BookingWeeklyRange } from "../../shared/booking";
import {
  calendarEventStatuses,
  calendarTransparencies,
} from "../../shared/calendar";

export const calendars = sqliteTable("calendars", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  visible: integer("visible", { mode: "boolean" }).notNull().default(true),
  /**
   * Plain feed token so the owner can copy the URL again. The Worker resolves
   * feed requests through a hashed copy in D1 (`calendar_feeds`).
   */
  feedToken: text("feed_token"),
  createdAt: integer("created_at").notNull(),
});

/**
 * One row per series master or single event (`recurrenceId` null) and one per
 * overridden occurrence (`recurrenceId` = the occurrence's original start).
 * All instants are UTC epoch milliseconds; all-day events use UTC midnights
 * with an exclusive end.
 */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    recurrenceId: integer("recurrence_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    timeZone: text("time_zone").notNull(),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: calendarEventStatuses })
      .notNull()
      .default("confirmed"),
    transparency: text("transparency", { enum: calendarTransparencies })
      .notNull()
      .default("busy"),
    sequence: integer("sequence").notNull().default(0),
    rrule: text("rrule"),
    exdates: text("exdates", { mode: "json" })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    reminders: text("reminders", { mode: "json" })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_master_uid_unique")
      .on(table.uid)
      .where(sql`${table.recurrenceId} IS NULL`),
    uniqueIndex("events_override_unique").on(table.uid, table.recurrenceId),
    index("events_calendar_start_idx").on(table.calendarId, table.startsAt),
  ],
);

/** Public booking page types; times and ranges as in `BookingRules`. */
export const bookingTypes = sqliteTable(
  "booking_types",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    durationMinutes: integer("duration_minutes").notNull(),
    timeZone: text("time_zone").notNull(),
    weeklyHours: text("weekly_hours", { mode: "json" })
      .$type<BookingWeeklyRange[]>()
      .notNull()
      .default(sql`'[]'`),
    dateOverrides: text("date_overrides", { mode: "json" })
      .$type<BookingDateOverride[]>()
      .notNull()
      .default(sql`'[]'`),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    minimumNoticeMinutes: integer("minimum_notice_minutes").notNull().default(0),
    maxDaysAhead: integer("max_days_ahead").notNull().default(60),
    slotIntervalMinutes: integer("slot_interval_minutes").notNull(),
    dailyCap: integer("daily_cap"),
    collectNotes: integer("collect_notes", { mode: "boolean" }).notNull().default(true),
    /** Null: the first calendar. */
    calendarId: text("calendar_id"),
    /** Mailbox the guest confirmation is sent from; null sends none. */
    senderMailboxId: text("sender_mailbox_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("booking_types_slug_unique").on(table.slug)],
);

export const bookings = sqliteTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    bookingTypeId: text("booking_type_id")
      .notNull()
      .references(() => bookingTypes.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    guestName: text("guest_name").notNull(),
    guestEmail: text("guest_email").notNull(),
    guestTimeZone: text("guest_time_zone").notNull(),
    notes: text("notes").notNull().default(""),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    status: text("status", { enum: ["confirmed", "cancelled"] }).notNull().default("confirmed"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("bookings_type_start_idx").on(table.bookingTypeId, table.startsAt)],
);

export type CalendarRecord = typeof calendars.$inferSelect;
export type CalendarEventRecord = typeof events.$inferSelect;
export type NewCalendarEvent = typeof events.$inferInsert;
export type BookingTypeRecord = typeof bookingTypes.$inferSelect;
export type BookingRecord = typeof bookings.$inferSelect;
