import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { replyActionModes, transportStates } from "../../shared/mail";
import { autoReplyAudiences } from "../mail/auto-reply";
import type { RuleAction, RuleCondition } from "../mail/rules";
import { mailboxStates } from "./folder-model";
import type {
  EmailAiClassification,
  DraftAttachment,
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
    /**
     * When `mailbox_state` last changed. Maintained by a database trigger so
     * every path that moves a conversation (UI, AI spam, new mail) updates it.
     */
    stateChangedAt: integer("state_changed_at", { mode: "timestamp_ms" }),
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
    index("conversations_state_changed_idx").on(table.mailboxState, table.stateChangedAt),
  ],
);

/** A single row (id = 1): days after which Trash and Spam are emptied; null keeps mail. */
export const retentionSettings = sqliteTable("retention_settings", {
  id: integer("id").primaryKey(),
  trashDays: integer("trash_days"),
  spamDays: integer("spam_days"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

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

/** One composer's saved state. A draft belongs to its author, even in shared mailboxes. */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["compose", "reply", "forward"] }).notNull(),
    replyMode: text("reply_mode", { enum: replyActionModes }),
    sourceMessageId: text("source_message_id"),
    conversationId: text("conversation_id"),
    toJson: text("to_json", { mode: "json" }).$type<string[]>().notNull(),
    ccJson: text("cc_json", { mode: "json" }).$type<string[]>().notNull(),
    bccJson: text("bcc_json", { mode: "json" }).$type<string[]>().notNull(),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    /** Editor HTML with `data-composer-asset` references, or plain text for replies. */
    editorBody: text("editor_body").notNull(),
    bodyText: text("body_text").notNull(),
    attachmentsJson: text("attachments_json", { mode: "json" })
      .$type<DraftAttachment[]>()
      .notNull(),
    version: integer("version").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("drafts_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

/** A single row (id = 1) holding this mailbox's out-of-office settings. */
export const autoReplySettings = sqliteTable("auto_reply_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  /** IANA zone the schedule was entered in; for display only. */
  timeZone: text("time_zone"),
  subject: text("subject"),
  bodyText: text("body_text").notNull(),
  audience: text("audience", { enum: autoReplyAudiences }).notNull(),
  skipInternal: integer("skip_internal", { mode: "boolean" }).notNull(),
  replyIntervalDays: integer("reply_interval_days").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** One row per sender that received an auto-reply during the current absence. */
export const autoReplyLog = sqliteTable(
  "auto_reply_log",
  {
    senderAddress: text("sender_address").primaryKey(),
    lastRepliedAt: integer("last_replied_at", { mode: "timestamp_ms" }).notNull(),
    lastOriginalEmailId: text("last_original_email_id").notNull(),
    lastOutboundMessageId: text("last_outbound_message_id"),
  },
  (table) => [index("auto_reply_log_replied_idx").on(table.lastRepliedAt)],
);

/** Ordered per-mailbox rules applied to live deliveries after AI classification. */
export const mailRules = sqliteTable(
  "mail_rules",
  {
    id: text("id").primaryKey(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    match: text("match", { enum: ["all", "any"] }).notNull(),
    conditionsJson: text("conditions_json", { mode: "json" }).$type<RuleCondition[]>().notNull(),
    actionsJson: text("actions_json", { mode: "json" }).$type<RuleAction[]>().notNull(),
    stopProcessing: integer("stop_processing", { mode: "boolean" }).notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("mail_rules_position_idx").on(table.position)],
);

export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type Draft = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;
export type AutoReplySettings = typeof autoReplySettings.$inferSelect;
export type RetentionSettings = typeof retentionSettings.$inferSelect;
export type MailRule = typeof mailRules.$inferSelect;
export type EmailReadState = typeof emailReadStates.$inferSelect;
export type PendingInbound = typeof pendingInbound.$inferSelect;
export type PendingObjectDeletion = typeof pendingObjectDeletions.$inferSelect;
export type NewPendingInbound = typeof pendingInbound.$inferInsert;
export type ConversationRecord = typeof conversations.$inferSelect;
export type FolderRecord = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
