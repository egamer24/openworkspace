import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { transportStates } from "../../shared/mail";
import type { AutoReplyAudience } from "../../shared/mail";
import type { RichImage } from "../../shared/rich-content";
import { mailboxStates } from "./folder-model";
import type {
  DeliveryFacts,
  EmailAiClassification,
  EmailScreening,
  ListUnsubscribe,
  MailAddress,
  RecipientDeliveryStatus,
  SenderIntel,
  StoredAttachment,
  StoredEmailAuthentication,
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
  ]
);

/**
 * Where a system folder sits in the mailbox's one folder order, once someone
 * has moved it. Without a row it keeps its default place; Inbox never has one.
 */
export const systemFolderOrder = sqliteTable("system_folder_order", {
  folderId: text("folder_id").primaryKey(),
  sortOrder: integer("sort_order").notNull(),
});

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
    /** The workspace mailing list this copy came through, if any. */
    listAddress: text("list_address"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    aiAttempts: integer("ai_attempts").notNull().default(0),
    /**
     * Attempts that ended without an outcome: counted before parsing and
     * given back when the attempt stores the message or records a failure,
     * so only attempts whose alarm was killed (CPU, memory) remain.
     */
    unfinishedAttempts: integer("unfinished_attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", {
      mode: "timestamp_ms",
    }).notNull(),
  },
  (table) => [
    index("pending_inbound_next_attempt_idx").on(
      table.nextAttemptAt,
      table.receivedAt
    ),
  ]
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
    nextAttemptAt: integer("next_attempt_at", {
      mode: "timestamp_ms",
    }).notNull(),
  },
  (table) => [
    index("pending_object_deletions_next_attempt_idx").on(table.nextAttemptAt),
  ]
);

export const pendingOfficePreviews = sqliteTable(
  "pending_office_previews",
  {
    sourceKey: text("source_key").primaryKey(),
    emailId: text("email_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", {
      mode: "timestamp_ms",
    }).notNull(),
  },
  (table) => [
    index("pending_office_previews_next_attempt_idx").on(table.nextAttemptAt),
  ]
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
    /** Header-derived sender authentication for incoming mail. */
    authenticationResultsJson: text("authentication_results_json", {
      mode: "json",
    }).$type<StoredEmailAuthentication>(),
    /** SMTP envelope as delivered by Email Routing (MAIL FROM / RCPT TO). */
    envelopeFrom: text("envelope_from"),
    envelopeTo: text("envelope_to"),
    listUnsubscribeJson: text("list_unsubscribe_json", {
      mode: "json",
    }).$type<ListUnsubscribe>(),
    /** DNS facts about the delivering server, gathered at ingestion. */
    senderIntelJson: text("sender_intel_json", {
      mode: "json",
    }).$type<SenderIntel>(),
    aiClassificationJson: text("ai_classification_json", {
      mode: "json",
    }).$type<EmailAiClassification>(),
    /** Who the message was written for and whether it was forwarded, from ingestion. */
    deliveryJson: text("delivery_json", {
      mode: "json",
    }).$type<DeliveryFacts>(),
    /** Sender-block decisions taken at ingestion, before AI classification. */
    screeningJson: text("screening_json", {
      mode: "json",
    }).$type<EmailScreening>(),
    /** Set to "spam" when someone in this mailbox reported the message; only its presence is read. */
    reportLabel: text("report_label", { enum: ["spam"] }),
    /**
     * The conversation this spam message named but was kept out of (#25).
     * It rejoins that conversation when it leaves Spam; cleared then.
     */
    splitFromConversationId: text("split_from_conversation_id"),
    attachmentsJson: text("attachments_json", { mode: "json" })
      .$type<StoredAttachment[]>()
      .notNull()
      .default([]),

    listId: text("list_id"),
    listPostAddress: text("list_post_address"),
    timelineAt: integer("timeline_at", { mode: "timestamp_ms" }).notNull(),

    transportState: text("transport_state", {
      enum: transportStates,
    }).notNull(),
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
      table.id
    ),
    index("emails_message_id_header_idx").on(table.messageIdHeader),
  ]
);

/**
 * Small mutable projection used by folder lists. Every email insert updates it
 * in the same transaction (`indexInsertedEmail`).
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
     * When the conversation entered Trash or Spam, which retention counts
     * from. Set only by moves into those two; stale anywhere else.
     */
    stateChangedAt: integer("state_changed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("conversations_state_changed_idx").on(
      table.mailboxState,
      table.stateChangedAt
    ),
    index("conversations_timeline_idx").on(
      table.timelineAt,
      table.latestEmailId
    ),
    index("conversations_inbox_timeline_idx").on(
      table.mailboxState,
      table.hasIncoming,
      table.timelineAt,
      table.latestEmailId
    ),
    index("conversations_sent_timeline_idx").on(
      table.mailboxState,
      table.hasOutgoing,
      table.timelineAt,
      table.latestEmailId
    ),
    index("conversations_folder_timeline_idx").on(
      table.folderId,
      table.timelineAt,
      table.latestEmailId
    ),
  ]
);

