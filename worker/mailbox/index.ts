import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/mailbox/migrations.js";
import { officePreviewExtension, officePreviewKey } from "../../shared/office-preview";
import {
  dispatchOfficePreviewJobs,
  hasPendingOfficePreviews,
  insertOfficePreviewJobs,
  nextOfficePreviewAttempt,
  prepareOfficePreviews,
} from "./office-preview-jobs";
import {
  MAX_CUSTOM_FOLDER_COUNT,
  MAILBOX_REALTIME_UPDATE,
  type MailboxPushJob,
  type MailboxRealtimeClientMessage,
} from "../../shared/mail";
import {
  classifyInboundEmail,
  EmailAiClassificationError,
  MAILBOX_AI_MAX_ATTEMPTS,
  MAILBOX_AI_MODEL,
} from "../mail/ai-classification";
import { globalAiProcessingEnabled } from "../ai/configuration";
import { calendarStub } from "../calendar";
import { calendarModuleEnabled } from "../calendar/module";
import {
  inboundMessageId,
  MissingRawMimeError,
  prepareInboundEmail,
  prepareUnprocessableInboundEmail,
  readInboundRawMime,
  UnprocessableInboundEmailError,
  type PreparedInboundEmail,
} from "../mail/inbound";
import {
  assessSpam,
  DEFAULT_SPAM_THRESHOLD,
  DEFAULT_SUSPICIOUS_THRESHOLD,
  matchSenderList,
  MAX_SPAM_SENDER_RULES,
  parseAuthenticationResults,
  readHeaderBlock,
  spamSenderCandidates,
  type SpamAssessment,
  type SpamSenderList,
  type SpamThresholds,
} from "../mail/spam-filter";
import {
  learnedSpamProbability,
  MAX_SPAM_TOKENS,
  messageSpamTokens,
  SPAM_LEARNING_MINIMUM,
  SPAM_TOKENS_PRUNE_TO,
  type SpamLabel,
} from "../mail/spam-learning";
import { prepareOutboundDelivery } from "../mail/outbound-delivery";
import { cloudflareDmarcPass } from "../mail/rfc";
import {
  suggestParticipants,
  type ParticipantSource,
} from "../mail/participants";
import { listActiveMailboxSessions } from "../mail/mailbox-directory";
import { buildEmailSearchQuery } from "../mail/search";
import { compileEmailFilter, type EmailFilter } from "../jmap/email-query";
import {
  AUTO_REPLY_HOURLY_CAP,
  autoReplyRecipient,
  autoReplyStatus,
  buildAutoReply,
  messageSkipReason,
  parseHeaderBlock,
  type AutoReplyAudience,
} from "../mail/auto-reply";
import { mailboxAddressPredicate, mailboxAddressSql } from "../db/mailboxes";
import {
  evaluateRules,
  forwardHops,
  headerBlock,
  MAX_FORWARD_HOPS,
  ruleMatches,
  type RuleInput,
} from "../mail/rules";
import { buildRuleForward } from "../mail/rule-forward";
import { createDb } from "../db/client";
import { domains, mailboxMembers, mailboxes } from "../db/schema";
import { createId, normalizeMailboxAddress } from "../lib/ids";
import {
  deferWebhookTask,
  emailWebhookEventId,
  queueWebhookEvent,
} from "../webhooks/service";
import {
  customFolderPredicate,
  folderAggregateJoinPredicate,
  systemFolderDefinitions,
  systemFolderPredicate,
  type MailboxState,
  type SystemFolderType,
} from "./folder-model";
import {
  autoReplyLog,
  autoReplySettings,
  conversations,
  drafts,
  emailReadStates,
  retentionSettings,
  mailRules,
  emails,
  folders,
  mailboxAiConfiguration,
  pendingInbound,
  pendingObjectDeletions,
  type Draft,
  type AutoReplySettings,
  spamFilterSettings,
  spamSenderRules,
  type Email,
  type FolderRecord,
  type RetentionSettings,
  type MailRule,
  type NewEmail,
  type NewFolder,
  type PendingInbound,
} from "./schema";
import type {
  EmailAiClassification,
  EmailAuthenticationResults,
  MailboxAiConfiguration,
  RecipientDeliveryStatus,
} from "./model";

const schema = {
  conversations,
  emailReadStates,
  emails,
  folders,
  mailboxAiConfiguration,
  pendingInbound,
  pendingObjectDeletions,
  spamFilterSettings,
  spamSenderRules,
};
type MailboxDatabase = DrizzleSqliteDODatabase<typeof schema>;
const INBOUND_ALARM_BATCH_SIZE = 1;
const OBJECT_DELETION_ALARM_BATCH_SIZE = 100;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_INBOUND_RETRY_AGE_MS = 24 * 60 * 60 * 1000;
const ALARM_WAKE_DELAY_MS = 1_000;
const PRESENCE_TTL_MS = 60_000;
const AI_CONFIGURATION_ID = "default";
const SPAM_SETTINGS_ID = "default";

type MailboxSocketAttachment = {
  userId: string;
  sessionId: string;
  sessionTokenHash: string;
  visibility: "visible" | "hidden";
  presenceUpdatedAt: number;
};

function socketAttachment(socket: WebSocket): MailboxSocketAttachment | null {
  const value = socket.deserializeAttachment();
  if (!value || typeof value !== "object") return null;
  const attachment = value as Partial<MailboxSocketAttachment>;
  if (
    typeof attachment.userId !== "string"
    || typeof attachment.sessionId !== "string"
    || typeof attachment.sessionTokenHash !== "string"
    || !["visible", "hidden"].includes(attachment.visibility ?? "")
    || typeof attachment.presenceUpdatedAt !== "number"
  ) {
    return null;
  }
  return attachment as MailboxSocketAttachment;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function retryDelay(attempts: number) {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    5_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
  );
}

function stringListJson(values: string[]) {
  return JSON.stringify([...new Set(values)]);
}

export type JmapChangeType = "Email" | "Thread" | "Mailbox";
type JmapChangeKind = "created" | "updated" | "destroyed";

export type ConversationUpdate = {
  mailboxState?: MailboxState;
  folderId?: string | null;
};

export type ConversationCursorPosition = {
  timelineAt: number;
  emailId: string;
};

export type ConversationListItem = {
  email: Email;
  messageCount: number;
  unreadCount: number;
  hasIncoming: boolean;
};

export type SpamSettings = SpamThresholds & {
  allow: string[];
  block: string[];
};

export type SubmitOutgoingResult = {
  outcome: "inserted" | "existing" | "conflict";
  email: Email;
};

export type InboundDeliveryInput = {
  id: string;
  mailboxId: string;
  rawObjectKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: number;
};

export type MailImportInput = {
  deliveryId: string;
  rawObjectKey: string;
  raw: ArrayBuffer;
  mailboxAddress: string;
  direction: "incoming" | "outgoing" | "auto";
  state: MailboxState;
  folder: string | null;
  seen: boolean;
  readerUserIds: string[];
  /** Epoch ms; null uses the message's Date header, then now. */
  receivedAt: number | null;
};

export type MailImportResult =
  | { status: "imported" | "duplicate"; messageId: string }
  | { status: "unparseable" | "invalid_folder"; message: string };
export type DraftInput = Omit<Draft, "userId" | "version" | "updatedAt">;

export type SaveDraftResult =
  | { status: "saved"; draft: Draft }
  | { status: "conflict"; draft: Draft | null }
  | { status: "limit" };

const MAX_DRAFTS_PER_USER = 500;
export type AutoReplyInput = {
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  timeZone: string | null;
  subject: string | null;
  bodyText: string;
  audience: AutoReplyAudience;
  skipInternal: boolean;
  replyIntervalDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Bounds each emptying or retention pass so a huge Trash can't monopolize the object. */
const RETENTION_BATCH_SIZE = 100;
const MAX_RULES = 100;
const RULE_TEST_SCAN = 500;

function ruleView(rule: MailRule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    match: rule.match,
    conditions: rule.conditionsJson,
    actions: rule.actionsJson,
    stopProcessing: rule.stopProcessing,
    updatedAt: rule.updatedAt,
  };
}

export type MailRuleView = ReturnType<typeof ruleView>;

export type FolderListItem = {
  id: string;
  name: string;
  kind: "system" | "custom";
  systemType: SystemFolderType | null;
  sortOrder: number;
  totalCount: number;
  unreadCount: number;
};

type MailFolder =
  | (FolderRecord & { kind: "custom"; systemType: null })
  | {
      id: string;
      name: string;
      kind: "system";
      systemType: SystemFolderType;
      sortOrder: number;
    };

type ConversationRow = {
  email_id: string;
  timeline_at: number;
  message_count: number;
  unread_count: number;
  has_incoming: number;
};

type ConversationSnapshotCountRow = {
  message_count: number;
  unread_count: number;
};

type FolderCountRow = {
  total_count: number;
  unread_count: number;
};

type FolderListRow = {
  id: string;
  name: string;
  kind: "system" | "custom";
  system_type: SystemFolderType | null;
  sort_order: number;
  total_count: number;
  unread_count: number;
};

export type FolderCounts = {
  totalCount: number;
  unreadCount: number;
};

function folderMembership(folder: MailFolder) {
  if (folder.kind === "custom") {
    return {
      predicate: `
        c.folder_id = ?
        and ${customFolderPredicate("c")}
      `,
      bindings: [folder.id],
    };
  }
  return {
    predicate: systemFolderPredicate(folder.systemType, "c"),
    bindings: [],
  };
}

const SYSTEM_FOLDER_DEFINITIONS_JSON = JSON.stringify(systemFolderDefinitions);
const FOLDER_AGGREGATE_JOIN_PREDICATE = folderAggregateJoinPredicate(
  "folder",
  "conversation",
);

export type TransportUpdate = {
  state: Email["transportState"];
  messageIdHeader?: string;
  error?: string | null;
};

