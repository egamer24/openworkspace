import { mailboxes, oidcGrants, users } from "@open-workspace/core/module";
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** D1 tables of the mail module; core's tables are in @open-workspace/core. */

export const mailboxNotificationPreferences = sqliteTable(
  "mailbox_notification_preferences",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.userId] }),
    index("mailbox_notification_preferences_user_idx").on(table.userId),
  ]
);

/**
 * Browsers that get new-mail notifications, one row per device, bound to
 * the session that last registered it. Rows from before sessions were
 * recorded have none and are removed only with all of a person's sessions.
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Not a foreign key: expiry and core's pruning of old sessions must not
     * take the device's notifications with them. Re-registering moves the
     * row to the new session; only revoking or signing out of this one
     * removes it (the `sessionRevoked` hook).
     */
    sessionId: text("session_id"),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint),
    index("push_subscriptions_user_idx").on(table.userId),
    index("push_subscriptions_session_idx").on(table.sessionId),
  ]
);

/**
 * What people said about a sender in each mailbox (one row per message), so
 * every mailbox's classifier hears about spam reported elsewhere.
 * Per mailbox and address the latest stance wins: "not spam" replaces reports.
 */
export const senderReports = sqliteTable(
  "sender_reports",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    emailId: text("email_id").notNull(),
    address: text("address").notNull(),
    domain: text("domain").notNull(),
    label: text("label", { enum: ["spam", "not_spam"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.emailId] }),
    index("sender_reports_domain_idx").on(table.domain, table.address),
  ]
);

/** Workspace-wide sender blocks: an address or `@domain`, applied at ingestion in every mailbox. */
export const blockedSenders = sqliteTable("blocked_senders", {
  pattern: text("pattern").primaryKey(),
  createdByUserId: text("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * JMAP push subscriptions (RFC 8620 §7.2). Each belongs to the OAuth grant
 * that created it, so revoking the app's access removes it.
 */
export const jmapPushSubscriptions = sqliteTable(
  "jmap_push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    clientId: text("client_id").notNull(),
    deviceClientId: text("device_client_id").notNull(),
    url: text("url").notNull(),
    /** Web Push encryption keys (RFC 8291), base64url; both or neither. */
    p256dh: text("p256dh"),
    auth: text("auth"),
    verificationCode: text("verification_code").notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Data types to push, or null for all. */
    typesJson: text("types_json", { mode: "json" }).$type<string[] | null>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.clientId, table.userId],
      foreignColumns: [oidcGrants.clientId, oidcGrants.userId],
    }).onDelete("cascade"),
    uniqueIndex("jmap_push_subscriptions_device_unique").on(
      table.userId,
      table.deviceClientId
    ),
    index("jmap_push_subscriptions_expires_idx").on(table.expiresAt),
  ]
);

/**
 * Each mailbox's inbox counts, written by its Durable Object whenever its
 * mail changes, so mailbox lists read unread counts from D1 without waking
 * every mailbox. A person's unread count is `incomingCount` less their
 * `mailboxReadCounts.readCount` (no row: nothing read). `version` is the
 * mailbox's change counter the counts reflect.
 */
export const mailboxCounts = sqliteTable("mailbox_counts", {
  mailboxId: text("mailbox_id")
    .primaryKey()
    .references(() => mailboxes.id, { onDelete: "cascade" }),
  incomingCount: integer("incoming_count").notNull(),
  version: integer("version").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** How many of a mailbox's incoming inbox messages each person has read. */
export const mailboxReadCounts = sqliteTable(
  "mailbox_read_counts",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    readCount: integer("read_count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.userId] })]
);

/**
 * Journal of the optional write-once mail archive (`Email({ archive })`,
 * worker/mail/archive.ts): one row per received delivery or sent message.
 * No foreign key, so the record outlives the mailbox. Open rows (pending,
 * failed) are retried by the hourly cron.
 */
export const mailArchiveEntries = sqliteTable(
  "mail_archive_entries",
  {
    /** The inbound delivery id, or the sent message's id. */
    id: text("id").primaryKey(),
    /** The mailbox, or for list mail the mailing list. */
    mailboxId: text("mailbox_id").notNull(),
    direction: text("direction", { enum: ["incoming", "outgoing"] }).notNull(),
    /**
     * Where a retry reads the message: received mail's raw copy in
     * MAIL_STORAGE (kept until it is archived), or a staged copy under
     * `archive-staging/`. Null for sent mail, rebuilt from the mailbox.
     */
    sourceKey: text("source_key"),
    status: text("status", { enum: ["pending", "archived", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    archiveKey: text("archive_key").notNull(),
    sha256: text("sha256"),
    size: integer("size"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("mail_archive_entries_status_idx").on(table.status, table.createdAt),
    index("mail_archive_entries_source_idx").on(table.sourceKey),
    index("mail_archive_entries_mailbox_idx").on(table.mailboxId, table.status),
  ]
);
