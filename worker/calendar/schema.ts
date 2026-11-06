import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
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

export type CalendarRecord = typeof calendars.$inferSelect;
export type CalendarEventRecord = typeof events.$inferSelect;
export type NewCalendarEvent = typeof events.$inferInsert;