export class MailboxDO extends DurableObject<Env> {
  private readonly db: MailboxDatabase;
  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private recentParticipantSources: ParticipantSource[] | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx;
    this.bindings = env;
    this.db = drizzle(ctx.storage, { schema });
    ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const userId = request.headers.get("x-openworkspace-user-id");
    const sessionId = request.headers.get("x-openworkspace-session-id");
    const sessionTokenHash = request.headers.get("x-openworkspace-session-token-hash");
    if (!userId || !sessionId || !sessionTokenHash) {
      return new Response("Authentication required", { status: 401 });
    }
    const requestedVisibility = request.headers.get("x-openworkspace-visibility");
    const visibility = requestedVisibility === "hidden" ? "hidden" : "visible";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      userId,
      sessionId,
      sessionTokenHash,
      visibility,
      presenceUpdatedAt: Date.now(),
    } satisfies MailboxSocketAttachment);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    if (message !== "visible" && message !== "hidden") return;
    const visibility: MailboxRealtimeClientMessage = message;
    const attachment = socketAttachment(socket);
    if (!attachment) return;
    socket.serializeAttachment({
      ...attachment,
      visibility,
      presenceUpdatedAt: Date.now(),
    } satisfies MailboxSocketAttachment);
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason);
  }

  webSocketError(socket: WebSocket) {
    socket.close(1011, "Realtime connection failed");
  }

  async deleteMailboxData() {
    for (const socket of this.state.getWebSockets()) {
      socket.close(1001, "Mailbox deleted");
    }
    this.recentParticipantSources = null;
    await this.state.storage.deleteAll();
  }

  async shouldSuppressPush(messageId: string, userId: string) {
    const messageState = this.db
      .select({
        messageId: emails.id,
        readByUserId: emailReadStates.userId,
      })
      .from(emails)
      .leftJoin(
        emailReadStates,
        and(
          eq(emailReadStates.emailId, emails.id),
          eq(emailReadStates.userId, userId),
        ),
      )
      .where(eq(emails.id, messageId))
      .get();
    if (!messageState || messageState.readByUserId) return true;
    const visibleAfter = Date.now() - PRESENCE_TTL_MS;
    return (await this.authorizedSockets({ userId, visibleAfter })).length > 0;
  }

  private async authorizedSockets(filter?: {
    userId: string;
    visibleAfter: number;
  }) {
    const sockets = this.state.getWebSockets().flatMap((socket) => {
      const attachment = socketAttachment(socket);
      if (attachment) {
        if (
          filter
          && (
            attachment.userId !== filter.userId
            || attachment.visibility !== "visible"
            || attachment.presenceUpdatedAt < filter.visibleAfter
          )
        ) {
          return [];
        }
        return [{ socket, attachment }];
      }
      socket.close(1008, "Realtime authorization expired");
      return [];
    });
    if (!sockets.length) return sockets;

    const mailboxId = this.state.id.name;
    if (!mailboxId) {
      for (const { socket } of sockets) socket.close(1008, "Mailbox identity is unavailable");
      return [];
    }
    const sessionIds = [...new Set(
      sockets.map(({ attachment }) => attachment.sessionId),
    )];
    const validSessions = await listActiveMailboxSessions(
      this.bindings.DB,
      mailboxId,
      sessionIds,
      Date.now(),
    );
    const validSessionsById = new Map(
      validSessions.map((session) => [session.id, session]),
    );
    return sockets.flatMap(({ socket, attachment }) => {
      const session = validSessionsById.get(attachment.sessionId);
      if (
        session?.userId === attachment.userId
        && session.tokenHash === attachment.sessionTokenHash
      ) {
        return [{ socket, attachment }];
      }
      socket.close(1008, "Realtime authorization expired");
      return [];
    });
  }

  private async broadcastUpdate() {
    let sockets: Awaited<ReturnType<MailboxDO["authorizedSockets"]>>;
    try {
      sockets = await this.authorizedSockets();
    } catch {
      try {
        sockets = await this.authorizedSockets();
      } catch (error) {
        // Closing forces clients to reconnect and refresh instead of silently
        // losing the only invalidation now that there is no polling fallback.
        for (const socket of this.state.getWebSockets()) {
          socket.close(1011, "Realtime authorization is temporarily unavailable");
        }
        throw error;
      }
    }
    for (const { socket } of sockets) {
      try {
        socket.send(MAILBOX_REALTIME_UPDATE);
      } catch {
        socket.close(1011, "Could not deliver realtime event");
      }
    }
  }

  private publishUpdate() {
    this.state.waitUntil(this.broadcastUpdate().catch((error) => {
      console.error("Could not authorize realtime delivery", error);
    }));
  }

  private queueIncomingNotification(email: Email) {
    if (email.direction !== "incoming") return;
    const sender = email.fromJson[0];
    const job: MailboxPushJob = {
      type: "dispatch",
      mailboxId: this.state.id.name ?? "unknown-mailbox",
      conversationId: email.conversationId,
      messageId: email.id,
      occurredAt: Date.now(),
      sender: sender?.name || sender?.address || "Unknown sender",
      subject: email.subject,
    };
    return this.bindings.PUSH_NOTIFICATIONS.send(job);
  }

  private retryStoredInboundNotification(
    job: PendingInbound,
    now: number,
    error: unknown,
  ) {
    if (now - job.receivedAt.getTime() >= MAX_INBOUND_RETRY_AGE_MS) {
      this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
      console.error(`Stopped retrying notification for inbound delivery ${job.id}`, error);
      return;
    }
    const attempts = job.attempts + 1;
    this.db
      .update(pendingInbound)
      .set({
        attempts,
        nextAttemptAt: new Date(now + retryDelay(attempts)),
      })
      .where(eq(pendingInbound.id, job.id))
      .run();
    console.error(`Could not queue notification for inbound delivery ${job.id}`, error);
  }

  private async finishStoredInbound(
    job: PendingInbound,
    email: Email,
    now: number,
    announce: boolean,
  ) {
    try {
      const mailboxId = this.state.id.name ?? "unknown-mailbox";
      deferWebhookTask(
        (task) => this.state.waitUntil(task),
        () => queueWebhookEvent(this.bindings, {
          eventId: emailWebhookEventId("email.received", mailboxId, email.id),
          eventType: "email.received",
          occurredAt: email.timelineAt.getTime(),
          source: { kind: "email", mailboxId, messageId: email.id },
        }),
      );
      if (announce) this.publishUpdate();
      const conversation = this.db
        .select({ mailboxState: conversations.mailboxState })
        .from(conversations)
        .where(eq(conversations.id, email.conversationId))
        .all()[0];
      // Only Inbox and custom folders notify; at delivery time a conversation
      // is elsewhere only because spam classification or a rule moved it.
      if (conversation?.mailboxState === "active") {
        await this.queueIncomingNotification(email);
      }
      this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
    } catch (error) {
      this.retryStoredInboundNotification(job, now, error);
    }
  }

  listConversations(
    userId: string,
    folderId: string,
    limit: number,
    cursor: ConversationCursorPosition | null,
    search: string | undefined,
    unreadOnly = false,
  ) {
    const folder = this.getFolder(folderId);
    if (!folder) return null;
    const membership = folderMembership(folder);
    const searchQuery = search ? buildEmailSearchQuery(search) : undefined;
    if (search && !searchQuery) return { items: [], next: null };

    const predicates = [membership.predicate];
    const bindings: Array<string | number> = [...membership.bindings];
    if (unreadOnly) {
      predicates.push(`exists (
        select 1
        from emails unread_message
        where unread_message.conversation_id = c.id
          and unread_message.direction = 'incoming'
          and not exists (
            select 1
            from email_read_states unread_state
            where unread_state.user_id = ?
              and unread_state.email_id = unread_message.id
          )
      )`);
      bindings.push(userId);
    }
    if (searchQuery) {
      // Folder membership belongs to the conversation, while a match can be in
      // any message in that conversation.
      predicates.push(`c.id in (
        select conversation_id
        from email_search
        where email_search match ?
      )`);
      bindings.push(searchQuery);
    }
    if (cursor) {
      predicates.push(
        "(c.timeline_at < ? or (c.timeline_at = ? and c.latest_email_id < ?))",
      );
      bindings.push(cursor.timelineAt, cursor.timelineAt, cursor.emailId);
    }
    bindings.push(limit + 1);

    const rows = this.state.storage.sql.exec<ConversationRow>(`
      select
        c.latest_email_id as email_id,
        c.timeline_at,
        c.has_incoming,
        (
          select count(*)
          from emails message
          where message.conversation_id = c.id
        ) as message_count,
        (
          select count(*)
          from emails message
          where message.conversation_id = c.id
            and message.direction = 'incoming'
            and not exists (
              select 1
              from email_read_states read_state
              where read_state.user_id = ?
                and read_state.email_id = message.id
            )
        ) as unread_count
      from conversations c
      where ${predicates.join(" and ")}
      order by c.timeline_at desc, c.latest_email_id desc
      limit ?
    `, userId, ...bindings).toArray();

    const pageRows = rows.slice(0, limit);
    const emailIds = pageRows.map((row) => row.email_id);
    const emailRows = emailIds.length
      ? this.db.select().from(emails).where(inArray(emails.id, emailIds)).all()
      : [];
    const emailsById = new Map(emailRows.map((email) => [email.id, email]));
    const items = pageRows.flatMap((row): ConversationListItem[] => {
      const email = emailsById.get(row.email_id);
      return email
        ? [{
            email,
            messageCount: Number(row.message_count),
            unreadCount: Number(row.unread_count),
            hasIncoming: Boolean(row.has_incoming),
          }]
        : [];
    });
    const last = pageRows.at(-1);
    return {
      items,
      next: rows.length > limit && last
        ? { timelineAt: Number(last.timeline_at), emailId: last.email_id }
        : null,
    };
  }

  listDrafts(userId: string) {
    return this.db
      .select()
      .from(drafts)
      .where(eq(drafts.userId, userId))
      .orderBy(desc(drafts.updatedAt))
      .all();
  }

  getDraft(userId: string, id: string): Draft | null {
    return this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
      .all()[0] ?? null;
  }

  /** Optimistic concurrency: a write must name the version it was based on (0 for a new draft). */
  saveDraft(userId: string, input: DraftInput, expectedVersion: number): SaveDraftResult {
    const result = this.db.transaction((tx): SaveDraftResult => {
      const existing = tx.select().from(drafts).where(eq(drafts.id, input.id)).all()[0];
      if (existing && existing.userId !== userId) return { status: "conflict", draft: null };
      if ((existing?.version ?? 0) !== expectedVersion) {
        return { status: "conflict", draft: existing ?? null };
      }
      if (!existing) {
        const [{ count }] = tx
          .select({ count: sql<number>`count(*)` })
          .from(drafts)
          .where(eq(drafts.userId, userId))
          .all() as [{ count: number }];
        if (count >= MAX_DRAFTS_PER_USER) return { status: "limit" };
      }
      const draft: Draft = {
        ...input,
        userId,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      };
      tx.insert(drafts)
        .values(draft)
        .onConflictDoUpdate({ target: drafts.id, set: draft })
        .run();
      return { status: "saved", draft };
    });
    if (result.status === "saved") this.publishUpdate();
    return result;
  }

  deleteDraft(userId: string, id: string): Draft | null {
    const deleted = this.db
      .delete(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
      .returning()
      .all()[0] ?? null;
    if (deleted) this.publishUpdate();
    return deleted;
  }

  getAutoReply(): AutoReplySettings | null {
    return this.db.select().from(autoReplySettings).all()[0] ?? null;
  }

  autoReplyState() {
    return autoReplyStatus(this.getAutoReply(), new Date());
  }

  setAutoReply(input: AutoReplyInput, userId: string) {
    const previous = this.getAutoReply();
    const settings: AutoReplySettings = {
      ...input,
      id: 1,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    // Each absence starts fresh: switching on or moving the window clears
    // who has already been answered.
    const newAbsence = input.enabled && (
      !previous?.enabled
      || previous.startsAt?.getTime() !== input.startsAt?.getTime()
      || previous.endsAt?.getTime() !== input.endsAt?.getTime()
    );
    this.db.transaction((tx) => {
      tx.insert(autoReplySettings)
        .values(settings)
        .onConflictDoUpdate({ target: autoReplySettings.id, set: settings })
        .run();
      if (newAbsence) tx.delete(autoReplyLog).run();
    });
    this.publishUpdate();
    return settings;
  }

  recentAutoReplies(limit = 20) {
    return this.db
      .select()
      .from(autoReplyLog)
      .orderBy(desc(autoReplyLog.lastRepliedAt))
      .limit(limit)
      .all();
  }

  private hasSentTo(address: string) {
    const needle = `"address":${JSON.stringify(address.toLowerCase())}`;
    return this.db
      .select({ id: emails.id })
      .from(emails)
      .where(and(
        eq(emails.direction, "outgoing"),
        or(
          sql`instr(lower(${emails.toJson}), ${needle}) > 0`,
          sql`instr(lower(${emails.ccJson}), ${needle}) > 0`,
          sql`instr(lower(${emails.bccJson}), ${needle}) > 0`,
        ),
      ))
      .limit(1)
      .all().length > 0;
  }

  /**
   * Out-of-office reply for a live delivery (never imports). It is sent
   * through Email Sending but not stored as a message, and it never retries:
   * a sender is logged before sending so a failure cannot cause a loop.
   */
  private async maybeAutoReply(job: PendingInbound, email: Email, rawMime: ArrayBuffer) {
    const settings = this.getAutoReply();
    const now = new Date();
    if (!settings || autoReplyStatus(settings, now) !== "active") return;
    const skip = (reason: string) => {
      console.debug(`Auto-reply skipped for ${email.id}: ${reason}`);
    };
    const conversation = this.db
      .select({ mailboxState: conversations.mailboxState })
      .from(conversations)
      .where(eq(conversations.id, email.conversationId))
      .all()[0];
    if (conversation?.mailboxState === "spam") return skip("spam");

    const mailboxAddress = normalizeMailboxAddress(job.envelopeTo);
    const reason = messageSkipReason({
      headers: parseHeaderBlock(rawMime),
      envelopeFrom: job.envelopeFrom,
      mailboxAddress,
      email,
    });
    if (reason) return skip(reason);
    const recipient = autoReplyRecipient(job.envelopeFrom);

    const db = createDb(this.bindings.DB);
    if (settings.skipInternal) {
      const [internal] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .innerJoin(domains, mailboxAddressPredicate(recipient))
        .limit(1);
      if (internal) return skip("internal sender");
    }
    if (settings.audience === "knownSenders" && !this.hasSentTo(recipient)) {
      return skip("unknown sender");
    }

    const intervalMs = settings.replyIntervalDays * DAY_MS;
    const reserved = this.db.transaction((tx) => {
      tx.delete(autoReplyLog)
        .where(lt(autoReplyLog.lastRepliedAt, new Date(now.getTime() - intervalMs)))
        .run();
      const previous = tx
        .select()
        .from(autoReplyLog)
        .where(eq(autoReplyLog.senderAddress, recipient))
        .all()[0];
      if (previous) return "interval";
      const [{ count }] = tx
        .select({ count: sql<number>`count(*)` })
        .from(autoReplyLog)
        .where(lt(sql`${now.getTime() - 60 * 60 * 1_000}`, autoReplyLog.lastRepliedAt))
        .all() as [{ count: number }];
      if (count >= AUTO_REPLY_HOURLY_CAP) return "hourly cap";
      tx.insert(autoReplyLog).values({
        senderAddress: recipient,
        lastRepliedAt: now,
        lastOriginalEmailId: email.id,
        lastOutboundMessageId: null,
      }).run();
      return null;
    });
    if (reserved) return skip(reserved);

    const [mailbox] = await db
      .select({ displayName: mailboxes.displayName })
      .from(mailboxes)
      .where(eq(mailboxes.id, this.state.id.name ?? ""))
      .limit(1);
    try {
      const result = await this.bindings.EMAIL.send(buildAutoReply({
        mailboxAddress,
        mailboxName: mailbox?.displayName ?? "",
        recipient,
        original: email,
        subject: settings.subject,
        bodyText: settings.bodyText,
      }));
      this.db.update(autoReplyLog)
        .set({ lastOutboundMessageId: result.messageId })
        .where(eq(autoReplyLog.senderAddress, recipient))
        .run();
    } catch (error) {
      console.error(`Auto-reply to ${recipient} failed`, error);
    }
  }

  listRules(): MailRuleView[] {
    return this.db.select().from(mailRules).orderBy(asc(mailRules.position)).all().map(ruleView);
  }

  private ruleFolderError(input: RuleInput) {
    for (const action of input.actions) {
      if (action.type === "moveToFolder" && this.getFolder(action.folderId)?.kind !== "custom") {
        return "Move to folder needs an existing custom folder";
      }
    }
    return null;
  }

  createRule(input: RuleInput, userId: string) {
    const error = this.ruleFolderError(input);
    if (error) return { status: "invalid" as const, error };
    const existing = this.db.select({ position: mailRules.position }).from(mailRules).all();
    if (existing.length >= MAX_RULES) return { status: "limit" as const };
    const rule: MailRule = {
      id: createId("rule"),
      position: Math.max(0, ...existing.map((row) => row.position)) + 1,
      name: input.name,
      enabled: input.enabled,
      match: input.match,
      conditionsJson: input.conditions,
      actionsJson: input.actions,
      stopProcessing: input.stopProcessing,
      createdBy: userId,
      updatedAt: new Date(),
    };
    this.db.insert(mailRules).values(rule).run();
    this.publishUpdate();
    return { status: "ok" as const, rule: ruleView(rule) };
  }

  updateRule(id: string, input: RuleInput) {
    const error = this.ruleFolderError(input);
    if (error) return { status: "invalid" as const, error };
    const [updated] = this.db.update(mailRules)
      .set({
        name: input.name,
        enabled: input.enabled,
        match: input.match,
        conditionsJson: input.conditions,
        actionsJson: input.actions,
        stopProcessing: input.stopProcessing,
        updatedAt: new Date(),
      })
      .where(eq(mailRules.id, id))
      .returning()
      .all();
    if (!updated) return { status: "not_found" as const };
    this.publishUpdate();
    return { status: "ok" as const, rule: ruleView(updated) };
  }

  deleteRule(id: string) {
    const deleted = this.db.delete(mailRules).where(eq(mailRules.id, id)).returning({ id: mailRules.id }).all();
    if (deleted.length) this.publishUpdate();
    return deleted.length > 0;
  }

  reorderRules(ruleIds: string[]) {
    const current = this.db.select({ id: mailRules.id }).from(mailRules).all().map((row) => row.id);
    if (current.length !== ruleIds.length || !current.every((id) => ruleIds.includes(id))) return false;
    this.db.transaction((tx) => {
      ruleIds.forEach((id, index) => {
        tx.update(mailRules).set({ position: index + 1 }).where(eq(mailRules.id, id)).run();
      });
    });
    this.publishUpdate();
    return true;
  }

  /** How many of the latest messages a rule would match, without changing anything. */
  testRule(rule: Pick<RuleInput, "match" | "conditions">) {
    const recent = this.db
      .select()
      .from(emails)
      .where(eq(emails.direction, "incoming"))
      .orderBy(desc(emails.timelineAt))
      .limit(RULE_TEST_SCAN)
      .all();
    const matches = recent.filter((email) => ruleMatches(rule, email));
    return {
      scanned: recent.length,
      matches: matches.length,
      sample: matches.slice(0, 5).map((email) => ({
        id: email.id,
        conversationId: email.conversationId,
        subject: email.subject,
        from: email.fromJson[0]?.address ?? null,
        timelineAt: email.timelineAt,
      })),
    };
  }

  /**
   * Applies the mailbox's rules to a live delivery, after AI classification
   * and before notifications. Forwarding runs afterwards in waitUntil.
   */
  private async applyRules(job: PendingInbound, email: Email, rawMime: ArrayBuffer) {
    const rules = this.listRules().filter((rule) => rule.enabled);
    if (!rules.length) return;
    const conversation = this.db
      .select({ mailboxState: conversations.mailboxState })
      .from(conversations)
      .where(eq(conversations.id, email.conversationId))
      .all()[0];
    if (!conversation) return;
    const outcome = evaluateRules(rules, email, conversation.mailboxState);
    if (!outcome.matchedRuleIds.length) return;

    const folderId = outcome.folderId && this.getFolder(outcome.folderId)?.kind === "custom"
      ? outcome.folderId
      : null;
    if (outcome.mailboxState) {
      this.db.update(conversations)
        .set({
          mailboxState: outcome.mailboxState,
          folderId: outcome.mailboxState === "active" ? folderId : null,
        })
        .where(eq(conversations.id, email.conversationId))
        .run();
    }
    const db = createDb(this.bindings.DB);
    const mailboxId = this.state.id.name ?? "";
    if (outcome.markRead) {
      const members = await db
        .select({ userId: mailboxMembers.userId })
        .from(mailboxMembers)
        .where(eq(mailboxMembers.mailboxId, mailboxId));
      if (members.length) {
        this.db.insert(emailReadStates)
          .values(members.map((member) => ({ userId: member.userId, emailId: email.id, readAt: new Date() })))
          .onConflictDoNothing()
          .run();
      }
    }

    const finalState = outcome.mailboxState ?? conversation.mailboxState;
    const hops = forwardHops(headerBlock(rawMime));
    const sender = normalizeMailboxAddress(job.envelopeFrom || email.fromJson[0]?.address || "");
    const forwards = outcome.forwards.filter((forward) =>
      finalState !== "spam"
      && hops < MAX_FORWARD_HOPS
      && normalizeMailboxAddress(forward.to) !== sender
    );
    if (!forwards.length) return;
    const [mailbox] = await db
      .select({ displayName: mailboxes.displayName })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1);
    this.state.waitUntil(this.sendRuleForwards(email, forwards, {
      mailboxAddress: normalizeMailboxAddress(job.envelopeTo),
      mailboxName: mailbox?.displayName ?? "",
      hops,
    }));
  }

  private async sendRuleForwards(
    email: Email,
    forwards: Array<{ to: string; keepCopy: boolean }>,
    input: { mailboxAddress: string; mailboxName: string; hops: number },
  ) {
    let allSent = true;
    for (const forward of forwards) {
      try {
        await this.bindings.EMAIL.send(await buildRuleForward(this.bindings, {
          email,
          ...input,
          to: forward.to,
        }));
      } catch (error) {
        allSent = false;
        console.error(`Rule forward of ${email.id} to ${forward.to} failed`, error);
      }
    }
    // "Forward only" discards the copy only once every forward was accepted.
    if (allSent && forwards.every((forward) => !forward.keepCopy)) {
      this.db.update(conversations)
        .set({ mailboxState: "trash", folderId: null })
        .where(eq(conversations.id, email.conversationId))
        .run();
      this.publishUpdate();
    }
  }

  getFolder(id: string): MailFolder | null {
    const system = systemFolderDefinitions.find((folder) => folder.id === id);
    if (system) {
      return {
        ...system,
        kind: "system",
      };
    }
    const custom = this.db
      .select()
      .from(folders)
      .where(eq(folders.id, id))
      .all()[0];
    return custom ? { ...custom, kind: "custom", systemType: null } : null;
  }

  private folderNameTaken(name: string, excludingId?: string) {
    const normalized = name.toLocaleLowerCase("en-US");
    return systemFolderDefinitions.some(
      (folder) => folder.name.toLocaleLowerCase("en-US") === normalized,
    ) || this.db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .all()
      .some((folder) =>
        folder.id !== excludingId
        && folder.name.toLocaleLowerCase("en-US") === normalized
      );
  }

  createFolder(id: string, name: string) {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) {
      return { status: "invalid" as const };
    }
    const existing = this.db
      .select({ id: folders.id, sortOrder: folders.sortOrder })
      .from(folders)
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .all();
    if (existing.length >= MAX_CUSTOM_FOLDER_COUNT) {
      return { status: "limit" as const };
    }
    if (this.folderNameTaken(normalizedName)) {
      return { status: "conflict" as const };
    }
    const folder = this.db.transaction((tx) => {
      const inserted = tx
        .insert(folders)
        .values({ id, name: normalizedName, sortOrder: 100 + existing.length })
        .returning()
        .all()[0]!;
      [...existing.map((item) => item.id), id].forEach((folderId, index) => {
        tx.update(folders)
          .set({ sortOrder: 100 + index })
          .where(eq(folders.id, folderId))
          .run();
      });
      return inserted;
    });
    this.publishUpdate();
    return { status: "ok" as const, folder };
  }

  renameFolder(id: string, name: string) {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) {
      return { status: "invalid" as const };
    }
    if (!this.getFolder(id) || systemFolderDefinitions.some((item) => item.id === id)) {
      return { status: "not_found" as const };
    }
    if (this.folderNameTaken(normalizedName, id)) {
      return { status: "conflict" as const };
    }
    const folder = this.db
      .update(folders)
      .set({ name: normalizedName })
      .where(eq(folders.id, id))
      .returning()
      .all()[0]!;
    this.publishUpdate();
    return { status: "ok" as const, folder };
  }

  deleteFolder(id: string) {
    const deleted = this.db
      .delete(folders)
      .where(eq(folders.id, id))
      .returning({ id: folders.id })
      .all()[0];
    if (!deleted) return { status: "not_found" as const };
    this.publishUpdate();
    return { status: "ok" as const };
  }

  reorderFolders(folderIds: string[]) {
    const existingIds = this.db
      .select({ id: folders.id })
      .from(folders)
      .all()
      .map((folder) => folder.id);
    if (
      folderIds.length !== existingIds.length
      || new Set(folderIds).size !== folderIds.length
      || existingIds.some((id) => !folderIds.includes(id))
    ) {
      return { status: "conflict" as const };
    }
    this.db.transaction((tx) => {
      folderIds.forEach((id, index) => {
        tx.update(folders)
          .set({ sortOrder: 100 + index })
          .where(eq(folders.id, id))
          .run();
      });
    });
    this.publishUpdate();
    return { status: "ok" as const };
  }

  private aiConfiguration(): MailboxAiConfiguration {
    const stored = this.db
      .select()
      .from(mailboxAiConfiguration)
      .where(eq(mailboxAiConfiguration.id, AI_CONFIGURATION_ID))
      .all()[0];
    return stored
      ? {
          instructions: stored.instructions,
          confidenceThreshold: stored.confidenceThreshold,
        }
      : {
          instructions: "",
          confidenceThreshold: 75,
        };
  }

  async getMailboxAiSettings() {
    return {
      configuration: this.aiConfiguration(),
      globalEnabled: await globalAiProcessingEnabled(this.bindings.DB),
    };
  }

  async setMailboxAiConfiguration(configuration: MailboxAiConfiguration) {
    if (
      configuration.confidenceThreshold < 50
      || configuration.confidenceThreshold > 100
      || configuration.instructions.length > 4_000
    ) {
      throw new Error("Invalid mailbox AI configuration");
    }
    this.db
      .insert(mailboxAiConfiguration)
      .values({
        id: AI_CONFIGURATION_ID,
        instructions: configuration.instructions.trim(),
        confidenceThreshold: configuration.confidenceThreshold,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: mailboxAiConfiguration.id,
        set: {
          instructions: configuration.instructions.trim(),
          confidenceThreshold: configuration.confidenceThreshold,
          updatedAt: new Date(),
        },
      })
      .run();
    return this.getMailboxAiSettings();
  }

  getEmail(id: string) {
    return this.db.select().from(emails).where(eq(emails.id, id)).all()[0] ?? null;
  }

  /** Stable id-ordered page of messages with their folder placement, for backups. */
  listBackupEmails(afterId: string | null, limit: number) {
    return this.db
      .select({
        email: emails,
        mailboxState: conversations.mailboxState,
        folderName: folders.name,
        seen: sql<number>`exists (
          select 1 from ${emailReadStates}
          where ${emailReadStates.emailId} = ${emails.id}
        )`.mapWith(Boolean),
      })
      .from(emails)
      .innerJoin(conversations, eq(conversations.id, emails.conversationId))
      .leftJoin(folders, eq(folders.id, conversations.folderId))
      .where(afterId ? gt(emails.id, afterId) : undefined)
      .orderBy(asc(emails.id))
      .limit(limit)
      .all();
  }

  getEmailByMessageId(messageIdHeader: string) {
    return this.db
      .select()
      .from(emails)
      .where(eq(emails.messageIdHeader, messageIdHeader))
      .orderBy(desc(emails.timelineAt))
      .all()[0] ?? null;
  }

  getConversation(conversationId: string) {
    return this.db
      .select()
      .from(emails)
      .where(eq(emails.conversationId, conversationId))
      .orderBy(asc(emails.timelineAt), asc(emails.id))
      .all();
  }

  getConversationSnapshot(conversationId: string) {
    const conversation = this.db
      .select({
        mailboxState: conversations.mailboxState,
        folderId: conversations.folderId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .all()[0];
    if (!conversation) return null;
    return {
      mailboxState: conversation.mailboxState,
      folderId: conversation.folderId,
      messages: this.getConversation(conversationId),
      readStates: this.db
        .select({
          emailId: emailReadStates.emailId,
          userId: emailReadStates.userId,
          readAt: emailReadStates.readAt,
        })
        .from(emailReadStates)
        .innerJoin(emails, eq(emailReadStates.emailId, emails.id))
        .where(eq(emails.conversationId, conversationId))
        .orderBy(asc(emailReadStates.readAt))
        .all(),
    };
  }

  getConversationPageSnapshot(
    conversationId: string,
    userId: string,
    limit: number,
    cursor: ConversationCursorPosition | null,
  ) {
    const conversation = this.db
      .select({
        mailboxState: conversations.mailboxState,
        folderId: conversations.folderId,
        hasIncoming: conversations.hasIncoming,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .all()[0];
    if (!conversation) return null;

    const pageLimit = Math.max(1, Math.min(limit, 25));
    const cursorDate = cursor ? new Date(cursor.timelineAt) : null;
    const predicate = cursor && cursorDate
      ? and(
          eq(emails.conversationId, conversationId),
          or(
            lt(emails.timelineAt, cursorDate),
            and(
              eq(emails.timelineAt, cursorDate),
              lt(emails.id, cursor.emailId),
            ),
          ),
        )
      : eq(emails.conversationId, conversationId);
    const descending = this.db
      .select()
      .from(emails)
      .where(predicate)
      .orderBy(desc(emails.timelineAt), desc(emails.id))
      .limit(pageLimit + 1)
      .all();
    const page = descending.slice(0, pageLimit);
    const oldest = page.at(-1);
    const messageIds = page.map((email) => email.id);
    const counts = this.state.storage.sql.exec<ConversationSnapshotCountRow>(`
      select
        count(*) as message_count,
        coalesce(sum(
          case
            when message.direction = 'incoming' and not exists (
              select 1
              from email_read_states read_state
              where read_state.user_id = ?
                and read_state.email_id = message.id
            ) then 1
            else 0
          end
        ), 0) as unread_count
      from emails message
      where message.conversation_id = ?
    `, userId, conversationId).one();
    return {
      mailboxState: conversation.mailboxState,
      folderId: conversation.folderId,
      hasIncoming: conversation.hasIncoming,
      messageCount: Number(counts.message_count),
      unreadCount: Number(counts.unread_count),
      messages: page.reverse(),
      next: descending.length > pageLimit && oldest
        ? { timelineAt: oldest.timelineAt.getTime(), emailId: oldest.id }
        : null,
      readStates: messageIds.length
        ? this.db
          .select({
            emailId: emailReadStates.emailId,
            userId: emailReadStates.userId,
            readAt: emailReadStates.readAt,
          })
          .from(emailReadStates)
          .where(inArray(emailReadStates.emailId, messageIds))
          .orderBy(asc(emailReadStates.readAt))
          .all()
        : [],
    };
  }

  getAttachment(emailId: string, attachmentId: string) {
    const email = this.getEmail(emailId);
    return email?.attachmentsJson.find((file) => file.id === attachmentId) ?? null;
  }

  private spamThresholds(): SpamThresholds {
    const stored = this.db
      .select()
      .from(spamFilterSettings)
      .where(eq(spamFilterSettings.id, SPAM_SETTINGS_ID))
      .all()[0];
    return {
      spamThreshold: stored?.spamThreshold ?? DEFAULT_SPAM_THRESHOLD,
      suspiciousThreshold: stored?.suspiciousThreshold ?? DEFAULT_SUSPICIOUS_THRESHOLD,
    };
  }

  getSpamSettings(): SpamSettings {
    const rules = this.db
      .select()
      .from(spamSenderRules)
      .orderBy(asc(spamSenderRules.entry))
      .all();
    return {
      ...this.spamThresholds(),
      allow: rules.filter((rule) => rule.list === "allow").map((rule) => rule.entry),
      block: rules.filter((rule) => rule.list === "block").map((rule) => rule.entry),
    };
  }

  /** Replaces thresholds and both lists. Entries arrive normalized by the API. */
  setSpamSettings(settings: SpamSettings) {
    const allow = [...new Set(settings.allow)];
    const block = [...new Set(settings.block)].filter((entry) => !allow.includes(entry));
    if (
      settings.suspiciousThreshold < 1
      || settings.spamThreshold > 100
      || settings.suspiciousThreshold >= settings.spamThreshold
      || allow.length + block.length > MAX_SPAM_SENDER_RULES
    ) {
      throw new Error("Invalid spam filter settings");
    }
    const now = new Date();
    this.db.transaction((tx) => {
      const thresholds = {
        spamThreshold: settings.spamThreshold,
        suspiciousThreshold: settings.suspiciousThreshold,
        updatedAt: now,
      };
      tx.insert(spamFilterSettings)
        .values({ id: SPAM_SETTINGS_ID, ...thresholds })
        .onConflictDoUpdate({ target: spamFilterSettings.id, set: thresholds })
        .run();
      tx.delete(spamSenderRules).run();
      for (const [list, entries] of [["allow", allow], ["block", block]] as const) {
        for (const entry of entries) {
          tx.insert(spamSenderRules).values({ entry, list, createdAt: now }).run();
        }
      }
    });
    return this.getSpamSettings();
  }

  /** Adds an entry, moving it if it is already on the other list. */
  setSpamSender(entry: string, list: SpamSenderList) {
    const added = this.db.transaction((tx) => {
      const existing = tx
        .select({ entry: spamSenderRules.entry })
        .from(spamSenderRules)
        .where(eq(spamSenderRules.entry, entry))
        .all()[0];
      if (!existing) {
        const count = tx.select({ count: sql<number>`count(*)` }).from(spamSenderRules).all()[0]?.count ?? 0;
        if (count >= MAX_SPAM_SENDER_RULES) return false;
      }
      tx.insert(spamSenderRules)
        .values({ entry, list, createdAt: new Date() })
        .onConflictDoUpdate({ target: spamSenderRules.entry, set: { list } })
        .run();
      return true;
    });
    return added ? { status: "ok" as const, settings: this.getSpamSettings() } : { status: "limit" as const };
  }

  removeSpamSender(entry: string) {
    const removed = this.db
      .delete(spamSenderRules)
      .where(eq(spamSenderRules.entry, entry))
      .returning({ entry: spamSenderRules.entry })
      .all().length > 0;
    return removed ? this.getSpamSettings() : null;
  }

  private senderSpamList(sender: string) {
    const rules = this.db
      .select({ list: spamSenderRules.list })
      .from(spamSenderRules)
      .where(inArray(spamSenderRules.entry, spamSenderCandidates(sender)))
      .all();
    return matchSenderList(rules.map((rule) => rule.list));
  }

  private senderRelationship(sender: string) {
    const address = sender.toLowerCase();
    const domain = address.slice(address.lastIndexOf("@") + 1);
    // ponytail: scans every outgoing recipient per delivery; add an indexed
    // correspondents table if very large mailboxes make this slow.
    const row = this.state.storage.sql.exec<{
      known_address: number | null;
      known_domain: number;
    }>(`
      select max(address = ?) as known_address, count(*) as known_domain
      from (
        select lower(json_extract(recipient.value, '$.address')) as address
        from emails, json_each(emails.to_json) recipient
        where emails.direction = 'outgoing'
        union all
        select lower(json_extract(recipient.value, '$.address'))
        from emails, json_each(emails.cc_json) recipient
        where emails.direction = 'outgoing'
        union all
        select lower(json_extract(recipient.value, '$.address'))
        from emails, json_each(emails.bcc_json) recipient
        where emails.direction = 'outgoing'
      )
      where substr(address, instr(address, '@') + 1) = ?
    `, address, domain).one();
    return {
      address: Boolean(row.known_address),
      domain: row.known_domain > 0,
    };
  }

  private spamTrainingTotals() {
    const row = this.state.storage.sql.exec<{ spam: number; ham: number }>(`
      select
        coalesce(sum(label = 'spam'), 0) as spam,
        coalesce(sum(label = 'ham'), 0) as ham
      from spam_training
    `).one();
    return { spam: row.spam, ham: row.ham };
  }

  getSpamLearning() {
    const totals = this.spamTrainingTotals();
    const tokens = this.state.storage.sql
      .exec<{ count: number }>("select count(*) as count from spam_tokens")
      .one().count;
    return {
      spamMessages: totals.spam,
      hamMessages: totals.ham,
      tokens,
      minimum: SPAM_LEARNING_MINIMUM,
      active: totals.spam >= SPAM_LEARNING_MINIMUM && totals.ham >= SPAM_LEARNING_MINIMUM,
    };
  }

  resetSpamLearning() {
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec("delete from spam_tokens");
      this.state.storage.sql.exec("delete from spam_training");
    });
    return this.getSpamLearning();
  }

  private learnedProbability(tokens: string[]) {
    const totals = this.spamTrainingTotals();
    if (totals.spam < SPAM_LEARNING_MINIMUM || totals.ham < SPAM_LEARNING_MINIMUM) {
      return null;
    }
    const rows = this.state.storage.sql.exec<{ spam_count: number; ham_count: number }>(`
      select spam_count, ham_count from spam_tokens
      where token in (select cast(value as text) from json_each(?))
    `, JSON.stringify(tokens)).toArray();
    return learnedSpamProbability(
      rows.map((row) => ({ spamCount: row.spam_count, hamCount: row.ham_count })),
      totals,
    );
  }

  /**
   * Trains the incoming messages of conversations a member moved into or out
   * of Spam. A message already trained the same way is skipped; one trained
   * the other way has its earlier counts subtracted first.
   */
  private trainSpamConversations(conversationIds: string[], label: SpamLabel) {
    if (!conversationIds.length) return;
    const sql = this.state.storage.sql;
    const now = Date.now();
    const column = label === "spam" ? "spam_count" : "ham_count";
    this.state.storage.transactionSync(() => {
      const messages = sql.exec<{
        id: string;
        subject: string;
        body_text: string | null;
        from_json: string;
        label: SpamLabel | null;
        tokens_json: string | null;
      }>(`
        select e.id, e.subject, e.body_text, e.from_json, t.label, t.tokens_json
        from emails e
        left join spam_training t on t.email_id = e.id
        where e.direction = 'incoming'
          and e.conversation_id in (select cast(value as text) from json_each(?))
      `, stringListJson(conversationIds)).toArray();
      for (const message of messages) {
        if (message.label === label) continue;
        let tokensJson = message.tokens_json;
        if (message.label && tokensJson) {
          const previous = message.label === "spam" ? "spam_count" : "ham_count";
          sql.exec(`
            update spam_tokens set ${previous} = max(0, ${previous} - 1)
            where token in (select cast(value as text) from json_each(?))
          `, tokensJson);
        } else {
          const from = (JSON.parse(message.from_json) as Array<{ address: string }>)[0];
          tokensJson = JSON.stringify(messageSpamTokens({
            subject: message.subject,
            bodyText: message.body_text,
            from: from?.address ?? "",
          }));
        }
        sql.exec(`
          insert into spam_tokens (token, ${column}, updated_at)
          select cast(value as text), 1, ? from json_each(?) where true
          on conflict (token) do update
            set ${column} = ${column} + 1, updated_at = excluded.updated_at
        `, now, tokensJson);
        sql.exec(`
          insert into spam_training (email_id, label, tokens_json, trained_at)
          values (?, ?, ?, ?)
          on conflict (email_id) do update
            set label = excluded.label, trained_at = excluded.trained_at
        `, message.id, label, tokensJson, now);
      }
      sql.exec("delete from spam_tokens where spam_count = 0 and ham_count = 0");
      this.pruneSpamTokens();
    });
  }

  /** Keeps the token table bounded by dropping least-used, then oldest, rows. */
  private pruneSpamTokens(limit = MAX_SPAM_TOKENS, pruneTo = SPAM_TOKENS_PRUNE_TO) {
    const sql = this.state.storage.sql;
    const count = sql.exec<{ count: number }>("select count(*) as count from spam_tokens").one().count;
    if (count <= limit) return;
    sql.exec(`
      delete from spam_tokens where token in (
        select token from spam_tokens
        order by spam_count + ham_count, updated_at
        limit ?
      )
    `, count - pruneTo);
  }

  private assessInboundSpam(
    rawMime: ArrayBuffer,
    prepared: PreparedInboundEmail,
  ): SpamAssessment {
    const { email } = prepared;
    const from = email.fromJson[0] ?? { address: "", name: null };
    return assessSpam({
      learnedProbability: this.learnedProbability(messageSpamTokens({
        subject: email.subject ?? "",
        bodyText: email.bodyText ?? null,
        from: from.address,
      })),
      authentication: parseAuthenticationResults(readHeaderBlock(rawMime)),
      relationship: this.senderRelationship(from.address),
      senderList: this.senderSpamList(from.address),
      from,
      recipientCount: (email.toJson?.length ?? 0) + (email.ccJson?.length ?? 0),
      html: prepared.html,
      hasTextPart: prepared.hasTextPart,
      attachments: email.attachmentsJson ?? [],
    }, this.spamThresholds());
  }

  async completeOfficePreview(emailId: string, attachmentId: string, sourceKey: string, status: "ready" | "failed") {
    const email = this.getEmail(emailId);
    const file = email?.attachmentsJson.find((file) => file.id === attachmentId && file.r2Key === sourceKey);
    if (!email || !file) {
      // Conversion may finish after permanent deletion already removed its objects.
      // Persist cleanup before the queue acknowledges, so an R2 outage cannot orphan the PDF.
      const cleanupAt = new Date();
      await this.scheduleAlarm(cleanupAt.getTime() + ALARM_WAKE_DELAY_MS);
      this.db.insert(pendingObjectDeletions).values({
        objectKey: officePreviewKey(sourceKey), nextAttemptAt: cleanupAt,
      }).onConflictDoNothing().run();
      return false;
    }
    if (file.pdfPreviewStatus !== "pending") return true;
    this.db.update(emails).set({
      attachmentsJson: email.attachmentsJson.map((attachment) =>
        attachment.id === attachmentId ? { ...attachment, pdfPreviewStatus: status } : attachment
      ),
    }).where(eq(emails.id, emailId)).run();
    this.publishUpdate();
    return true;
  }

  suggestRecipients(ownAddress: string, query: string, limit: number) {
    this.recentParticipantSources ??= this.db
      .select({
        fromJson: emails.fromJson,
        toJson: emails.toJson,
        ccJson: emails.ccJson,
        bccJson: emails.bccJson,
      })
      .from(emails)
      .orderBy(desc(emails.timelineAt), desc(emails.id))
      .limit(500)
      .all();
    return suggestParticipants(
      this.recentParticipantSources,
      ownAddress,
      query,
      limit,
    );
  }

  listFolders(userId: string): FolderListItem[] {
    const rows = this.state.storage.sql.exec<FolderListRow>(`
      with folder_rows(id, name, kind, system_type, sort_order) as (
        select
          json_extract(value, '$.id'),
          json_extract(value, '$.name'),
          'system',
          json_extract(value, '$.systemType'),
          json_extract(value, '$.sortOrder')
        from json_each(?)
        union all
        select id, name, 'custom', null, sort_order
        from folders
      ),
      conversation_unread as (
        select
          c.id,
          c.mailbox_state,
          c.folder_id,
          c.has_incoming,
          c.has_outgoing,
          coalesce(sum(case
            when message.id is not null and read_state.email_id is null then 1
            else 0
          end), 0) as unread_count
        from conversations c
        left join emails message
          on message.conversation_id = c.id
          and message.direction = 'incoming'
        left join email_read_states read_state
          on read_state.user_id = ?
          and read_state.email_id = message.id
        group by
          c.id,
          c.mailbox_state,
          c.folder_id,
          c.has_incoming,
          c.has_outgoing
      )
      select
        folder.id,
        folder.name,
        folder.kind,
        folder.system_type,
        folder.sort_order,
        count(conversation.id) as total_count,
        coalesce(sum(conversation.unread_count), 0) as unread_count
      from folder_rows folder
      left join conversation_unread conversation on
        ${FOLDER_AGGREGATE_JOIN_PREDICATE}
      group by
        folder.id,
        folder.name,
        folder.kind,
        folder.system_type,
        folder.sort_order
    `, SYSTEM_FOLDER_DEFINITIONS_JSON, userId).toArray();

    return rows.map((row): FolderListItem => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      systemType: row.system_type,
      sortOrder: Number(row.sort_order),
      totalCount: Number(row.total_count),
      unreadCount: Number(row.unread_count),
    })).sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
  }

  getFolderCounts(userId: string, folderId: string): FolderCounts | null {
    const folder = this.getFolder(folderId);
    return folder ? this.countFolder(userId, folder) : null;
  }

  private countFolder(userId: string, folder: MailFolder): FolderCounts {
    const membership = folderMembership(folder);
    const counts = this.state.storage.sql.exec<FolderCountRow>(`
      select
        count(*) as total_count,
        coalesce(sum((
          select count(*)
          from emails message
          where message.conversation_id = c.id
            and message.direction = 'incoming'
            and not exists (
              select 1
              from email_read_states read_state
              where read_state.user_id = ?
                and read_state.email_id = message.id
            )
        )), 0) as unread_count
      from conversations c
      where ${membership.predicate}
    `, userId, ...membership.bindings).one();
    return {
      totalCount: Number(counts.total_count),
      unreadCount: Number(counts.unread_count),
    };
  }

  setMessageRead(userId: string, emailId: string, isRead: boolean) {
    const email = this.getEmail(emailId);
    if (!email) return false;
    if (isRead) {
      const readAt = new Date();
      this.db
        .insert(emailReadStates)
        .values({ userId, emailId, readAt })
        .onConflictDoUpdate({
          target: [emailReadStates.userId, emailReadStates.emailId],
          set: { readAt },
        })
        .run();
    } else {
      this.db
        .delete(emailReadStates)
        .where(and(
          eq(emailReadStates.userId, userId),
          eq(emailReadStates.emailId, emailId),
        ))
        .run();
    }
    this.publishUpdate();
    return true;
  }

  bulkSetConversationRead(
    userId: string,
    conversationIds: string[],
    isRead: boolean,
  ) {
    const candidates = [...new Set(conversationIds)];
    if (!candidates.length) return 0;
    const candidatesJson = stringListJson(candidates);
    const existingIds = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(
        sql`${conversations.id} in (
          select cast(value as text) from json_each(${candidatesJson})
        )`,
        eq(conversations.hasIncoming, true),
      ))
      .all()
      .map((conversation) => conversation.id);
    if (!existingIds.length) return 0;
    const existingIdsJson = stringListJson(existingIds);

    if (isRead) {
      this.db.run(sql`
        insert into email_read_states (user_id, email_id, read_at)
        select ${userId}, id, ${Date.now()}
        from emails
        where conversation_id in (
          select cast(value as text) from json_each(${existingIdsJson})
        ) and direction = 'incoming'
        on conflict (user_id, email_id) do update set read_at = excluded.read_at
      `);
    } else {
      this.db.run(sql`
        delete from email_read_states
        where user_id = ${userId}
          and email_id in (
            select message.id
            from emails message
            where message.conversation_id in (
              select cast(value as text) from json_each(${existingIdsJson})
            )
              and message.direction = 'incoming'
              and not exists (
                select 1
                from emails newer
                where newer.conversation_id = message.conversation_id
                  and newer.direction = 'incoming'
                  and (
                    newer.timeline_at > message.timeline_at
                    or (
                      newer.timeline_at = message.timeline_at
                      and newer.id > message.id
                    )
                  )
              )
          )
      `);
    }
    this.publishUpdate();
    return existingIds.length;
  }

  async enqueueInbound(input: InboundDeliveryInput) {
    const receivedAt = new Date(input.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) {
      throw new Error("Inbound delivery has an invalid receipt time");
    }
    if (this.state.id.name && this.state.id.name !== input.mailboxId) {
      throw new Error("Inbound delivery targeted the wrong mailbox object");
    }

    const queuedAt = new Date();
    // Keep the alarm just ahead of the due time. Scheduling it for "now" can
    // wake it on the setAlarm await before the synchronous insert below runs.
    const alarmAt = queuedAt.getTime() + ALARM_WAKE_DELAY_MS;
    await this.scheduleAlarm(alarmAt);
    const messageId = inboundMessageId(input.id);
    const queued = this.db.transaction((tx) => {
      const existing = tx
        .select({ id: emails.id })
        .from(emails)
        .where(eq(emails.id, messageId))
        .all()[0];
      if (existing) return false;

      const result = tx
        .insert(pendingInbound)
        .values({
          id: input.id,
          rawObjectKey: input.rawObjectKey,
          envelopeFrom: input.envelopeFrom,
          envelopeTo: input.envelopeTo,
          receivedAt,
          nextAttemptAt: queuedAt,
        })
        .onConflictDoNothing()
        .returning({ id: pendingInbound.id })
        .all();
      return result.length > 0;
    });
    return { messageId, queued };
  }

  async insertEmail(email: NewEmail) {
    email = prepareOfficePreviews(email);
    if (hasPendingOfficePreviews(email)) await this.scheduleAlarm(Date.now() + ALARM_WAKE_DELAY_MS);
    this.db.transaction((tx) => {
      const inserted = tx.insert(emails).values(email).onConflictDoNothing().returning({ id: emails.id }).all();
      if (inserted.length) insertOfficePreviewJobs(this.state.storage.sql, email);
    });
    this.recentParticipantSources = null;
    return this.getEmail(email.id);
  }

  /**
   * Stores a historical message without the live-delivery side effects: no AI
   * classification, webhook, push notification, Office preview job, and never
   * the outbound send path.
   */
  async importEmail(input: MailImportInput): Promise<MailImportResult> {
    const messageId = inboundMessageId(input.deliveryId);
    if (this.getEmail(messageId)) return { status: "duplicate", messageId };

    const now = new Date();
    const job: PendingInbound = {
      id: input.deliveryId,
      rawObjectKey: input.rawObjectKey,
      envelopeFrom: "",
      envelopeTo: input.mailboxAddress,
      receivedAt: input.receivedAt === null ? now : new Date(input.receivedAt),
      attempts: 0,
      aiAttempts: 0,
      nextAttemptAt: now,
    };
    let email: NewEmail;
    try {
      ({ email } = await prepareInboundEmail({
        env: this.bindings,
        mailboxId: this.state.id.name ?? "unknown-mailbox",
        job,
        rawMime: input.raw,
        resolveParent: (inReplyTo, references) =>
          this.resolveParent(inReplyTo, references),
        preferHeaderDate: input.receivedAt === null,
      }));
    } catch (error) {
      if (!(error instanceof UnprocessableInboundEmailError)) throw error;
      return { status: "unparseable", message: error.message };
    }
    const outgoing = input.direction === "auto"
      ? email.fromJson[0]?.address.toLowerCase() === input.mailboxAddress.toLowerCase()
      : input.direction === "outgoing";
    if (outgoing) {
      email = { ...email, direction: "outgoing", transportState: "submitted" };
    }

    const folderId = input.folder ? this.importFolderId(input.folder) : null;
    if (folderId && typeof folderId !== "string") return folderId;
    const stored = this.db.transaction((tx) => {
      const previous = tx
        .select({ mailboxState: conversations.mailboxState })
        .from(conversations)
        .where(eq(conversations.id, email.conversationId))
        .all()[0];
      const inserted = tx.insert(emails).values(email)
        .onConflictDoNothing()
        .returning({ id: emails.id })
        .all();
      if (!inserted.length) return false;

      const conversation = tx
        .select({ latestEmailId: conversations.latestEmailId })
        .from(conversations)
        .where(eq(conversations.id, email.conversationId))
        .all()[0];
      // The insert trigger reactivates archived/trashed threads. The newest
      // message decides where the thread lives, regardless of import order.
      if (conversation?.latestEmailId === email.id) {
        tx.update(conversations)
          .set({
            mailboxState: input.state,
            folderId: input.state === "active" ? folderId : null,
          })
          .where(eq(conversations.id, email.conversationId))
          .run();
      } else if (previous) {
        tx.update(conversations)
          .set({ mailboxState: previous.mailboxState })
          .where(eq(conversations.id, email.conversationId))
          .run();
      }
      if (input.seen && !outgoing && input.readerUserIds.length) {
        tx.insert(emailReadStates)
          .values(input.readerUserIds.map((userId) => ({
            userId,
            emailId: email.id,
            readAt: now,
          })))
          .onConflictDoNothing()
          .run();
      }
      return true;
    });
    if (!stored) return { status: "duplicate", messageId };
    this.recentParticipantSources = null;
    this.publishUpdate();
    return { status: "imported", messageId };
  }

  private importFolderId(name: string) {
    const normalized = name.trim().toLocaleLowerCase("en-US");
    const existing = this.db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .all()
      .find((folder) => folder.name.toLocaleLowerCase("en-US") === normalized);
    if (existing) return existing.id;
    const created = this.createFolder(createId("fld"), name);
    if (created.status === "ok") return created.folder.id;
    return {
      status: "invalid_folder" as const,
      message: `Folder "${name}" could not be created (${created.status})`,
    };
  }

  private async classifyInbound(rawMime: ArrayBuffer) {
    let enabled: boolean;
    try {
      // D1 owns the account-wide switch. Reading it per delivery avoids a
      // second cached flag in every mailbox Durable Object.
      enabled = await globalAiProcessingEnabled(this.bindings.DB);
    } catch (error) {
      throw new EmailAiClassificationError(
        "Could not read the global AI processing setting",
        { cause: error },
      );
    }
    if (!enabled) return null;
    const configuration = this.aiConfiguration();
    const customFolders = this.db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .all();
    return classifyInboundEmail({
      rawMime,
      folders: customFolders,
      configuration,
      run: (request, signal) => this.bindings.AI.run(
        MAILBOX_AI_MODEL,
        request,
        {
          signal,
          tags: ["openworkspace:mail-classification"],
          extraHeaders: { "cf-aig-collect-log": "false" },
        },
      ),
    });
  }

  private insertClassifiedInboundEmail(
    email: NewEmail,
    classification: EmailAiClassification | null,
    /** Null for client imports, which are not scored. */
    spam: SpamAssessment | null,
  ) {
    email = prepareOfficePreviews(email);
    const stored = this.db.transaction((tx) => {
      const trustedFolder = classification?.folderId
        ? tx
            .select({ id: folders.id })
            .from(folders)
            .where(eq(folders.id, classification.folderId))
            .all()[0]
        : null;
      const normalizedClassification = classification?.folderId && !trustedFolder
        ? { ...classification, folderId: null }
        : classification;
      const inserted = tx
        .insert(emails)
        .values({
          ...email,
          aiClassificationJson: normalizedClassification,
          spamScore: spam?.score ?? null,
          spamVerdict: spam?.verdict ?? null,
          spamReasonsJson: spam?.reasons ?? null,
        })
        .onConflictDoNothing()
        .returning()
        .all()[0];
      if (!inserted) return null;
      insertOfficePreviewJobs(this.state.storage.sql, email);

      // The local verdict already reflects the lists. AI may add a spam
      // decision, but never for an allowed sender.
      const isSpam = spam?.verdict === "spam"
        || (spam?.senderList !== "allow" && Boolean(normalizedClassification?.spam));
      if (isSpam) {
        tx.update(conversations)
          .set({ mailboxState: "spam", folderId: null })
          .where(and(
            eq(conversations.id, email.conversationId),
            eq(conversations.mailboxState, "active"),
          ))
          .run();
      } else if (normalizedClassification?.folderId) {
        tx.update(conversations)
          .set({ folderId: normalizedClassification.folderId })
          .where(and(
            eq(conversations.id, email.conversationId),
            eq(conversations.mailboxState, "active"),
            isNull(conversations.folderId),
          ))
          .run();
      }
      return tx
        .select()
        .from(emails)
        .where(eq(emails.id, inserted.id))
        .all()[0] ?? null;
    });
    this.recentParticipantSources = null;
    return stored;
  }

  /**
   * Stores a client-imported message (JMAP Email/import) through the inbound
   * parser, without AI classification, webhooks, or push notifications. The
   * caller derives `id` from the content hash, so re-imports are deduplicated.
   * Returns null when the raw message cannot be parsed.
   */
  async importJmapEmail(input: { id: string; rawObjectKey: string; envelopeTo: string; receivedAt: number }) {
    const messageId = inboundMessageId(input.id);
    const existing = this.getEmail(messageId);
    if (existing) return { email: existing, created: false };
    const receivedAt = new Date(input.receivedAt);
    const job: PendingInbound = {
      id: input.id,
      rawObjectKey: input.rawObjectKey,
      envelopeFrom: "",
      envelopeTo: input.envelopeTo,
      receivedAt,
      attempts: 0,
      aiAttempts: 0,
      nextAttemptAt: receivedAt,
    };
    let email: NewEmail;
    try {
      ({ email } = await prepareInboundEmail({
        env: this.bindings,
        mailboxId: this.state.id.name ?? "unknown-mailbox",
        job,
        rawMime: await readInboundRawMime(this.bindings, job),
        resolveParent: (inReplyTo, references) => this.resolveParent(inReplyTo, references),
      }));
    } catch (error) {
      if (error instanceof UnprocessableInboundEmailError) return null;
      throw error;
    }
    const stored = this.insertClassifiedInboundEmail(email, null, null);
    // Office previews of imported attachments run on the alarm.
    await this.scheduleRemainingWork();
    if (!stored) return { email: this.getEmail(messageId)!, created: false };
    this.publishUpdate();
    return { email: stored, created: true };
  }

  /**
   * Hands an incoming REPLY or CANCEL to the calendars of this mailbox's
   * members; each calendar checks the sender against its stored event, so
   * the From address must have passed Cloudflare's DMARC check.
   * ponytail: best effort, a failure is logged and not retried.
   */
  private async applyCalendarResponse(email: Email, rawMime: ArrayBuffer) {
    const invitation = email.invitationJson;
    const sender = email.fromJson[0]?.address;
    if (!invitation || invitation.method === "REQUEST" || !sender) return;
    if (!cloudflareDmarcPass(rawMime, sender)) {
      console.debug(`Ignoring calendar ${invitation.method} from ${email.id}: DMARC did not pass for ${sender}`);
      return;
    }
    const mailboxId = this.state.id.name ?? "unknown-mailbox";
    try {
      const db = createDb(this.bindings.DB);
      const [mailbox] = await db
        .select({ address: mailboxAddressSql })
        .from(mailboxes)
        .innerJoin(domains, eq(domains.id, mailboxes.domainId))
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);
      const members = await db
        .select({ userId: mailboxMembers.userId })
        .from(mailboxMembers)
        .where(eq(mailboxMembers.mailboxId, mailboxId));
      for (const { userId } of members) {
        await calendarStub(this.bindings, userId).applyItip({
          method: invitation.method,
          uid: invitation.uid,
          recurrenceId: invitation.recurrenceId,
          sequence: invitation.sequence,
          sender,
          mailboxId,
          address: mailbox?.address ?? null,
          attendees: invitation.attendees,
        });
      }
    } catch (error) {
      console.error(`Could not apply calendar ${invitation.method} from ${email.id}`, error);
    }
  }

  setEmailAuthenticationResults(
    emailId: string,
    results: EmailAuthenticationResults,
  ) {
    return this.db
      .update(emails)
      .set({ authenticationResultsJson: results })
      .where(and(eq(emails.id, emailId), eq(emails.direction, "incoming")))
      .returning({ id: emails.id })
      .all().length > 0;
  }

  async submitOutgoing(email: NewEmail) {
    return this.state.blockConcurrencyWhile(async () => {
      if (email.direction !== "outgoing" || email.transportState !== "unconfirmed") {
        throw new Error("Only unconfirmed outgoing messages can be submitted");
      }
      if (!email.requestFingerprint) {
        throw new Error("An outgoing request fingerprint is required");
      }
      email = prepareOfficePreviews(email);
      if (hasPendingOfficePreviews(email)) await this.scheduleAlarm(Date.now() + ALARM_WAKE_DELAY_MS);
      const submission = this.db.transaction((tx): SubmitOutgoingResult => {
        const existing = tx
          .select()
          .from(emails)
          .where(eq(emails.id, email.id))
          .all()[0];
        if (existing) {
          const sameRequest = existing.direction === "outgoing"
            && existing.requestFingerprint === email.requestFingerprint;
          return {
            outcome: sameRequest ? "existing" : "conflict",
            email: existing,
          };
        }

        tx.insert(emails).values(email).run();
        insertOfficePreviewJobs(this.state.storage.sql, email);
        const inserted = tx
          .select()
          .from(emails)
          .where(eq(emails.id, email.id))
          .all()[0];
        if (!inserted) throw new Error("Outgoing message was not persisted");
        return { outcome: "inserted", email: inserted };
      });
      if (submission.outcome !== "inserted") return submission;
      this.recentParticipantSources = null;
      const result = {
        ...submission,
        email: await this.deliverOutgoing(submission.email.id),
      };
      this.publishUpdate();
      return result;
    });
  }

  async resendOutgoing(id: string) {
    return this.state.blockConcurrencyWhile(async () => {
      const result = this.db
        .update(emails)
        .set({
          transportState: "unconfirmed",
          messageIdHeader: null,
          transportError: null,
          deliveryStatusJson: [],
        })
        .where(and(
          eq(emails.id, id),
          eq(emails.direction, "outgoing"),
          inArray(emails.transportState, ["failed", "unconfirmed"]),
        ))
        .returning({ id: emails.id })
        .all();
      if (!result.length) return null;
      const email = await this.deliverOutgoing(id);
      this.publishUpdate();
      return email;
    });
  }

  seedMailbox(
    folderValues: NewFolder[],
    emailValues: NewEmail[],
    conversationValues: Array<{
      id: string;
      mailboxState?: MailboxState;
      folderId?: string | null;
    }> = [],
  ) {
    this.db.transaction((tx) => {
      for (const folder of folderValues) {
        tx.insert(folders).values(folder).onConflictDoNothing().run();
      }
      for (const email of emailValues) {
        tx.insert(emails).values(email).onConflictDoNothing().run();
      }
      for (const conversation of conversationValues) {
        tx.update(conversations)
          .set({
            mailboxState: conversation.mailboxState,
            folderId: conversation.folderId,
          })
          .where(eq(conversations.id, conversation.id))
          .run();
      }
    });
    this.recentParticipantSources = null;
    return { folders: folderValues.length, emails: emailValues.length };
  }

  bulkUpdateConversations(
    conversationIds: string[],
    sourceFolderId: string,
    update: ConversationUpdate,
  ) {
    const sourceFolder = this.getFolder(sourceFolderId);
    if (!sourceFolder) return null;
    if (update.folderId) {
      const targetFolder = this.getFolder(update.folderId);
      if (!targetFolder || targetFolder.kind !== "custom") return null;
    }
    const candidates = [...new Set(conversationIds)];
    if (!candidates.length) return 0;
    const assignments: string[] = [];
    const values: Array<string | null> = [];
    // A custom folder is a classification inside the active Inbox
    // distribution, so assigning one also restores the conversation.
    const mailboxState = update.folderId
      ? "active" as const
      : update.mailboxState;
    if (mailboxState !== undefined) {
      assignments.push("mailbox_state = ?");
      values.push(mailboxState);
    }
    if (update.folderId !== undefined) {
      assignments.push("folder_id = ?");
      values.push(update.folderId);
    }
    if (!assignments.length) return 0;
    const membership = folderMembership(sourceFolder);
    const candidatesJson = stringListJson(candidates);
    // Setting folderId means placing the conversation in the Inbox
    // distribution. Outgoing-only conversations must stay in Sent.
    const targetPredicate = update.folderId !== undefined
      ? "and c.has_incoming = 1"
      : "";

    const previousStates = new Map(this.state.storage.sql.exec<{
      id: string;
      mailbox_state: MailboxState;
    }>(`
      select id, mailbox_state from conversations
      where id in (select cast(value as text) from json_each(?))
    `, candidatesJson).toArray().map((row) => [row.id, row.mailbox_state]));

    // Keep the source-folder guard in the update itself so a stale shared
    // selection cannot overwrite a teammate's newer move.
    const result = this.state.storage.sql.exec<{ id: string }>(`
      update conversations as c
      set ${assignments.join(", ")}
      where c.id in (
        select cast(value as text) from json_each(?)
      )
        and ${membership.predicate}
        ${targetPredicate}
      returning id
    `, ...values, candidatesJson, ...membership.bindings).toArray();
    // Only these explicit moves train the learned filter: Report spam, and
    // Not spam back to Inbox, Archive or a folder. Moving spam to Trash does not.
    const moved = result.map((row) => row.id);
    if (mailboxState === "spam") {
      this.trainSpamConversations(
        moved.filter((id) => previousStates.get(id) !== "spam"),
        "spam",
      );
    } else if (mailboxState === "active" || mailboxState === "archive") {
      this.trainSpamConversations(
        moved.filter((id) => previousStates.get(id) === "spam"),
        "ham",
      );
    }
    if (result.length) this.publishUpdate();
    // A conversation moved into Trash or Spam may need a retention alarm.
    if (result.length && (mailboxState === "trash" || mailboxState === "spam")) {
      this.state.waitUntil(this.scheduleRemainingWork());
    }
    return result.length;
  }

  /** Deletes conversations that are all in `fromState` (Trash unless emptying Spam). */
  async permanentlyDeleteConversations(
    conversationIds: string[],
    fromState: "trash" | "spam" = "trash",
  ) {
    const candidates = [...new Set(conversationIds)];
    if (!candidates.length) {
      return { outcome: "not_found" as const, deletedCount: 0 };
    }
    const candidatesJson = stringListJson(candidates);
    const storedConversations = this.db
      .select({ id: conversations.id, mailboxState: conversations.mailboxState })
      .from(conversations)
      .where(sql`${conversations.id} in (
        select cast(value as text) from json_each(${candidatesJson})
      )`)
      .all();
    if (storedConversations.length !== candidates.length) {
      return { outcome: "not_found" as const, deletedCount: 0 };
    }
    if (storedConversations.some((conversation) => conversation.mailboxState !== fromState)) {
      return { outcome: "not_in_trash" as const, deletedCount: 0 };
    }

    const storedEmails = this.db
      .select({
        id: emails.id,
        direction: emails.direction,
        bodyHtmlR2Key: emails.bodyHtmlR2Key,
        rawMimeR2Key: emails.rawMimeR2Key,
        attachmentsJson: emails.attachmentsJson,
      })
      .from(emails)
      .where(sql`${emails.conversationId} in (
        select cast(value as text) from json_each(${candidatesJson})
      )`)
      .all();
    const incomingEmailIds = new Set(
      storedEmails.flatMap((email) =>
        email.direction === "incoming" ? [email.id] : []
      ),
    );
    const pendingInboundIds = incomingEmailIds.size
      ? this.db
        .select({ id: pendingInbound.id })
        .from(pendingInbound)
        .all()
        .flatMap((job) =>
          incomingEmailIds.has(inboundMessageId(job.id)) ? [job.id] : []
        )
      : [];
    const pendingInboundIdsJson = stringListJson(pendingInboundIds);
    const objectKeys = [...new Set(storedEmails.flatMap((email) => [
      ...(email.bodyHtmlR2Key ? [email.bodyHtmlR2Key] : []),
      ...(email.rawMimeR2Key ? [email.rawMimeR2Key] : []),
      ...email.attachmentsJson.flatMap((attachment) => [
        attachment.r2Key,
        ...(officePreviewExtension(attachment.filename) ? [officePreviewKey(attachment.r2Key)] : []),
      ]),
    ]))];

    const referencedObjectKeys = this.referencedObjectKeys(
      objectKeys,
      candidates,
    );
    const ownedObjectKeys = objectKeys.filter(
      (objectKey) => !referencedObjectKeys.has(objectKey),
    );
    const cleanupAt = new Date();
    // Schedule first so the cleanup rows committed below can never be left
    // without a retry after an interruption. The short delay prevents the
    // alarm from waking on setAlarm's await before the rows are inserted.
    const cleanupAlarmAt = cleanupAt.getTime() + ALARM_WAKE_DELAY_MS;
    if (ownedObjectKeys.length) {
      await this.scheduleAlarm(cleanupAlarmAt);
    }
    this.db.transaction((tx) => {
      tx.run(sql`
        delete from pending_office_previews where email_id in (
          select id from emails where conversation_id in (
            select cast(value as text) from json_each(${candidatesJson})
          )
        )
      `);
      for (const objectKey of ownedObjectKeys) {
        tx.insert(pendingObjectDeletions)
          .values({ objectKey, nextAttemptAt: cleanupAt })
          .onConflictDoNothing()
          .run();
      }
      if (pendingInboundIds.length) {
        tx.delete(pendingInbound)
          .where(sql`${pendingInbound.id} in (
            select cast(value as text) from json_each(${pendingInboundIdsJson})
          )`)
          .run();
      }
      tx.run(sql`
        delete from email_search where conversation_id in (
          select cast(value as text) from json_each(${candidatesJson})
        )
      `);
      tx.run(sql`
        delete from email_read_states
        where email_id in (
          select id from emails where conversation_id in (
            select cast(value as text) from json_each(${candidatesJson})
          )
        )
      `);
      tx.delete(conversations)
        .where(sql`${conversations.id} in (
          select cast(value as text) from json_each(${candidatesJson})
        )`)
        .run();
      tx.delete(emails)
        .where(sql`${emails.conversationId} in (
          select cast(value as text) from json_each(${candidatesJson})
        )`)
        .run();
    });
    this.recentParticipantSources = null;
    this.publishUpdate();
    return {
      outcome: "deleted" as const,
      deletedCount: storedConversations.length,
    };
  }

  private referencedObjectKeys(
    objectKeys: string[],
    excludedConversationIds: string[],
  ) {
    if (!objectKeys.length) return new Set<string>();
    const rows = this.state.storage.sql.exec<{ object_key: string }>(`
      with
        candidate_keys(object_key) as (
          select cast(value as text) from json_each(?)
        ),
        excluded_conversations(id) as (
          select cast(value as text) from json_each(?)
        )
      select candidate.object_key
      from candidate_keys candidate
      where exists (
        select 1
        from emails message
        where message.conversation_id not in (
          select id from excluded_conversations
        )
          and (
            message.body_html_r2_key = candidate.object_key
            or message.raw_mime_r2_key = candidate.object_key
            or exists (
              select 1
              from json_each(message.attachments_json) attachment
              where json_extract(attachment.value, '$.r2Key') = candidate.object_key
                or json_extract(attachment.value, '$.r2Key') || '.preview.pdf' = candidate.object_key
            )
          )
      )
    `, stringListJson(objectKeys), stringListJson(excludedConversationIds)).toArray();
    return new Set(rows.map((row) => row.object_key));
  }

  updateTransport(id: string, update: TransportUpdate) {
    const result = this.db
      .update(emails)
      .set({
        transportState: update.state,
        messageIdHeader: update.messageIdHeader,
        transportError: update.error,
      })
      .where(and(eq(emails.id, id), eq(emails.direction, "outgoing")))
      .returning({ id: emails.id })
      .all();
    return result.length > 0;
  }

  recordDeliveryStatus(
    messageIdHeader: string,
    status: RecipientDeliveryStatus,
  ) {
    const email = this.getEmailByMessageId(messageIdHeader);
    if (!email || email.direction !== "outgoing") return "not_found" as const;
    const existing = email.deliveryStatusJson.find(
      (item) => item.recipient === status.recipient,
    );
    if (existing?.eventId === status.eventId) return "duplicate" as const;
    if (existing && existing.eventAt > status.eventAt) return "stale" as const;

    const next = [
      ...email.deliveryStatusJson.filter(
        (item) => item.recipient !== status.recipient,
      ),
      status,
    ];
    this.db
      .update(emails)
      .set({ deliveryStatusJson: next })
      .where(eq(emails.id, email.id))
      .run();
    this.publishUpdate();
    return "updated" as const;
  }

  async alarm() {
    const now = Date.now();
    await this.processInboundJobs(now);
    await this.processRetention(now);
    await dispatchOfficePreviewJobs(this.state.storage.sql, this.bindings, this.state.id.name ?? "unknown-mailbox");
    await this.processObjectDeletionJobs(now);
    await this.scheduleRemainingWork();
  }

  private async processInboundJobs(now: number) {
    const jobs = this.db
      .select()
      .from(pendingInbound)
      .where(lte(pendingInbound.nextAttemptAt, new Date(now)))
      .orderBy(asc(pendingInbound.nextAttemptAt), asc(pendingInbound.receivedAt))
      // MIME parsing can be memory-heavy; the next due row schedules a quick
      // follow-up, so one delivery per wake keeps peak memory bounded.
      .limit(INBOUND_ALARM_BATCH_SIZE)
      .all();
    for (const job of jobs) {
      const messageId = inboundMessageId(job.id);
      const existing = this.getEmail(messageId);
      if (existing) {
        await this.finishStoredInbound(job, existing, now, false);
        continue;
      }

      try {
        const rawMime = await readInboundRawMime(this.bindings, job);
        const prepared = await prepareInboundEmail({
          env: this.bindings,
          mailboxId: this.state.id.name ?? "unknown-mailbox",
          job,
          rawMime,
          resolveParent: (inReplyTo, references) =>
            this.resolveParent(inReplyTo, references),
          parseInvitations: await calendarModuleEnabled(this.bindings.DB),
        });
        const spam = this.assessInboundSpam(rawMime, prepared);
        let classification: EmailAiClassification | null = null;
        try {
          classification = await this.classifyInbound(rawMime);
        } catch (error) {
          if (!(error instanceof EmailAiClassificationError)) throw error;
          const aiAttempts = job.aiAttempts + 1;
          if (aiAttempts < MAILBOX_AI_MAX_ATTEMPTS) {
            this.db
              .update(pendingInbound)
              .set({
                aiAttempts,
                nextAttemptAt: new Date(now + retryDelay(aiAttempts)),
              })
              .where(eq(pendingInbound.id, job.id))
              .run();
            console.error(
              `Could not classify inbound delivery ${job.id}; retrying`,
              error,
            );
            continue;
          }
          console.error(
            `Could not classify inbound delivery ${job.id}; delivering to Inbox`,
            error,
          );
        }
        const stored = this.insertClassifiedInboundEmail(
          prepared.email,
          classification,
          spam,
        );
        if (!stored) {
          throw new Error("Parsed inbound email was not persisted");
        }
        const isSpam = spam.verdict === "spam"
          || (spam.senderList !== "allow" && Boolean(classification?.spam));
        if (!isSpam) await this.applyCalendarResponse(stored, rawMime);
        try {
          await this.applyRules(job, stored, rawMime);
        } catch (error) {
          // A broken rule must never block delivery.
          console.error(`Rules failed for ${stored.id}`, error);
        }
        // Never blocks or fails inbound processing.
        this.state.waitUntil(this.maybeAutoReply(job, stored, rawMime).catch((error) => {
          console.error(`Auto-reply evaluation failed for ${stored.id}`, error);
        }));
        await this.finishStoredInbound(job, stored, now, true);
      } catch (error) {
        if (error instanceof UnprocessableInboundEmailError) {
          const fallback = prepareUnprocessableInboundEmail({
            job,
            reason: error.message,
            rawMimeR2Key: job.rawObjectKey,
          });
          const stored = await this.insertEmail(fallback);
          if (!stored) {
            throw new Error("Inbound fallback email was not persisted", {
              cause: error,
            });
          }
          await this.finishStoredInbound(job, stored, now, true);
          console.error(`Stored fallback for inbound delivery ${job.id}`, error);
          continue;
        }
        if (now - job.receivedAt.getTime() >= MAX_INBOUND_RETRY_AGE_MS) {
          const fallback = prepareUnprocessableInboundEmail({
            job,
            reason: "Message processing remained unavailable for 24 hours",
            rawMimeR2Key: error instanceof MissingRawMimeError
              ? null
              : job.rawObjectKey,
          });
          const stored = await this.insertEmail(fallback);
          if (!stored) {
            throw new Error("Inbound infrastructure fallback was not persisted", {
              cause: error,
            });
          }
          await this.finishStoredInbound(job, stored, now, true);
          console.error(
            `Stored infrastructure fallback for inbound delivery ${job.id}`,
            error,
          );
          continue;
        }
        const attempts = job.attempts + 1;
        this.db
          .update(pendingInbound)
          .set({
            attempts,
            nextAttemptAt: new Date(now + retryDelay(attempts)),
          })
          .where(eq(pendingInbound.id, job.id))
          .run();
        console.error(`Could not ingest inbound delivery ${job.id}`, error);
      }
    }
  }

  private async processObjectDeletionJobs(now: number) {
    const jobs = this.db
      .select()
      .from(pendingObjectDeletions)
      .where(lte(pendingObjectDeletions.nextAttemptAt, new Date(now)))
      .orderBy(asc(pendingObjectDeletions.nextAttemptAt))
      .limit(OBJECT_DELETION_ALARM_BATCH_SIZE)
      .all();
    if (!jobs.length) return;
    const objectKeys = jobs.map((job) => job.objectKey);
    const referencedObjectKeys = this.referencedObjectKeys(objectKeys, []);
    const retainedKeys = objectKeys.filter((key) => referencedObjectKeys.has(key));
    if (retainedKeys.length) {
      this.db
        .delete(pendingObjectDeletions)
        .where(inArray(pendingObjectDeletions.objectKey, retainedKeys))
        .run();
    }
    const deletableJobs = jobs.filter(
      (job) => !referencedObjectKeys.has(job.objectKey),
    );
    if (!deletableJobs.length) return;
    const deletableKeys = deletableJobs.map((job) => job.objectKey);
    try {
      await this.bindings.MAIL_STORAGE.delete(deletableKeys);
      this.db
        .delete(pendingObjectDeletions)
        .where(inArray(pendingObjectDeletions.objectKey, deletableKeys))
        .run();
    } catch (error) {
      for (const job of deletableJobs) {
        const attempts = job.attempts + 1;
        this.db
          .update(pendingObjectDeletions)
          .set({
            attempts,
            nextAttemptAt: new Date(now + retryDelay(attempts)),
          })
          .where(eq(pendingObjectDeletions.objectKey, job.objectKey))
          .run();
      }
      console.error("Could not delete permanent message objects", error);
    }
  }

  getRetention(): RetentionSettings | null {
    return this.db.select().from(retentionSettings).all()[0] ?? null;
  }

  async setRetention(
    input: { trashDays: number | null; spamDays: number | null },
    userId: string,
  ) {
    const settings: RetentionSettings = {
      id: 1,
      ...input,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    this.db.insert(retentionSettings)
      .values(settings)
      .onConflictDoUpdate({ target: retentionSettings.id, set: settings })
      .run();
    await this.scheduleRemainingWork();
    this.publishUpdate();
    return settings;
  }

  /** Permanently deletes one batch from Trash or Spam; callers repeat while `remaining > 0`. */
  async emptyFolder(state: "trash" | "spam") {
    const ids = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.mailboxState, state))
      .orderBy(asc(conversations.timelineAt))
      .limit(RETENTION_BATCH_SIZE)
      .all()
      .map((row) => row.id);
    const result = ids.length
      ? await this.permanentlyDeleteConversations(ids, state)
      : { deletedCount: 0 };
    return { deleted: result.deletedCount, remaining: this.countInState(state) };
  }

  private countInState(state: "trash" | "spam") {
    return this.db
      .select({ count: sql<number>`count(*)` })
      .from(conversations)
      .where(eq(conversations.mailboxState, state))
      .all()[0]?.count ?? 0;
  }

  private retentionRules(settings = this.getRetention()) {
    return ([["trash", settings?.trashDays], ["spam", settings?.spamDays]] as const)
      .flatMap(([state, days]) => days ? [{ state, ms: days * DAY_MS }] : []);
  }

  private async processRetention(now: number) {
    for (const { state, ms } of this.retentionRules()) {
      const expired = this.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(
          eq(conversations.mailboxState, state),
          lte(conversations.stateChangedAt, new Date(now - ms)),
        ))
        .orderBy(asc(conversations.stateChangedAt))
        .limit(RETENTION_BATCH_SIZE)
        .all()
        .map((row) => row.id);
      if (expired.length) await this.permanentlyDeleteConversations(expired, state);
    }
  }

  /** The earliest moment a Trash or Spam conversation reaches its retention limit. */
  private nextRetentionAt() {
    let next: number | null = null;
    for (const { state, ms } of this.retentionRules()) {
      const oldest = this.db
        .select({ at: conversations.stateChangedAt })
        .from(conversations)
        .where(eq(conversations.mailboxState, state))
        .orderBy(asc(conversations.stateChangedAt))
        .limit(1)
        .all()[0]?.at;
      if (!oldest) continue;
      const due = oldest.getTime() + ms;
      next = next === null ? due : Math.min(next, due);
    }
    return next;
  }

  private async scheduleRemainingWork() {
    const nextInbound = this.db
      .select({ nextAttemptAt: pendingInbound.nextAttemptAt })
      .from(pendingInbound)
      .orderBy(asc(pendingInbound.nextAttemptAt))
      .limit(1)
      .all()[0];
    const nextObjectDeletion = this.db
      .select({ nextAttemptAt: pendingObjectDeletions.nextAttemptAt })
      .from(pendingObjectDeletions)
      .orderBy(asc(pendingObjectDeletions.nextAttemptAt))
      .limit(1)
      .all()[0];
    const officePreviewAttempt = nextOfficePreviewAttempt(this.state.storage.sql);
    const retentionAt = this.nextRetentionAt();
    const nextAttemptAt = [nextInbound, nextObjectDeletion,
      ...(retentionAt === null ? [] : [{ nextAttemptAt: new Date(retentionAt) }]),
      ...(officePreviewAttempt === undefined ? [] : [{ nextAttemptAt: new Date(officePreviewAttempt) }]),
    ]
      .flatMap((job) => job ? [job.nextAttemptAt.getTime()] : [])
      .reduce<number | null>(
        (earliest, value) => earliest === null ? value : Math.min(earliest, value),
        null,
      );
    if (nextAttemptAt !== null) {
      await this.scheduleAlarm(
        Math.max(Date.now() + ALARM_WAKE_DELAY_MS, nextAttemptAt),
      );
    }
  }

  private async deliverOutgoing(id: string) {
    const message = this.getEmail(id);
    if (
      !message
      || message.direction !== "outgoing"
      || message.transportState !== "unconfirmed"
    ) {
      throw new Error("Unconfirmed outgoing message was not found");
    }
    let delivery: Awaited<ReturnType<typeof prepareOutboundDelivery>>;
    try {
      delivery = await prepareOutboundDelivery(this.bindings, message);
    } catch (error) {
      this.updateTransport(message.id, {
        state: "failed",
        error: errorMessage(error),
      });
      const failed = this.getEmail(id);
      if (!failed) throw new Error("Failed message was not persisted");
      return failed;
    }
    try {
      const result = await this.bindings.EMAIL.send(delivery);
      this.updateTransport(message.id, {
        state: "submitted",
        messageIdHeader: result.messageId,
        error: null,
      });
    } catch (error) {
      this.updateTransport(message.id, {
        state: "unconfirmed",
        error: errorMessage(error),
      });
    }
    const delivered = this.getEmail(id);
    if (!delivered) throw new Error("Submitted message was not persisted");
    return delivered;
  }

  private async scheduleAlarm(at: number) {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > at) await this.state.storage.setAlarm(at);
  }

  /** Current JMAP modification sequence and the oldest one still computable. */
  jmapSequence() {
    return this.state.storage.sql.exec<{ seq: number; floor: number }>(`
      select
        coalesce((select max(seq) from jmap_changes), 0) as seq,
        coalesce((select floor from jmap_change_floor where id = 1), 0) as floor
    `).one();
  }

  /**
   * Folds the change log after `since` into created/updated/destroyed ids.
   * Stops before the (maxChanges + 1)th distinct id and reports how far it
   * got, so a client can continue from an intermediate sequence.
   */
  jmapChanges(type: JmapChangeType, since: number, maxChanges: number) {
    const { seq: current, floor } = this.jmapSequence();
    if (!Number.isSafeInteger(since) || since < floor || since > current) return null;
    // ponytail: reads the whole retained window (<= 50k rows) per call; page it if that shows up in profiles.
    const rows = this.state.storage.sql.exec<{ seq: number; object_id: string; kind: JmapChangeKind }>(
      "select seq, object_id, kind from jmap_changes where type = ? and seq > ? order by seq",
      type,
      since,
    ).toArray();
    const objects = new Map<string, { first: JmapChangeKind | null; last: JmapChangeKind | null }>();
    let reached = current;
    let previous = since;
    for (const row of rows) {
      let entry = objects.get(row.object_id);
      if (!entry) {
        if (objects.size >= maxChanges) {
          reached = previous;
          break;
        }
        entry = { first: null, last: null };
        objects.set(row.object_id, entry);
      }
      if (row.kind !== "updated") {
        entry.first ??= row.kind;
        entry.last = row.kind;
      }
      previous = row.seq;
    }
    const created: string[] = [];
    const updated: string[] = [];
    const destroyed: string[] = [];
    for (const [id, entry] of objects) {
      const existedBefore = entry.first !== "created";
      const existsNow = entry.last !== "destroyed";
      if (existedBefore && existsNow) updated.push(id);
      else if (existsNow) created.push(id);
      else if (existedBefore) destroyed.push(id);
    }
    const contentChanged = type === "Mailbox" && this.state.storage.sql.exec<{ changed: number }>(
      "select exists (select 1 from jmap_changes where type <> 'Mailbox' and seq > ? and seq <= ?) as changed",
      since,
      reached,
    ).one().changed === 1;
    return { created, updated, destroyed, seq: reached, hasMoreChanges: reached < current, contentChanged };
  }

  /** Custom folders plus per-view counts, using the JMAP membership rules. */
  jmapMailboxes(userId: string, withCounts: boolean) {
    const customFolders = this.db.select().from(folders).all();
    if (!withCounts) return { folders: customFolders, counts: [] };
    const counts = this.state.storage.sql.exec<{
      box: string;
      total_emails: number;
      unread_emails: number;
      total_threads: number;
      unread_threads: number;
    }>(`
      with m as (
        select
          e.id,
          e.conversation_id as cid,
          e.direction,
          c.mailbox_state as state,
          c.folder_id as fid,
          c.has_incoming as hi,
          (e.direction = 'incoming' and not exists (
            select 1 from email_read_states r where r.user_id = ? and r.email_id = e.id
          )) as unread
        from emails e join conversations c on c.id = e.conversation_id
      ),
      membership(box, cid, unread) as (
        select case when state = 'active' then case when hi then 'inbox' end else state end, cid, unread from m
        union all
        select 'f:' || fid, cid, unread from m where state = 'active' and hi and fid is not null
        union all
        select 'sent', cid, unread from m where direction = 'outgoing' and state <> 'trash'
      )
      select
        box,
        count(*) as total_emails,
        sum(unread) as unread_emails,
        count(distinct cid) as total_threads,
        count(distinct case when unread then cid end) as unread_threads
      from membership
      where box is not null
      group by box
    `, userId).toArray();
    return { folders: customFolders, counts };
  }

  jmapGetEmails(userId: string, ids: string[]) {
    if (!ids.length) return [];
    const idsJson = stringListJson(ids);
    return this.db
      .select({
        email: emails,
        mailboxState: conversations.mailboxState,
        folderId: conversations.folderId,
        hasIncoming: conversations.hasIncoming,
        readAt: emailReadStates.readAt,
      })
      .from(emails)
      .innerJoin(conversations, eq(conversations.id, emails.conversationId))
      .leftJoin(emailReadStates, and(
        eq(emailReadStates.emailId, emails.id),
        eq(emailReadStates.userId, userId),
      ))
      .where(sql`${emails.id} in (select cast(value as text) from json_each(${idsJson}))`)
      .all();
  }

  jmapThreadEmailIds(conversationIds: string[]) {
    if (!conversationIds.length) return [];
    return this.state.storage.sql.exec<{ id: string; conversation_id: string }>(`
      select id, conversation_id from emails
      where conversation_id in (select cast(value as text) from json_each(?))
      order by timeline_at, id
    `, stringListJson(conversationIds)).toArray();
  }

  jmapQueryEmails(input: {
    userId: string;
    filter: EmailFilter | null;
    ascending: boolean;
    collapseThreads: boolean;
    limit: number;
    calculateTotal: boolean;
  }) {
    const bindings: Array<string | number> = [];
    const where = input.filter ? compileEmailFilter(input.filter, input.userId, bindings) : "1";
    const direction = input.ascending ? "asc" : "desc";
    const order = `e.timeline_at ${direction}, e.id ${direction}`;
    const matches = input.collapseThreads
      ? `select id, conversation_id, timeline_at from (
          select e.id, e.conversation_id, e.timeline_at,
            row_number() over (partition by e.conversation_id order by ${order}) as rank
          from emails e join conversations c on c.id = e.conversation_id
          where ${where}
        ) e where rank = 1`
      : `select e.id, e.conversation_id, e.timeline_at
        from emails e join conversations c on c.id = e.conversation_id
        where ${where}`;
    const rows = this.state.storage.sql.exec<{ id: string; conversation_id: string; timeline_at: number }>(
      `select * from (${matches}) order by ${order.replaceAll("e.", "")} limit ?`,
      ...bindings,
      input.limit,
    ).toArray();
    const total = input.calculateTotal
      ? this.state.storage.sql.exec<{ total: number }>(
          `select count(*) as total from (${matches})`,
          ...bindings,
        ).one().total
      : null;
    return { rows, total };
  }

  /**
   * Message-ID is intentionally non-unique. Ordered header arrays decide which
   * locally known copy is the parent; References fall back newest-to-oldest.
   */
  resolveParent(inReplyTo: string[], references: string[]) {
    const candidates = [...new Set([...inReplyTo, ...references])];
    if (!candidates.length) return null;
    const rows = this.db
      .select()
      .from(emails)
      .where(inArray(emails.messageIdHeader, candidates))
      .orderBy(desc(emails.timelineAt))
      .all();
    const byMessageId = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (row.messageIdHeader && !byMessageId.has(row.messageIdHeader)) {
        byMessageId.set(row.messageIdHeader, row);
      }
    }
    for (const messageId of inReplyTo) {
      const row = byMessageId.get(messageId);
      if (row) return row;
    }
    for (const messageId of references.toReversed()) {
      const row = byMessageId.get(messageId);
      if (row) return row;
    }
    return null;
  }
}

export function mailboxStub(env: Env, mailboxId: string) {
  return env.MAILBOX.getByName(mailboxId);
}
