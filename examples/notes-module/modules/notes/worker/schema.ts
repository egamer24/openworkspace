import { users } from "@open-workspace/core/module";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The module's D1 tables, in the workspace's database next to core's.
 * `bun run db:generate` (drizzle-kit) writes their migrations to ../migrations.
 */

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("notes_author_created_idx").on(table.authorUserId, table.createdAt),
  ]
);

/** A person's settings for the app; a missing row means the defaults. */
export const notePreferences = sqliteTable("note_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  order: text("order", { enum: ["newest", "title"] })
    .notNull()
    .default("newest"),
});