/**
 * Correspondent history of this mailbox, keyed by lowercased address. Inbound
 * counters drive the first-time-sender hint; outbound counters record that the
 * mailbox wrote to the address. `blocked_at` sends future mail to Spam;
 * rows keyed `@domain` block a whole domain. `trusted_at` ("Not spam")
 * suppresses caution-level hints and the AI spam verdict.
 */
export const senders = sqliteTable(
  "senders",
  {
    address: text("address").primaryKey(),
    domain: text("domain").notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    messageCount: integer("message_count").notNull().default(0),
    outboundCount: integer("outbound_count").notNull().default(0),
    lastOutboundAt: integer("last_outbound_at", { mode: "timestamp_ms" }),
    blockedAt: integer("blocked_at", { mode: "timestamp_ms" }),
    trustedAt: integer("trusted_at", { mode: "timestamp_ms" }),
    reportedAt: integer("reported_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("senders_domain_idx").on(table.domain)]
);

/**
 * Spam and not-spam reports made in this mailbox. They feed the
 * AI classifier as sender history and are never sent anywhere by themselves.
 */
export const senderFeedback = sqliteTable(
  "sender_feedback",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    domain: text("domain").notNull(),
    emailId: text("email_id"),
    /** "spam" or "not_spam"; any label other than "not_spam" is read as a report. */
    label: text("label", { enum: ["spam", "not_spam"] }).notNull(),
    userId: text("user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("sender_feedback_address_idx").on(table.address, table.createdAt),
    index("sender_feedback_domain_idx").on(table.domain),
  ]
);

/** Latest unsubscribe attempt per list (List-Id, else the From organizational domain). */
export const unsubscriptions = sqliteTable("unsubscriptions", {
  listKey: text("list_key").primaryKey(),
  emailId: text("email_id"),
  method: text("method", { enum: ["one_click", "mailto", "link"] }).notNull(),
  status: text("status", {
    enum: ["done", "requested", "opened", "failed"],
  }).notNull(),
  target: text("target"),
  detail: text("detail"),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** One of an auto-reply's two messages; its images are under `autoReplyImagePrefix`. */
export type AutoReplyMessage = {
  enabled: boolean;
  /** Null for "Auto: <original subject>". */
  subject: string | null;
  html: string;
  text: string;
  images: RichImage[];
};

/** One row (id 1): this mailbox's auto-reply. */
export const autoReplySettings = sqliteTable("auto_reply_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  replyIntervalDays: integer("reply_interval_days").notNull(),
  /** For senders in the workspace's mail domains. */
  inside: text("inside", { mode: "json" }).$type<AutoReplyMessage>().notNull(),
  /** For everyone else, or only people this mailbox has written to. */
  outside: text("outside", { mode: "json" })
    .$type<AutoReplyMessage & { audience: AutoReplyAudience }>()
    .notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** One row per sender answered during the current absence. */
export const autoReplyLog = sqliteTable(
  "auto_reply_log",
  {
    senderAddress: text("sender_address").primaryKey(),
    lastRepliedAt: integer("last_replied_at", {
      mode: "timestamp_ms",
    }).notNull(),
    lastOriginalEmailId: text("last_original_email_id").notNull(),
    lastOutboundMessageId: text("last_outbound_message_id"),
  },
  (table) => [index("auto_reply_log_replied_idx").on(table.lastRepliedAt)]
);

export const mailboxAiConfiguration = sqliteTable("mailbox_ai_configuration", {
  id: text("id").primaryKey(),
  instructions: text("instructions").notNull().default(""),
  confidenceThreshold: integer("confidence_threshold").notNull().default(75),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

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
  ]
);

export type Email = typeof emails.$inferSelect;

export type SenderRecord = typeof senders.$inferSelect;

export type UnsubscriptionRecord = typeof unsubscriptions.$inferSelect;

export type NewEmail = typeof emails.$inferInsert;

export type EmailReadState = typeof emailReadStates.$inferSelect;

export type PendingInbound = typeof pendingInbound.$inferSelect;

export type PendingObjectDeletion = typeof pendingObjectDeletions.$inferSelect;

export type NewPendingInbound = typeof pendingInbound.$inferInsert;

export type ConversationRecord = typeof conversations.$inferSelect;

export type AutoReplySettings = typeof autoReplySettings.$inferSelect;

export type FolderRecord = typeof folders.$inferSelect;

export type NewFolder = typeof folders.$inferInsert;
