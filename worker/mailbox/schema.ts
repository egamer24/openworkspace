import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { InvitationSummary } from "../../shared/calendar";
import { transportStates } from "../../shared/mail";
import { mailboxStates } from "./folder-model";
import type {
  EmailAiClassification,
  EmailAuthenticationResults,
  MailAddress,
  RecipientDeliveryStatus,
  StoredAttachment,
} from "./model";

/**
 * Only custom classification folders are stored. Inbox, Sent, Archive, Spam,
 * and Trash are computed views over `conversations`.
 */
export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(100),
  },
  (table) => [
    uniqueIndex("folders_name_unique").on(table.name),
    index("folders_order_idx").on(table.sortOrder, table.name),
  ],
);

/**
 * A row exists only while raw MIME still needs to be materialized as an email.
 * Deterministic MIME errors are converted into a visible fallback message;
 * this queue is reserved for retryable infrastructure failures.
 */
export const pendingInbound = sqliteTable(
  "pending_inbound",
  {
    id: text("id").primaryKey(),
    rawObjectKey: text("raw_object_key").notNull(),
    envelopeFrom: text("envelope_from").notNull(),
    envelopeTo: text("envelope_to").notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    aiAttempts: integer("ai_attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("pending_inbound_next_attempt_idx").on(
      table.nextAttemptAt,
      table.receivedAt,
    ),
  ],
);

/**
 * R2 cleanup is retried independently after a permanent conversation delete.
 * The row is committed in the same SQLite transaction as the metadata delete,
 * so a Worker interruption cannot leave untracked message objects behind.
 */
export const pendingObjectDeletions = sqliteTable(
  "pending_object_deletions",
  {
    objectKey: text("object_key").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("pending_object_deletions_next_attempt_idx").on(table.nextAttemptAt),
  ],
);

export const pendingOfficePreviews = sqliteTable(
  "pending_office_previews",
  {
    sourceKey: text("source_key").primaryKey(),
    emailId: text("email_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("pending_office_previews_next_attempt_idx").on(table.nextAttemptAt)],
);

/**
 * One row is one message visible in this Durable Object's mailbox. RFC
 * threading metadata and message content are immutable after insertion.
 */
export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    requestFingerprint: text("request_fingerprint"),
    conversationId: text("conversation_id").notNull(),
    direction: text("direction", { enum: ["incoming", "outgoing"] }).notNull(),

    messageIdHeader: text("message_id_header"),
    inReplyToJson: text("in_reply_to_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    referencesJson: text("references_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),

    fromJson: text("from_json", { mode: "json" })
      .$type<MailAddress[]>()
      .notNull(),
    replyToJson: text("reply_to_json", { mode: "json" })
      .$type<MailAddress[]>()
      .notNull()
      .default([]),
    toJson: text("to_json", { mode: "json" })
      .$type<MailAddress[]>()
      .notNull()
      .default([]),
    ccJson: text("cc_json", { mode: "json" })
      .$type<MailAddress[]>()
      .notNull()
      .default([]),
    bccJson: text("bcc_json", { mode: "json" })
      .$type<MailAddress[]>()
      .notNull()
      .default([]),

    subject: text("subject").notNull().default("(no subject)"),
    preview: text("preview").notNull().default(""),
    bodyText: text("body_text"),
    quotedText: text("quoted_text"),
    bodyHtmlR2Key: text("body_html_r2_key"),
    rawMimeR2Key: text("raw_mime_r2_key"),
    authenticationResultsJson: text("authentication_results_json", { mode: "json" })
      .$type<EmailAuthenticationResults>(),
    aiClassificationJson: text("ai_classification_json", { mode: "json" })
      .$type<EmailAiClassification>(),
    attachmentsJson: text("attachments_json", { mode: "json" })
      .$type<StoredAttachment[]>()
      .notNull()
      .default([]),
    /** Parsed iTIP (calendar invitation) part, when the calendar module is on. */
    invitationJson: text("invitation_json", { mode: "json" })
      .$type<InvitationSummary>(),

    listId: text("list_id"),
    listPostAddress: text("list_post_address"),
    timelineAt: integer("timeline_at", { mode: "timestamp_ms" }).notNull(),

    transportState: text("transport_state", { enum: transportStates }).notNull(),
    transportError: text("transport_error"),
    deliveryStatusJson: text("delivery_status_json", { mode: "json" })
      .$type<RecipientDeliveryStatus[]>()
      .notNull()
      .default([]),
  },
  (table) => [
    index("emails_conversation_timeline_idx").on(
      table.conversationId,
      table.timelineAt,
      table.id,
    ),
    index("emails_message_id_header_idx").on(table.messageIdHeader),
  ],
);

/**
 * Small mutable projection used by folder lists. A single insert trigger keeps
 * it synchronized with immutable email rows.
 */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    latestEmailId: text("latest_email_id")
      .notNull()
      .references(() => emails.id),
    timelineAt: integer("timeline_at", { mode: "timestamp_ms" }).notNull(),
    mailboxState: text("mailbox_state", { enum: mailboxStates })
      .notNull()
      .default("active"),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    hasIncoming: integer("has_incoming", { mode: "boolean" })
      .notNull()
      .default(false),
    hasOutgoing: integer("has_outgoing", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    index("conversations_timeline_idx").on(table.timelineAt, table.latestEmailId),
    index("conversations_inbox_timeline_idx").on(
      table.mailboxState,
      table.hasIncoming,
      table.timelineAt,
      table.latestEmailId,
    ),
    index("conversations_sent_timeline_idx").on(
      table.mailboxState,
      table.hasOutgoing,
      table.timelineAt,
      table.latestEmailId,
    ),
    index("conversations_folder_timeline_idx").on(
      table.folderId,
      table.timelineAt,
      table.latestEmailId,
    ),
  ],
);

export const mailboxAiConfiguration = sqliteTable(
  "mailbox_ai_configuration",
  {
    id: text("id").primaryKey(),
    instructions: text("instructions").notNull().default(""),
    confidenceThreshold: integer("confidence_threshold").notNull().default(75),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
);

/**
 * Read state belongs to a person, not to the mailbox. This keeps shared
 * mailboxes independent: one teammate viewing a message cannot clear another
 * teammate's unread state.
 */
export const emailReadStates = sqliteTable(
  "email_read_states",
  {
    userId: text("user_id").notNull(),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    readAt: integer("read_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.emailId] }),
    index("email_read_states_email_idx").on(table.emailId),
  ],
);

export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type EmailReadState = typeof emailReadStates.$inferSelect;
export type PendingInbound = typeof pendingInbound.$inferSelect;
export type PendingObjectDeletion = typeof pendingObjectDeletions.$inferSelect;
export type NewPendingInbound = typeof pendingInbound.$inferInsert;
export type ConversationRecord = typeof conversations.$inferSelect;
export type FolderRecord = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
