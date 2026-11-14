import {
  aiObjectRunner,
  aiFeatureEnabled,
  aiModel,
  createDb,
  createId,
  mailboxAddressSql,
  mailboxes,
  mailDomainAllowed,
  normalizeMailboxAddress,
  deferWebhookTask,
  queueWebhookEvent,
} from "@open-workspace/core/module";
import type { AiModel } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/mailbox/migrations.js";
import {
  FOLDER_ORDER_STEP,
  folderOrderPositions,
  isCompleteFolderOrder,
  sortFolders,
} from "../../shared/folder-order";
import {
  MAX_CUSTOM_FOLDER_COUNT,
  mailboxRealtimeUpdate,
} from "../../shared/mail";
import type {
  MailboxPushJob,
  MailboxRealtimeClientMessage,
} from "../../shared/mail";
import { blockPatternsFor } from "../../shared/mail-feedback";
import type {
  FeedbackLabel,
  SenderBlock,
  Unsubscription,
} from "../../shared/mail-feedback";
import { headerValues } from "../../shared/mail-headers";
import { MAX_IMPORTED_TEXT_CHARACTERS } from "../../shared/mail-import";
import type { ImportPlacement } from "../../shared/mail-import";
import {
  officePreviewExtension,
  officePreviewKey,
} from "../../shared/office-preview";
import {
  EMAIL_RECEIVED_EVENT,
  EMAIL_WEBHOOK_SOURCE,
  emailWebhookEventId,
} from "../../shared/webhooks";
import {
  classifyInboundEmail,
  EmailAiClassificationError,
  MAILBOX_AI_MAX_ATTEMPTS,
} from "../mail/ai-classification";
import {
  AUTO_REPLY_HOURLY_CAP,
  autoReplyImagePrefix,
  autoReplyRecipient,
  autoReplyStatus,
  buildAutoReply,
  messageSkipReason,
  parseHeaderBlock,
} from "../mail/auto-reply";
import { classificationSignals } from "../mail/classification-signals";
import type { ClassificationSignals } from "../mail/classification-signals";
import { deliveryFacts } from "../mail/delivery-facts";
import {
  inboundMessageId,
  MissingRawMimeError,
  prepareInboundEmail,
  prepareUnprocessableInboundEmail,
  rawHeaderText,
  rawMessageId,
  readInboundRawMime,
  UnprocessableInboundEmailError,
} from "../mail/inbound";
import { listActiveMailboxSessions } from "../mail/mailbox-directory";
import { messageSecurity } from "../mail/message-security";
import { emailListKey } from "../mail/message-view";
import { prepareOutboundDelivery } from "../mail/outbound-delivery";
import { suggestParticipants } from "../mail/participants";
import type { ParticipantSource } from "../mail/participants";
import { replyAlias } from "../mail/reply-plan";
import { inlineImages } from "../mail/rich-content";
import { buildEmailSearchQuery } from "../mail/search";
import { spamhausDqsKey, workspaceIdentity } from "../mail/security-settings";
import type { WorkspaceIdentity } from "../mail/security-settings";
import { collectSenderIntel } from "../mail/sender-intel";
import {
  workspaceBlockPatterns,
  workspaceFeedbackSummary,
} from "../mail/workspace-safety";
import { indexInsertedEmail, mergeConversation } from "./email-index";
import {
  customFolderPredicate,
  folderAggregateJoinPredicate,
  systemFolderDefinitions,
  systemFolderPredicate,
} from "./folder-model";
import type { MailboxState, SystemFolderType } from "./folder-model";
import { mergedPlacement, requestedPlacement } from "./import-placement";
import { readInboxCounts, writeInboxCounts } from "./inbox-counts";
import type { InboxCounts } from "./inbox-counts";
import {
  bumpJmapState,
  emailPlacement as jmapEmailPlacement,
  jmapState,
  mailboxes as jmapMailboxRows,
  moveEmails as jmapMoveEmails,
  queryEmails as queryJmapEmails,
  threadEmails as jmapThreadEmails,
} from "./jmap-store";
import type {
  EmailAiClassification,
  EmailScreening,
  MailboxAiConfiguration,
  RecipientDeliveryStatus,
  SenderIntel,
} from "./model";
import {
  dispatchOfficePreviewJobs,
  hasPendingOfficePreviews,
  insertOfficePreviewJobs,
  nextOfficePreviewAttempt,
  prepareOfficePreviews,
} from "./office-preview-jobs";
import { isRetentionFolder, retentionDays, retentionRules } from "./retention";
import type { RetentionFolder } from "./retention";
import {
  autoReplyLog,
  autoReplySettings,
  conversations,
  emailReadStates,
  emails,
  folders,
  systemFolderOrder,
  mailboxAiConfiguration,
  pendingInbound,
  pendingObjectDeletions,
  senders,
  unsubscriptions,
} from "./schema";
import type {
  AutoReplySettings,
  Email,
  FolderRecord,
  NewEmail,
  NewFolder,
  PendingInbound,
} from "./schema";
import {
  blockFromPattern,
  listBlockedSenders,
  recordCorrespondents,
  recordSenderFeedback,
  senderFeedbackSummary,
  senderHistory,
  senderStatuses,
  setSenderBlocked,
  setSenderTrusted,
  workspaceBlockFor,
} from "./senders";

const schema = {
  conversations,
  emailReadStates,
  emails,
  folders,
  mailboxAiConfiguration,
  pendingInbound,
  pendingObjectDeletions,
  senders,
  unsubscriptions,
};

type MailboxDatabase = DrizzleSqliteDODatabase<typeof schema>;

/** The change counter whose inbox counts D1 has (see `syncInboxCounts`). */
const COUNTS_VERSION_KEY = "inboxCountsVersion";
const INBOUND_ALARM_BATCH_SIZE = 1;
const OBJECT_DELETION_ALARM_BATCH_SIZE = 100;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_INBOUND_RETRY_AGE_MS = 24 * 60 * 60 * 1000;

/** Attempts a delivery may end without an outcome (alarm killed) before it is stored unparsed. */
const MAX_UNFINISHED_INBOUND_ATTEMPTS = 3;

const ALARM_WAKE_DELAY_MS = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AutoReplyInput = Omit<
  AutoReplySettings,
  "id" | "updatedBy" | "updatedAt"
>;

/** Bounds one emptying or retention pass, so a huge Trash can't hold the object. */
const RETENTION_BATCH_SIZE = 100;

const PRESENCE_TTL_MS = 60_000;
const AI_CONFIGURATION_ID = "default";

/** Set while imported mail has not been announced (counts, realtime, JMAP state). */
const IMPORT_PENDING_KEY = "import:pending";

/** How long imported mail may wait to be announced when the importer does not finish. */
const IMPORT_ANNOUNCE_DELAY_MS = 15_000;

/** Browser sessions, authorized against their session on every update. */
const SESSION_SOCKET_TAG = "session";

/** JMAP EventSource streams held by the Worker; they receive the new state. */
const JMAP_SOCKET_TAG = "jmap";

/** What a browser session sends: whether its tab is visible. */
const visibilitySchema = z.enum([
  "visible",
  "hidden",
]) satisfies z.ZodType<MailboxRealtimeClientMessage>;

/** Who a session socket belongs to; it survives hibernation with the socket. */
const socketAttachmentSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  sessionTokenHash: z.string(),
  visibility: visibilitySchema,
  presenceUpdatedAt: z.number(),
});

type MailboxSocketAttachment = z.output<typeof socketAttachmentSchema>;

/** A session socket's attachment; null for other sockets (JMAP streams carry none). */
function socketAttachment(socket: WebSocket): MailboxSocketAttachment | null {
  const attachment = socketAttachmentSchema.safeParse(
    socket.deserializeAttachment()
  );

  return attachment.success ? attachment.data : null;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function retryDelay(attempts: number) {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    5000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10)
  );
}

/**
 * The folder a conversation is listed in, as the app names it: its custom
 * folder or Inbox while active, else Archive, Spam or Trash.
 */
function conversationFolder(place: {
  mailboxState: MailboxState;
  folderId: string | null;
}) {
  if (place.mailboxState !== "active") return place.mailboxState;

  return place.folderId ?? "inbox";
}

/** Whether a delivery has been retried for as long as it may be. */
function isPastRetryAge(job: PendingInbound, now: number) {
  return now - job.receivedAt.getTime() >= MAX_INBOUND_RETRY_AGE_MS;
}

function stringListJson(values: string[]) {
  return JSON.stringify([...new Set(values)]);
}

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
  /** Set when this is a member's copy of mail to a workspace mailing list. */
  listAddress?: string;
  receivedAt: number;
};

export type ImportMessageInput = {
  /** The import's delivery id: the message is stored as `inboundMessageId(importId)`. */
  importId: string;
  /** Where the route stored the raw message. */
  rawObjectKey: string;
  /** The mailbox's own address, which tells sent mail from received. */
  mailboxAddress: string;
  /** When the message was received; the Date header (then now) without one. */
  receivedAt: number | null;
  placement: ImportPlacement;
  /** A custom folder (by name, created when missing) for a message in the Inbox. */
  folderName: string | null;
  /** The people a received message is read for. */
  seenBy: string[];
  /** The conversation the importer's thread key names; null threads by Message-ID headers. */
  conversationId: string | null;
  /** Null decides by the From address. */
  direction: "incoming" | "outgoing" | null;
};

export type ImportMessageResult =
  | {
      status: "imported";
      id: string;
      conversationId: string;
      /** Why the requested folder was not used, if it was not. */
      folderSkipped: "limit" | "invalid" | null;
    }
  | { status: "duplicate"; id: string; conversationId: string }
  | { status: "unprocessable"; reason: string };

function clampText(value: string | null | undefined) {
  return value && value.length > MAX_IMPORTED_TEXT_CHARACTERS
    ? value.slice(0, MAX_IMPORTED_TEXT_CHARACTERS)
    : (value ?? null);
}

/** The Date header of a raw message, in ms, if it parses. */
function headerDate(rawMime: ArrayBuffer) {
  const value = headerValues(rawHeaderText(rawMime), "date")[0];
  const time = value ? Date.parse(value) : Number.NaN;

  return Number.isFinite(time) ? time : null;
}

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

const FOLDER_AGGREGATE_JOIN_PREDICATE = folderAggregateJoinPredicate(
  "folder",
  "conversation"
);

export type TransportUpdate = {
  state: Email["transportState"];
  messageIdHeader?: string;
  error?: string | null;
};

/** Where an incoming message lands, decided before it is stored. */
type InboundPlacement = {
  state: "spam" | null;
  folderId: string | null;
};

type InboundScreening = {
  block: SenderBlock | null;
  trusted: boolean;
};

const LIKE_ESCAPE = (value: string) =>
  value.replaceAll(/[\\%_]/gu, (char) => `\\${char}`);

/** SQL predicate on a lowercased address expression for a block pattern. */
function blockPatternPredicate(expression: string, pattern: string) {
  if (!pattern.startsWith("@")) {
    return { sql: `${expression} = ?`, bindings: [pattern] };
  }

  const domain = LIKE_ESCAPE(pattern.slice(1));

  return {
    sql: `(${expression} like ? escape '\\' or ${expression} like ? escape '\\')`,
    bindings: [`%@${domain}`, `%.${domain}`],
  };
}

export class MailboxDO extends DurableObject<Env> {
  private readonly db: MailboxDatabase;
  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private recentParticipantSources: ParticipantSource[] | null = null;
  /** The running D1 write of the inbox counts; see `syncInboxCounts`. */
  private countsWrite: Promise<void> | null = null;
  private countsDirty = false;
  /** What the last successful write stored, so the next writes only what changed. */
  private writtenCounts: InboxCounts | null = null;
  /** The D1 bookmark after that write; realtime messages pass it on. */
  private countsBookmark: string | null = null;
  /**
   * The wake this alarm set before parsing a delivery, for when it is killed
   * mid-parse; replaced by the real next wake once the attempt finishes.
   */
  private attemptAlarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx;
    this.bindings = env;
    this.db = drizzle(ctx.storage, { schema });
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);

      // D1 lacks this mailbox's latest counts: a write failed, or had not
      // finished, before the object stopped.
      if (ctx.storage.kv.get<number>(COUNTS_VERSION_KEY) !== this.version()) {
        void this.syncInboxCounts();
      }
    });
  }

  fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    // JMAP EventSource streams; the Worker holding one checks its token.
    if (request.headers.get("x-openworkspace-jmap") === "1") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], [JMAP_SOCKET_TAG]);

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const userId = request.headers.get("x-openworkspace-user-id");
    const sessionId = request.headers.get("x-openworkspace-session-id");

    const sessionTokenHash = request.headers.get(
      "x-openworkspace-session-token-hash"
    );

    if (!userId || !sessionId || !sessionTokenHash) {
      return new Response("Authentication required", { status: 401 });
    }

    const requestedVisibility = request.headers.get(
      "x-openworkspace-visibility"
    );

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
    this.state.acceptWebSocket(server, [SESSION_SOCKET_TAG]);
    // The client compares this with the versions of the data it already
    // has, and refetches only what is older.
    server.send(mailboxRealtimeUpdate(this.version(), this.countsBookmark));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const parsed = visibilitySchema.safeParse(message);

    if (!parsed.success) return;
    const visibility = parsed.data;
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
    this.writtenCounts = null;
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
          eq(emailReadStates.userId, userId)
        )
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
    const sockets = this.state
      .getWebSockets(SESSION_SOCKET_TAG)
      .flatMap((socket) => {
        const attachment = socketAttachment(socket);

        if (attachment) {
          if (
            filter &&
            (attachment.userId !== filter.userId ||
              attachment.visibility !== "visible" ||
              attachment.presenceUpdatedAt < filter.visibleAfter)
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
      for (const { socket } of sockets) {
        socket.close(1008, "Mailbox identity is unavailable");
      }

      return [];
    }

    const sessionIds = [
      ...new Set(sockets.map(({ attachment }) => attachment.sessionId)),
    ];

    const validSessions = await listActiveMailboxSessions(
      this.bindings.DB,
      mailboxId,
      sessionIds,
      Date.now()
    );

    const validSessionsById = new Map(
      validSessions.map((session) => [session.id, session])
    );

    return sockets.flatMap(({ socket, attachment }) => {
      const session = validSessionsById.get(attachment.sessionId);

      if (
        session?.userId === attachment.userId &&
        session.tokenHash === attachment.sessionTokenHash
      ) {
        return [{ socket, attachment }];
      }

      socket.close(1008, "Realtime authorization expired");

      return [];
    });
  }

  /**
   * Announces the current version to the mailbox's sockets once
   * `countsWritten` (the inbox counts write the change started, in parallel
   * with authorizing the sockets) settled, with that write's bookmark.
   */
  private async broadcastUpdate(countsWritten: Promise<void>) {
    let sockets: Awaited<ReturnType<MailboxDO["authorizedSockets"]>>;

    try {
      sockets = await this.authorizedSockets();
    } catch {
      try {
        sockets = await this.authorizedSockets();
      } catch (error) {
        // Closing forces clients to reconnect and refresh instead of silently
        // losing the only invalidation now that there is no polling fallback.
        for (const socket of this.state.getWebSockets(SESSION_SOCKET_TAG)) {
          socket.close(
            1011,
            "Realtime authorization is temporarily unavailable"
          );
        }

        throw error;
      }
    }

    if (!sockets.length) return;
    await countsWritten;

    for (const { socket } of sockets) {
      try {
        socket.send(mailboxRealtimeUpdate(this.version(), this.countsBookmark));
      } catch {
        socket.close(1011, "Could not deliver realtime event");
      }
    }
  }

  /**
   * The change counter that realtime updates carry (`update:<version>`).
   * Reads return it so clients can tell whether their data already has a
   * change they are told about.
   */
  private version() {
    return Number(jmapState(this.state.storage));
  }

  /**
   * Copies the inbox counts to D1 (`mailbox_counts`), where mailbox lists
   * read them without waking this object. Writes run one at a time in the
   * background; changes made during one are written by the next, so D1 ends
   * at the latest counts. Settles once D1 has them (failures are logged and
   * retried by the next change or start).
   */
  private syncInboxCounts(): Promise<void> {
    this.countsDirty = true;

    if (!this.countsWrite) {
      // Started after the assignment, so its `finally` clears this one.
      this.countsWrite = Promise.resolve().then(() => this.writeInboxCounts());
      this.state.waitUntil(this.countsWrite);
    }

    return this.countsWrite;
  }

  private async writeInboxCounts() {
    const mailboxId = this.state.id.name;

    try {
      // countsDirty is set again by writes while the await below is pending.
      // oxlint-disable-next-line no-unmodified-loop-condition
      while (mailboxId && this.countsDirty) {
        this.countsDirty = false;
        const version = this.version();
        const counts = readInboxCounts(this.state.storage.sql);
        // oxlint-disable-next-line eslint/no-await-in-loop -- writes the counts again until no write raced this one; each write needs the previous counts
        this.countsBookmark = await writeInboxCounts(this.bindings.DB, {
          mailboxId,
          version,
          counts,
          previous: this.writtenCounts,
        });
        this.writtenCounts = counts;
        this.state.storage.kv.put(COUNTS_VERSION_KEY, version);
      }
    } catch (error) {
      // The stored version stays behind, so the next start writes them again.
      this.writtenCounts = null;
      console.error("Could not write mailbox counts to D1", error);
    } finally {
      this.countsWrite = null;
    }
  }

  private publishUpdate() {
    bumpJmapState(this.state.storage);
    const countsWritten = this.syncInboxCounts();
    this.state.waitUntil(
      this.broadcastUpdate(countsWritten).catch((error) => {
        console.error("Could not authorize realtime delivery", error);
      })
    );
    this.announceJmapState();
  }

  /** Tells JMAP EventSource streams and (unless `push` is false) push subscribers the new state. */
  private announceJmapState(push = true) {
    const mailboxId = this.state.id.name;

    if (!mailboxId) return;
    const state = jmapState(this.state.storage);

    for (const socket of this.state.getWebSockets(JMAP_SOCKET_TAG)) {
      try {
        socket.send(state);
      } catch {
        socket.close(1011, "Could not deliver realtime event");
      }
    }

    if (!push) return;

    const job: MailboxPushJob = {
      type: "jmap-state",
      mailboxId,
      state,
      occurredAt: Date.now(),
    };

    this.state.waitUntil(
      this.bindings.PUSH_NOTIFICATIONS.send(job).catch((error) => {
        console.error("Could not queue JMAP push", error);
      })
    );
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
    cause: unknown
  ) {
    if (isPastRetryAge(job, now)) {
      this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
      console.error(
        `Stopped retrying notification for inbound delivery ${job.id}`,
        cause
      );

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
    console.error(
      `Could not queue notification for inbound delivery ${job.id}`,
      cause
    );
  }

  private async finishStoredInbound(
    job: PendingInbound,
    email: Email,
    now: number,
    announce: boolean
  ) {
    try {
      const mailboxId = this.state.id.name ?? "unknown-mailbox";
      deferWebhookTask(
        (task) => this.state.waitUntil(task),
        () =>
          queueWebhookEvent(this.bindings, {
            eventId: emailWebhookEventId(
              EMAIL_RECEIVED_EVENT,
              mailboxId,
              email.id
            ),
            eventType: EMAIL_RECEIVED_EVENT,
            occurredAt: email.timelineAt.getTime(),
            source: {
              kind: EMAIL_WEBHOOK_SOURCE,
              mailboxId,
              messageId: email.id,
            },
          })
      );

      if (announce) this.publishUpdate();

      const conversation = this.db
        .select({ mailboxState: conversations.mailboxState })
        .from(conversations)
        .where(eq(conversations.id, email.conversationId))
        .all()[0];

      if (conversation?.mailboxState !== "spam") {
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
    unreadOnly = false
  ) {
    const folder = this.getFolder(folderId);

    if (!folder) return null;
    const membership = folderMembership(folder);
    const searchQuery = search ? buildEmailSearchQuery(search) : undefined;

    if (search && !searchQuery) {
      return { items: [], next: null, version: this.version() };
    }

    const predicates = [membership.predicate];
    const bindings: (string | number)[] = [...membership.bindings];

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
        "(c.timeline_at < ? or (c.timeline_at = ? and c.latest_email_id < ?))"
      );
      bindings.push(cursor.timelineAt, cursor.timelineAt, cursor.emailId);
    }

    bindings.push(limit + 1);

    const rows = this.state.storage.sql
      .exec<ConversationRow>(
        `
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
    `,
        userId,
        ...bindings
      )
      .toArray();

    const pageRows = rows.slice(0, limit);
    const emailIds = pageRows.map((row) => row.email_id);

    const emailRows = emailIds.length
      ? this.db.select().from(emails).where(inArray(emails.id, emailIds)).all()
      : [];

    const emailsById = new Map(emailRows.map((email) => [email.id, email]));

    const items = pageRows.flatMap((row): ConversationListItem[] => {
      const email = emailsById.get(row.email_id);

      return email
        ? [
            {
              email,
              messageCount: Number(row.message_count),
              unreadCount: Number(row.unread_count),
              hasIncoming: Boolean(row.has_incoming),
            },
          ]
        : [];
    });

    const last = pageRows.at(-1);

    return {
      items,
      next:
        rows.length > limit && last
          ? { timelineAt: Number(last.timeline_at), emailId: last.email_id }
          : null,
      version: this.version(),
    };
  }

  /** The system folders at their places in the mailbox's folder order. */
  private systemFolders() {
    const stored = new Map(
      this.db
        .select()
        .from(systemFolderOrder)
        .all()
        .map((row) => [row.folderId, row.sortOrder])
    );

    return systemFolderDefinitions.map((folder) => ({
      ...folder,
      sortOrder:
        folder.id === "inbox" ? 0 : (stored.get(folder.id) ?? folder.sortOrder),
    }));
  }

  getFolder(id: string): MailFolder | null {
    const system = this.systemFolders().find((folder) => folder.id === id);

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

    return (
      systemFolderDefinitions.some(
        (folder) => folder.name.toLocaleLowerCase("en-US") === normalized
      ) ||
      this.db
        .select({ id: folders.id, name: folders.name })
        .from(folders)
        .all()
        .some(
          (folder) =>
            folder.id !== excludingId &&
            folder.name.toLocaleLowerCase("en-US") === normalized
        )
    );
  }

  createFolder(id: string, name: string) {
    const result = this.insertFolder(id, name);

    if (result.status === "ok") this.publishUpdate();

    return result;
  }

  private insertFolder(id: string, name: string) {
    const normalizedName = name.trim();

    if (!normalizedName || normalizedName.length > 80) {
      return { status: "invalid" as const };
    }

    const existing = this.db
      .select({ id: folders.id, sortOrder: folders.sortOrder })
      .from(folders)
      .all();

    if (existing.length >= MAX_CUSTOM_FOLDER_COUNT) {
      return { status: "limit" as const };
    }

    if (this.folderNameTaken(normalizedName)) {
      return { status: "conflict" as const };
    }

    // A new folder goes to the end of the whole order, system folders included.
    const last = Math.max(
      ...existing.map((item) => item.sortOrder),
      ...this.systemFolders().map((item) => item.sortOrder)
    );

    const folder = this.db
      .insert(folders)
      .values({ id, name: normalizedName, sortOrder: last + FOLDER_ORDER_STEP })
      .returning()
      .get();

    return { status: "ok" as const, folder };
  }

  renameFolder(id: string, name: string) {
    const normalizedName = name.trim();

    if (!normalizedName || normalizedName.length > 80) {
      return { status: "invalid" as const };
    }

    if (
      !this.getFolder(id) ||
      systemFolderDefinitions.some((item) => item.id === id)
    ) {
      return { status: "not_found" as const };
    }

    if (this.folderNameTaken(normalizedName, id)) {
      return { status: "conflict" as const };
    }

    const [folder] = this.db
      .update(folders)
      .set({ name: normalizedName })
      .where(eq(folders.id, id))
      .returning()
      .all();

    if (!folder) return { status: "not_found" as const };
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

  /**
   * Sets the one order of every folder but Inbox: each system folder and
   * custom folder exactly once, so system folders can sit among custom ones.
   */
  reorderFolders(folderIds: string[]) {
    const customIds = this.db
      .select({ id: folders.id })
      .from(folders)
      .all()
      .map((folder) => folder.id);

    if (!isCompleteFolderOrder(folderIds, customIds)) {
      return { status: "conflict" as const };
    }

    const custom = new Set(customIds);
    this.db.transaction((tx) => {
      for (const { id, sortOrder } of folderOrderPositions(folderIds)) {
        if (custom.has(id)) {
          tx.update(folders).set({ sortOrder }).where(eq(folders.id, id)).run();
        } else {
          tx.insert(systemFolderOrder)
            .values({ folderId: id, sortOrder })
            .onConflictDoUpdate({
              target: systemFolderOrder.folderId,
              set: { sortOrder },
            })
            .run();
        }
      }
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

  getMailboxAiSettings() {
    return {
      configuration: this.aiConfiguration(),
      globalEnabled: aiFeatureEnabled("classification"),
    };
  }

  setMailboxAiConfiguration(configuration: MailboxAiConfiguration) {
    if (
      configuration.confidenceThreshold < 50 ||
      configuration.confidenceThreshold > 100 ||
      configuration.instructions.length > 4000
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

  jmapState() {
    return jmapState(this.state.storage);
  }

  jmapMailboxes(userId: string) {
    return {
      state: jmapState(this.state.storage),
      mailboxes: jmapMailboxRows(this.state.storage.sql, userId),
    };
  }

  jmapQueryEmails(input: Parameters<typeof queryJmapEmails>[1]) {
    return {
      state: jmapState(this.state.storage),
      ...queryJmapEmails(this.state.storage.sql, input),
    };
  }

  /** Emails with their JMAP Mailbox and this user's $seen keyword; unknown ids are left out. */
  jmapEmails(userId: string, ids: string[]) {
    const placement = jmapEmailPlacement(this.state.storage.sql, userId, ids);

    return {
      state: jmapState(this.state.storage),
      emails: ids.flatMap((id) => {
        const email = this.getEmail(id);
        const place = placement.get(id);

        return email && place ? [{ email, ...place }] : [];
      }),
    };
  }

  jmapThreads(ids: string[]) {
    return {
      state: jmapState(this.state.storage),
      threads: [...jmapThreadEmails(this.state.storage.sql, ids)].map(
        ([id, emailIds]) => ({ id, emailIds })
      ),
    };
  }

  jmapMoveEmails(emailIds: string[], target: string) {
    const moved = this.db.transaction(() => {
      const known = jmapMoveEmails(this.state.storage.sql, emailIds, target);

      if (known) {
        // Mail kept out of a conversation as spam rejoins it once moved out of Junk.
        this.rejoinSplitConversations(
          this.db
            .selectDistinct({ id: emails.conversationId })
            .from(emails)
            .where(
              sql`${emails.id} in (select cast(value as text) from json_each(${stringListJson(emailIds)}))`
            )
            .all()
            .map((row) => row.id)
        );
      }

      return known;
    });

    if (moved) {
      this.publishUpdate();

      if (isRetentionFolder(target)) this.scheduleRetention();
    }

    return moved;
  }

  getEmail(id: string) {
    return (
      this.db.select().from(emails).where(eq(emails.id, id)).all()[0] ?? null
    );
  }

  getEmailByMessageId(messageIdHeader: string) {
    return (
      this.db
        .select()
        .from(emails)
        .where(eq(emails.messageIdHeader, messageIdHeader))
        .orderBy(desc(emails.timelineAt))
        .all()[0] ?? null
    );
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
    cursor: ConversationCursorPosition | null
  ) {
    const conversation = this.db
      .select({
        mailboxState: conversations.mailboxState,
        folderId: conversations.folderId,
        hasIncoming: conversations.hasIncoming,
        hasOutgoing: conversations.hasOutgoing,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .all()[0];

    if (!conversation) return null;

    const pageLimit = Math.max(1, Math.min(limit, 25));
    const cursorDate = cursor ? new Date(cursor.timelineAt) : null;

    const predicate =
      cursor && cursorDate
        ? and(
            eq(emails.conversationId, conversationId),
            or(
              lt(emails.timelineAt, cursorDate),
              and(
                eq(emails.timelineAt, cursorDate),
                lt(emails.id, cursor.emailId)
              )
            )
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

    const counts = this.state.storage.sql
      .exec<ConversationSnapshotCountRow>(
        `
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
    `,
        userId,
        conversationId
      )
      .one();

    return {
      mailboxState: conversation.mailboxState,
      folderId: conversation.folderId,
      hasIncoming: conversation.hasIncoming,
      hasOutgoing: conversation.hasOutgoing,
      messageCount: Number(counts.message_count),
      unreadCount: Number(counts.unread_count),
      messages: page.reverse(),
      next:
        descending.length > pageLimit && oldest
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

  /**
   * Everything the reader needs from this mailbox in one call: a page of the
   * conversation with read states, plus sender history and block, trust and
   * unsubscribe state for its incoming senders.
   */
  getConversationView(
    conversationId: string,
    userId: string,
    limit: number,
    cursor: ConversationCursorPosition | null
  ) {
    const snapshot = this.getConversationPageSnapshot(
      conversationId,
      userId,
      limit,
      cursor
    );

    if (!snapshot) return null;

    const incoming = snapshot.messages.filter(
      (message) => message.direction === "incoming"
    );

    const senderAddresses = incoming.flatMap((message) =>
      message.fromJson[0] ? [message.fromJson[0].address] : []
    );

    return {
      ...snapshot,
      history: this.getSenderHistory(senderAddresses),
      safety: this.getMessageSafetyContext(
        senderAddresses,
        incoming.flatMap((message) => emailListKey(message) ?? [])
      ),
      version: this.version(),
    };
  }

  /** One message with its sender's history and safety state, for re-deriving its security summary. */
  getMessageSenderView(emailId: string) {
    const email = this.getEmail(emailId);

    if (!email) return null;

    const sender =
      email.direction === "incoming" ? email.fromJson[0]?.address : undefined;

    const senderAddresses = sender ? [sender] : [];
    const listKey = emailListKey(email);

    return {
      email,
      history: this.getSenderHistory(senderAddresses),
      safety: this.getMessageSafetyContext(
        senderAddresses,
        listKey ? [listKey] : []
      ),
    };
  }

  getAttachment(emailId: string, attachmentId: string) {
    const email = this.getEmail(emailId);

    return (
      email?.attachmentsJson.find((file) => file.id === attachmentId) ?? null
    );
  }

  async completeOfficePreview(
    emailId: string,
    attachmentId: string,
    sourceKey: string,
    status: "ready" | "failed"
  ) {
    const email = this.getEmail(emailId);

    const file = email?.attachmentsJson.find(
      (attachment) =>
        attachment.id === attachmentId && attachment.r2Key === sourceKey
    );

    if (!email || !file) {
      // Conversion may finish after permanent deletion already removed its objects.
      // Persist cleanup before the queue acknowledges, so an R2 outage cannot orphan the PDF.
      const cleanupAt = new Date();
      await this.scheduleAlarm(cleanupAt.getTime() + ALARM_WAKE_DELAY_MS);
      this.db
        .insert(pendingObjectDeletions)
        .values({
          objectKey: officePreviewKey(sourceKey),
          nextAttemptAt: cleanupAt,
        })
        .onConflictDoNothing()
        .run();

      return false;
    }

    if (file.pdfPreviewStatus !== "pending") return true;
    this.db
      .update(emails)
      .set({
        attachmentsJson: email.attachmentsJson.map((attachment) =>
          attachment.id === attachmentId
            ? { ...attachment, pdfPreviewStatus: status }
            : attachment
        ),
      })
      .where(eq(emails.id, emailId))
      .run();
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

    const flagged = this.state.storage.sql
      .exec<{ address: string }>(
        "select address from senders where blocked_at is not null or reported_at is not null"
      )
      .toArray()
      .map((row) => row.address);

    const excluded = new Set(flagged);

    return suggestParticipants(
      this.recentParticipantSources,
      ownAddress,
      query,
      limit,
      (address) =>
        blockPatternsFor(address).some((pattern) => excluded.has(pattern))
    );
  }

  listFolders(userId: string): FolderListItem[] {
    const rows = this.state.storage.sql
      .exec<FolderListRow>(
        `
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
    `,
        JSON.stringify(this.systemFolders()),
        userId
      )
      .toArray();

    return sortFolders(
      rows.map((row): FolderListItem => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        systemType: row.system_type,
        sortOrder: Number(row.sort_order),
        totalCount: Number(row.total_count),
        unreadCount: Number(row.unread_count),
      }))
    );
  }

  /**
   * What the mail screen shows first, in one call: the folders and the first
   * page of `folderId` (null for no such folder).
   */
  startupView(userId: string, folderId: string, limit: number) {
    return {
      folders: this.folderView(userId),
      conversations: this.listConversations(
        userId,
        folderId,
        limit,
        null,
        undefined
      ),
    };
  }

  /** `listFolders` with the change counter it reflects. */
  folderView(userId: string) {
    return {
      folders: this.listFolders(userId),
      version: this.version(),
      retention: retentionDays(this.bindings),
    };
  }

  getFolderCounts(userId: string, folderId: string): FolderCounts | null {
    const folder = this.getFolder(folderId);

    return folder ? this.countFolder(userId, folder) : null;
  }

  private countFolder(userId: string, folder: MailFolder): FolderCounts {
    const membership = folderMembership(folder);

    const counts = this.state.storage.sql
      .exec<FolderCountRow>(
        `
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
    `,
        userId,
        ...membership.bindings
      )
      .one();

    return {
      totalCount: Number(counts.total_count),
      unreadCount: Number(counts.unread_count),
    };
  }

  /** Sets one person's read state; the change counter after it, or false for no such message. */
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
        .where(
          and(
            eq(emailReadStates.userId, userId),
            eq(emailReadStates.emailId, emailId)
          )
        )
        .run();
    }

    this.publishUpdate();

    return { version: this.version() };
  }

  bulkSetConversationRead(
    userId: string,
    conversationIds: string[],
    isRead: boolean
  ) {
    const candidates = [...new Set(conversationIds)];

    if (!candidates.length) return 0;
    const candidatesJson = stringListJson(candidates);

    const existingIds = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          sql`${conversations.id} in (
          select cast(value as text) from json_each(${candidatesJson})
        )`,
          eq(conversations.hasIncoming, true)
        )
      )
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
          listAddress: input.listAddress ?? null,
          receivedAt,
          nextAttemptAt: queuedAt,
        })
        .onConflictDoNothing()
        .returning({ id: pendingInbound.id })
        .all();

      return result.length > 0;
    });

    // An alarm finishing meanwhile may have dropped its own wake (see
    // `scheduleRemainingWork`) before it could see this row.
    if (queued) await this.scheduleAlarm(alarmAt);

    return { messageId, queued };
  }

  async insertEmail(input: NewEmail) {
    const email = prepareOfficePreviews(input);

    if (hasPendingOfficePreviews(email)) {
      await this.scheduleAlarm(Date.now() + ALARM_WAKE_DELAY_MS);
    }

    this.db.transaction((tx) => {
      const inserted = tx
        .insert(emails)
        .values(email)
        .onConflictDoNothing()
        .returning({ id: emails.id })
        .all();

      if (inserted.length) {
        indexInsertedEmail(this.state.storage.sql, email.id);
        insertOfficePreviewJobs(this.state.storage.sql, email);
        recordCorrespondents(this.state.storage.sql, email);
      }
    });
    this.recentParticipantSources = null;
    void this.syncInboxCounts();

    return this.getEmail(email.id);
  }

  /**
   * The message an import already stored: the one `importId` made, or one
   * with the same Message-ID (from another source, or delivered here).
   */
  findImported(importId: string, messageIdHeader: string | null) {
    const existing =
      this.getEmail(inboundMessageId(importId)) ??
      (messageIdHeader ? this.getEmailByMessageId(messageIdHeader) : null);

    return existing
      ? { id: existing.id, conversationId: existing.conversationId }
      : null;
  }

  /**
   * Stores one existing message (raw MIME already in R2) as delivery would,
   * with its place, read state, date and thread given by the importer. No
   * AI, sender checks, webhooks or push: imported mail is history. The
   * conversation and search index are kept as for any message; counts,
   * realtime and JMAP state are announced once for the batch
   * (`finishImport`, or the alarm when the importer never says it finished).
   * Idempotent by `importId` and by Message-ID.
   */
  async importMessage(input: ImportMessageInput): Promise<ImportMessageResult> {
    const id = inboundMessageId(input.importId);
    const known = this.getEmail(id);

    if (known) {
      return { status: "duplicate", id, conversationId: known.conversationId };
    }

    const object = await this.bindings.MAIL_STORAGE.get(input.rawObjectKey);

    if (!object) throw new MissingRawMimeError();
    const rawMime = await object.arrayBuffer();
    const messageIdHeader = rawMessageId(rawMime);

    const copy = messageIdHeader
      ? this.getEmailByMessageId(messageIdHeader)
      : null;

    if (copy) {
      // Nothing will point at this upload.
      await this.bindings.MAIL_STORAGE.delete(input.rawObjectKey);

      return {
        status: "duplicate",
        id: copy.id,
        conversationId: copy.conversationId,
      };
    }

    const receivedAt = new Date(
      input.receivedAt ?? headerDate(rawMime) ?? Date.now()
    );

    let parsed: NewEmail;

    try {
      parsed = (
        await prepareInboundEmail({
          env: this.bindings,
          mailboxId: this.state.id.name ?? "unknown-mailbox",
          job: {
            id: input.importId,
            rawObjectKey: input.rawObjectKey,
            envelopeFrom: "",
            envelopeTo: input.mailboxAddress,
            listAddress: null,
            receivedAt,
          },
          rawMime,
          resolveParent: (inReplyTo, references) =>
            this.resolveParent(inReplyTo, references),
        })
      ).email;
    } catch (error) {
      if (!(error instanceof UnprocessableInboundEmailError)) throw error;
      await this.bindings.MAIL_STORAGE.delete(input.rawObjectKey);

      return { status: "unprocessable", reason: error.message };
    }

    const own = normalizeMailboxAddress(input.mailboxAddress);

    const direction =
      input.direction ??
      (parsed.fromJson[0] &&
      normalizeMailboxAddress(parsed.fromJson[0].address) === own
        ? "outgoing"
        : "incoming");

    const imported: NewEmail = {
      ...parsed,
      conversationId: input.conversationId ?? parsed.conversationId,
      direction,
      bodyText: clampText(parsed.bodyText),
      quotedText: clampText(parsed.quotedText),
      // Not an SMTP delivery to this workspace.
      envelopeFrom: null,
      envelopeTo: null,
    };

    // Mail this mailbox sent went out already, unauthenticated by anyone here.
    if (direction === "outgoing") {
      imported.transportState = "submitted";
      imported.authenticationResultsJson = null;
      imported.listUnsubscribeJson = null;
    }

    const email = prepareOfficePreviews(imported);

    const stored = this.db.transaction((tx) => {
      const before =
        tx
          .select({
            mailboxState: conversations.mailboxState,
            folderId: conversations.folderId,
          })
          .from(conversations)
          .where(eq(conversations.id, email.conversationId))
          .all()[0] ?? null;

      let folderId: string | null = null;
      let folderSkipped: "limit" | "invalid" | null = null;

      if (input.placement === "inbox" && input.folderName) {
        const folder = this.importFolder(input.folderName);

        if ("id" in folder) folderId = folder.id;
        else folderSkipped = folder.skipped;
      }

      const inserted = tx
        .insert(emails)
        .values(email)
        .onConflictDoNothing()
        .returning({ id: emails.id })
        .all();

      if (!inserted.length) return null;
      indexInsertedEmail(this.state.storage.sql, email.id);
      insertOfficePreviewJobs(this.state.storage.sql, email);
      recordCorrespondents(this.state.storage.sql, email);

      const placement = mergedPlacement(
        before,
        requestedPlacement(input.placement, folderId)
      );

      if (placement) {
        // The new message just moved the conversation to Inbox, so compare
        // with where it was before.
        const entered =
          isRetentionFolder(placement.mailboxState) &&
          before?.mailboxState !== placement.mailboxState;

        tx.update(conversations)
          .set({
            ...placement,
            stateChangedAt: entered ? new Date() : undefined,
          })
          .where(eq(conversations.id, email.conversationId))
          .run();
      }

      if (direction === "incoming") {
        for (const userId of new Set(input.seenBy)) {
          tx.insert(emailReadStates)
            .values({ userId, emailId: email.id, readAt: receivedAt })
            .onConflictDoNothing()
            .run();
        }
      }

      return { folderSkipped };
    });

    if (!stored) {
      const existing = this.getEmail(id);

      return {
        status: "duplicate",
        id,
        conversationId: existing?.conversationId ?? email.conversationId,
      };
    }

    this.recentParticipantSources = null;
    this.state.storage.kv.put(IMPORT_PENDING_KEY, true);
    await this.scheduleAlarm(
      Date.now() +
        (hasPendingOfficePreviews(email)
          ? ALARM_WAKE_DELAY_MS
          : IMPORT_ANNOUNCE_DELAY_MS)
    );

    return {
      status: "imported",
      id,
      conversationId: email.conversationId,
      folderSkipped: stored.folderSkipped,
    };
  }

  /** The custom folder with this name (any case), created when missing; why not, when it cannot be. */
  private importFolder(
    name: string
  ): { id: string } | { skipped: "limit" | "invalid" } {
    const normalized = name.trim().toLocaleLowerCase("en-US");

    const existing = this.db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .all()
      .find((folder) => folder.name.toLocaleLowerCase("en-US") === normalized);

    if (existing) return { id: existing.id };
    const created = this.insertFolder(createId("fld"), name);

    if (created.status === "ok") return { id: created.folder.id };

    // A system folder's name ("Sent", "Archive") is no custom folder.
    return { skipped: created.status === "limit" ? "limit" : "invalid" };
  }

  /**
   * Announces what imports stored since the last time: writes the inbox
   * counts to D1 once, bumps the JMAP state, and tells open apps to refresh.
   * Push subscribers are not told; imported mail is not new mail.
   */
  async finishImport() {
    if (this.state.storage.kv.get<boolean>(IMPORT_PENDING_KEY)) {
      this.state.storage.kv.delete(IMPORT_PENDING_KEY);
      bumpJmapState(this.state.storage);
      const countsWritten = this.syncInboxCounts();
      this.state.waitUntil(
        this.broadcastUpdate(countsWritten).catch((error) => {
          console.error("Could not authorize realtime delivery", error);
        })
      );
      this.announceJmapState(false);
      await countsWritten;
    }

    return { version: this.version() };
  }

  /**
   * DNS intelligence and receiver signals for a parsed delivery, gathered
   * before AI classification so the model can use them. Fails open.
   */
  private async inboundSenderSignals(email: NewEmail, links: string[]) {
    let identity: WorkspaceIdentity = { domains: [], names: new Map() };
    let dqsKey: string | null = null;
    let workspaceBlocks = new Map<string, number>();

    try {
      [identity, dqsKey, workspaceBlocks] = await Promise.all([
        workspaceIdentity(this.bindings.DB),
        spamhausDqsKey(this.bindings),
        workspaceBlockPatterns(this.bindings.DB),
      ]);
    } catch (error) {
      console.error(
        "Could not read workspace identity for sender checks",
        error
      );
    }

    const stored = email.authenticationResultsJson;
    const authentication = stored ?? null;
    const from = email.fromJson[0] ?? { address: "", name: null };
    const storage = this.state.storage.sql;

    const status = from.address
      ? senderStatuses(storage, [from.address]).get(
          from.address.toLocaleLowerCase()
        )
      : undefined;

    const block =
      workspaceBlockFor(from.address, workspaceBlocks) ?? status?.block ?? null;

    const trusted = Boolean(status?.trustedAt) && !block;
    let intel: SenderIntel | null = null;

    try {
      intel = await collectSenderIntel({
        authentication,
        fromAddress: from.address,
        linkDomains: links,
        workspaceDomains: identity.domains,
        dqsKey,
        bucket: this.bindings.MAIL_STORAGE,
      });
    } catch (error) {
      console.error(
        `Could not collect sender intelligence for ${email.id}`,
        error
      );
    }

    const history = senderHistory(storage, [from.address]).get(
      from.address.toLocaleLowerCase()
    );

    const delivery = deliveryFacts({
      authentication,
      deliveredTo: email.envelopeTo ?? null,
      to: (email.toJson ?? []).map((item) => item.address),
      cc: (email.ccJson ?? []).map((item) => item.address),
      listId: email.listId ?? null,
      workspaceDomains: identity.domains,
      isKnownAddressee: (address) => this.isKnownAddressee(address),
    });

    const security = messageSecurity({
      fromAddress: from.address,
      fromName: from.name,
      authentication,
      listUnsubscribe: null,
      workspaceDomains: identity.domains,
      internalNames: identity.names,
      intel,
      // Counted as if this message were already stored.
      history: {
        inboundCount: (history?.inboundCount ?? 0) + 1,
        outboundCount: history?.outboundCount ?? 0,
      },
      replyTo: (email.replyToJson ?? []).map((item) => item.address),
      listId: email.listId ?? null,
      delivery,
      trusted,
    });

    const screening: InboundScreening = { block, trusted };

    let workspaceFeedback: Awaited<
      ReturnType<typeof workspaceFeedbackSummary>
    > | null = null;

    const mailboxId = this.state.id.name;

    if (from.address && mailboxId && !block) {
      try {
        workspaceFeedback = await workspaceFeedbackSummary(
          this.bindings.DB,
          mailboxId,
          from.address
        );
      } catch (error) {
        console.error(
          `Could not read workspace feedback for ${email.id}`,
          error
        );
      }
    }

    return {
      intel,
      delivery,
      screening,
      signals: classificationSignals({
        authentication,
        intel,
        firstTimeSender: security.firstTimeSender,
        warnings: security.warnings,
        feedback: from.address
          ? senderFeedbackSummary(storage, from.address)
          : null,
        workspaceFeedback,
        delivery,
      }),
    };
  }

  /** Mail written to this address already reached the mailbox from at least two senders. */
  private isKnownAddressee(address: string) {
    const [row] = this.state.storage.sql
      .exec<{ senders: number }>(
        `
      select count(distinct lower(json_extract(message.from_json, '$[0].address'))) as senders
      from emails message
      where message.direction = 'incoming'
        and exists (
          select 1 from json_each(message.to_json) recipient
          where lower(json_extract(recipient.value, '$.address')) = ?1
          union all
          select 1 from json_each(message.cc_json) recipient
          where lower(json_extract(recipient.value, '$.address')) = ?1
        )
    `,
        address.toLocaleLowerCase()
      )
      .toArray();

    return Number(row?.senders ?? 0) >= 2;
  }

  /** Blocks win over AI; trusted senders override an AI spam verdict. */
  private inboundPlacement(
    screening: InboundScreening,
    classification: EmailAiClassification | null
  ): InboundPlacement {
    if (screening.block) return { state: "spam", folderId: null };

    if (classification?.spam && !screening.trusted) {
      return { state: "spam", folderId: null };
    }

    return { state: null, folderId: classification?.folderId ?? null };
  }

  /** The model from openworkspace.json; tests substitute one on the instance. */
  protected classificationModel(): Promise<AiModel | null> {
    return aiModel(this.bindings, "classification");
  }

  private async classifyInbound(
    rawMime: ArrayBuffer,
    signals: ClassificationSignals | null
  ) {
    let ai: AiModel | null;

    try {
      ai = await this.classificationModel();
    } catch (error) {
      throw new EmailAiClassificationError(
        "The classification model is misconfigured",
        { cause: error }
      );
    }

    if (!ai) return null;
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
      signals,
      model: ai.id,
      run: aiObjectRunner(ai),
    });
  }

  private insertClassifiedInboundEmail(
    input: NewEmail,
    classification: EmailAiClassification | null,
    placement: InboundPlacement
  ) {
    const prepared = prepareOfficePreviews(input);

    const stored = this.db.transaction((tx) => {
      // Threading trusts the sender's In-Reply-To and References, so spam
      // that names a message here starts its own conversation instead of
      // moving (or reviving) one with other mail. Spam may join spam.
      const joined = placement.state
        ? tx
            .select({ mailboxState: conversations.mailboxState })
            .from(conversations)
            .where(eq(conversations.id, prepared.conversationId))
            .all()[0]
        : undefined;

      // The conversation it named is recorded, so the message rejoins it
      // when it leaves Spam (rejoinSplitConversations).
      const email =
        joined && joined.mailboxState !== placement.state
          ? {
              ...prepared,
              conversationId: createId("conv"),
              splitFromConversationId: prepared.conversationId,
            }
          : prepared;

      const trustedFolder = placement.folderId
        ? tx
            .select({ id: folders.id })
            .from(folders)
            .where(eq(folders.id, placement.folderId))
            .all()[0]
        : null;

      const normalizedClassification =
        classification?.folderId &&
        !tx
          .select({ id: folders.id })
          .from(folders)
          .where(eq(folders.id, classification.folderId))
          .all()[0]
          ? { ...classification, folderId: null }
          : classification;

      const inserted = tx
        .insert(emails)
        .values({
          ...email,
          aiClassificationJson: normalizedClassification,
        })
        .onConflictDoNothing()
        .returning()
        .all()[0];

      if (!inserted) return null;
      indexInsertedEmail(this.state.storage.sql, inserted.id);
      insertOfficePreviewJobs(this.state.storage.sql, email);
      recordCorrespondents(this.state.storage.sql, email);

      const activeConversation = and(
        eq(conversations.id, email.conversationId),
        eq(conversations.mailboxState, "active")
      );

      // AI sorting files only the first incoming message of a conversation:
      // a reply to received mail (whose threading headers the sender chose)
      // leaves the thread where it is. Replies to a thread this mailbox
      // started are filed like new mail.
      const startsConversation = !tx
        .select({ id: emails.id })
        .from(emails)
        .where(
          and(
            eq(emails.conversationId, email.conversationId),
            eq(emails.direction, "incoming"),
            ne(emails.id, inserted.id)
          )
        )
        .limit(1)
        .all()[0];

      if (placement.state) {
        tx.update(conversations)
          .set({
            mailboxState: placement.state,
            folderId: null,
            stateChangedAt: new Date(),
          })
          .where(activeConversation)
          .run();
      } else if (trustedFolder && startsConversation) {
        tx.update(conversations)
          .set({ folderId: trustedFolder.id })
          .where(and(activeConversation, isNull(conversations.folderId)))
          .run();
      }

      return (
        tx.select().from(emails).where(eq(emails.id, inserted.id)).all()[0] ??
        null
      );
    });

    this.recentParticipantSources = null;

    return stored;
  }

  /**
   * Fills sender intelligence in on view: for a message without any, or
   * replacing the failed result checked at `replacesCheckedAt`.
   */
  setEmailSenderIntel(
    emailId: string,
    intel: SenderIntel,
    replacesCheckedAt: number | null = null
  ) {
    const current =
      replacesCheckedAt === null
        ? isNull(emails.senderIntelJson)
        : sql`json_extract(${emails.senderIntelJson}, '$.checkedAt') = ${replacesCheckedAt}`;

    return (
      this.db
        .update(emails)
        .set({ senderIntelJson: intel })
        .where(
          and(eq(emails.id, emailId), eq(emails.direction, "incoming"), current)
        )
        .returning({ id: emails.id })
        .all().length > 0
    );
  }

  /** Inbound/outbound counters for the given addresses (lowercased keys). */
  getSenderHistory(addresses: string[]) {
    return Object.fromEntries(senderHistory(this.state.storage.sql, addresses));
  }

  /** Block, trust and report state for senders, and unsubscribe records for lists. */
  getMessageSafetyContext(addresses: string[], listKeys: string[]) {
    const keys = [...new Set(listKeys)].slice(0, 100);

    const rows = keys.length
      ? this.db
          .select()
          .from(unsubscriptions)
          .where(inArray(unsubscriptions.listKey, keys))
          .all()
      : [];

    return {
      senders: Object.fromEntries(
        senderStatuses(this.state.storage.sql, addresses)
      ),
      unsubscriptions: Object.fromEntries(
        rows.map((row): [string, Unsubscription] => [
          row.listKey,
          {
            listKey: row.listKey,
            method: row.method,
            status: row.status,
            target: row.target,
            at: row.createdAt.getTime(),
          },
        ])
      ),
    };
  }

  recordUnsubscription(input: {
    listKey: string;
    emailId: string;
    method: Unsubscription["method"];
    status: Unsubscription["status"];
    target: string | null;
    detail: string | null;
    userId: string;
  }): Unsubscription {
    const createdAt = new Date();
    const values = { ...input, createdAt };
    this.db
      .insert(unsubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: unsubscriptions.listKey, set: values })
      .run();
    this.publishUpdate();

    return {
      listKey: input.listKey,
      method: input.method,
      status: input.status,
      target: input.target,
      at: createdAt.getTime(),
    };
  }

  /** Moves every Inbox or Archive conversation with mail from the pattern to Spam. */
  private moveSenderConversationsToSpam(pattern: string) {
    const predicate = blockPatternPredicate(
      "lower(json_extract(message.from_json, '$[0].address'))",
      pattern
    );

    const moved = this.state.storage.sql
      .exec<{ id: string }>(
        `
      update conversations
      set mailbox_state = 'spam', folder_id = null, state_changed_at = ?
      where mailbox_state in ('active', 'archive')
        and id in (
          select message.conversation_id from emails message
          where message.direction = 'incoming' and ${predicate.sql}
        )
      returning id
    `,
        Date.now(),
        ...predicate.bindings
      )
      .toArray().length;

    if (moved) this.scheduleRetention();

    return moved;
  }

  blockSender(pattern: string, moveExisting: boolean) {
    const moved = this.db.transaction(() => {
      setSenderBlocked(this.state.storage.sql, pattern, true, Date.now());

      return moveExisting ? this.moveSenderConversationsToSpam(pattern) : 0;
    });

    this.recentParticipantSources = null;
    this.publishUpdate();

    return { block: blockFromPattern(pattern, Date.now(), false), moved };
  }

  /** For a workspace-wide block: existing mail goes to Spam; the block itself lives in D1. */
  moveSenderToSpam(pattern: string) {
    const moved = this.moveSenderConversationsToSpam(pattern);

    if (moved) {
      this.recentParticipantSources = null;
      this.publishUpdate();
    }

    return moved;
  }

  unblockSender(pattern: string) {
    const existed =
      this.state.storage.sql
        .exec(
          "select 1 from senders where address = ? and blocked_at is not null",
          pattern
        )
        .toArray().length > 0;

    setSenderBlocked(this.state.storage.sql, pattern, false, Date.now());
    this.recentParticipantSources = null;
    this.publishUpdate();

    return existed;
  }

  listBlockedSenders() {
    return listBlockedSenders(this.state.storage.sql);
  }

  setSenderTrusted(address: string, trusted: boolean) {
    setSenderTrusted(this.state.storage.sql, address, trusted, Date.now());
    this.publishUpdate();

    return true;
  }

  /** The newest incoming message of each conversation, for actions that need a sender. */
  latestIncomingEmails(conversationIds: string[]) {
    const ids = [...new Set(conversationIds)].slice(0, 100);

    if (!ids.length) return [];

    const rows = this.state.storage.sql
      .exec<{ id: string }>(
        `
      select (
        select message.id from emails message
        where message.conversation_id = requested.value and message.direction = 'incoming'
        order by message.timeline_at desc, message.id desc limit 1
      ) as id
      from json_each(?) requested
    `,
        stringListJson(ids)
      )
      .toArray()
      .flatMap((row) => (row.id ? [row.id] : []));

    return rows.length
      ? this.db.select().from(emails).where(inArray(emails.id, rows)).all()
      : [];
  }

  /**
   * Report spam: labels the message, records feedback for the classifier,
   * and moves its conversation to Spam. Never contacts the sender.
   */
  reportMessage(input: { emailId: string; userId: string }) {
    const email = this.getEmail(input.emailId);

    if (!email || email.direction !== "incoming") return null;
    const address = email.fromJson[0]?.address ?? "";

    const moved = this.db.transaction((tx) => {
      tx.update(emails)
        .set({ reportLabel: "spam" })
        .where(eq(emails.id, email.id))
        .run();

      if (address.includes("@")) {
        recordSenderFeedback(this.state.storage.sql, {
          id: createId("fbk"),
          address,
          emailId: email.id,
          label: "spam",
          userId: input.userId,
          now: Date.now(),
        });
      }

      return (
        tx
          .update(conversations)
          .set({
            mailboxState: "spam",
            folderId: null,
            stateChangedAt: new Date(),
          })
          .where(
            and(
              eq(conversations.id, email.conversationId),
              inArray(conversations.mailboxState, ["active", "archive"])
            )
          )
          .returning({ id: conversations.id })
          .all().length > 0
      );
    });

    this.recentParticipantSources = null;
    this.publishUpdate();

    if (moved) this.scheduleRetention();

    return {
      email: required(this.getEmail(email.id), "The reported email exists"),
      moved,
    };
  }

  /** "Not spam": back to Inbox, the sender becomes trusted, and the feedback is recorded. */
  markNotSpam(input: { emailId: string; userId: string }) {
    const email = this.getEmail(input.emailId);

    if (!email || email.direction !== "incoming") return null;
    const address = email.fromJson[0]?.address ?? "";
    const label: FeedbackLabel = "not_spam";

    const outcome = this.db.transaction((tx) => {
      tx.update(emails)
        .set({ reportLabel: null })
        .where(eq(emails.conversationId, email.conversationId))
        .run();

      if (address.includes("@")) {
        recordSenderFeedback(this.state.storage.sql, {
          id: createId("fbk"),
          address,
          emailId: email.id,
          label,
          userId: input.userId,
          now: Date.now(),
        });
        setSenderTrusted(this.state.storage.sql, address, true, Date.now());
      }

      const back =
        tx
          .update(conversations)
          .set({ mailboxState: "active" })
          .where(
            and(
              eq(conversations.id, email.conversationId),
              eq(conversations.mailboxState, "spam")
            )
          )
          .returning({ id: conversations.id })
          .all().length > 0;

      // Spam that named a conversation here was kept out of it; once it is
      // not spam, it rejoins that conversation.
      const conversationId = back
        ? (this.rejoinSplitConversations([email.conversationId]).get(
            email.conversationId
          ) ?? email.conversationId)
        : email.conversationId;

      const place = tx
        .select({
          mailboxState: conversations.mailboxState,
          folderId: conversations.folderId,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .all()[0];

      return {
        restored: back,
        conversationId,
        folder: place ? conversationFolder(place) : "inbox",
      };
    });

    this.recentParticipantSources = null;
    this.publishUpdate();

    return {
      restored: outcome.restored,
      conversationId: outcome.conversationId,
      rejoined: outcome.conversationId !== email.conversationId,
      folder: outcome.folder,
      address: address.includes("@") ? address : null,
    };
  }

  /**
   * Puts mail kept out of a conversation as spam (#25) back into it, once
   * its own conversation has left Spam: by Not spam, a move in the app or
   * over JMAP, or a reply sent from here. Call it inside the transaction
   * that moved `conversationIds`; only those now in Inbox or Archive that
   * hold a message marked with `split_from_conversation_id` are touched, so
   * conversations threaded elsewhere (an import's, say) are never merged.
   *
   * The marked message names the conversation it was kept out of. When that
   * conversation is gone, the message's own threading headers are resolved
   * again. The conversation rejoins its target when the target is in Inbox
   * or Archive; a target in Trash or Spam is not brought back by it, and the
   * conversation stays where it was moved. Either way the decision is final
   * and the mark is cleared.
   *
   * The rescued message is placed as a legitimate reply would be: moved to
   * Inbox (or a custom folder), the target becomes active and takes that
   * folder (else keeps its own). Moved to Archive, the target stays where it
   * is. Returns, for each merged conversation, the one its messages are in.
   */
  private rejoinSplitConversations(conversationIds: string[]) {
    const merged = new Map<string, string>();

    if (!conversationIds.length) return merged;

    const marked = this.db
      .select({
        emailId: emails.id,
        conversationId: conversations.id,
        mailboxState: conversations.mailboxState,
        folderId: conversations.folderId,
        splitFrom: emails.splitFromConversationId,
        inReplyTo: emails.inReplyToJson,
        references: emails.referencesJson,
      })
      .from(emails)
      .innerJoin(conversations, eq(conversations.id, emails.conversationId))
      .where(
        and(
          sql`${conversations.id} in (select cast(value as text) from json_each(${stringListJson(conversationIds)}))`,
          inArray(conversations.mailboxState, ["active", "archive"]),
          isNotNull(emails.splitFromConversationId)
        )
      )
      .all();

    const groups = new Map<string, typeof marked>();

    for (const row of marked) {
      groups.set(row.conversationId, [
        ...(groups.get(row.conversationId) ?? []),
        row,
      ]);
    }

    for (const [conversationId, rows] of groups) {
      const targets = new Set(
        rows.map((row) => this.splitTarget(conversationId, row))
      );

      const [target, ...others] = targets;

      this.db
        .update(emails)
        .set({ splitFromConversationId: null })
        .where(
          and(
            eq(emails.conversationId, conversationId),
            isNotNull(emails.splitFromConversationId)
          )
        )
        .run();

      if (!target || others.length) continue;
      const [moved] = rows;

      if (!moved) continue;
      mergeConversation(this.state.storage.sql, conversationId, target);

      if (moved.mailboxState === "active") {
        this.db
          .update(conversations)
          .set({
            mailboxState: "active",
            folderId: moved.folderId ?? sql`${conversations.folderId}`,
          })
          .where(eq(conversations.id, target))
          .run();
      }

      merged.set(conversationId, target);
    }

    return merged;
  }

  /**
   * The conversation a marked message rejoins, or null: the one it was kept
   * out of, else (when that one is gone) its parent's, while that
   * conversation is in Inbox or Archive.
   */
  private splitTarget(
    conversationId: string,
    row: { splitFrom: string | null; inReplyTo: string[]; references: string[] }
  ) {
    const placeOf = (id: string) =>
      this.db
        .select({ mailboxState: conversations.mailboxState })
        .from(conversations)
        .where(eq(conversations.id, id))
        .all()[0];

    let targetId = row.splitFrom;
    let target = targetId ? placeOf(targetId) : undefined;

    if (!target) {
      const parent = this.resolveParent(row.inReplyTo, row.references);
      targetId = parent?.conversationId ?? null;
      target = targetId ? placeOf(targetId) : undefined;
    }

    return targetId &&
      targetId !== conversationId &&
      (target?.mailboxState === "active" || target?.mailboxState === "archive")
      ? targetId
      : null;
  }

  submitOutgoing(input: NewEmail) {
    return this.state.blockConcurrencyWhile(async () => {
      if (
        input.direction !== "outgoing" ||
        input.transportState !== "unconfirmed"
      ) {
        throw new Error("Only unconfirmed outgoing messages can be submitted");
      }

      if (!input.requestFingerprint) {
        throw new Error("An outgoing request fingerprint is required");
      }

      const email = prepareOfficePreviews(input);

      if (hasPendingOfficePreviews(email)) {
        await this.scheduleAlarm(Date.now() + ALARM_WAKE_DELAY_MS);
      }

      const submission = this.db.transaction((tx): SubmitOutgoingResult => {
        const existing = tx
          .select()
          .from(emails)
          .where(eq(emails.id, email.id))
          .all()[0];

        if (existing) {
          const sameRequest =
            existing.direction === "outgoing" &&
            existing.requestFingerprint === email.requestFingerprint;

          return {
            outcome: sameRequest ? "existing" : "conflict",
            email: existing,
          };
        }

        tx.insert(emails).values(email).run();
        indexInsertedEmail(this.state.storage.sql, email.id);
        insertOfficePreviewJobs(this.state.storage.sql, email);
        recordCorrespondents(this.state.storage.sql, email);
        // A reply sent from here brings its conversation out of Spam, and
        // mail kept out of a conversation as spam rejoins it.
        this.rejoinSplitConversations([email.conversationId]);

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

  resendOutgoing(id: string) {
    return this.state.blockConcurrencyWhile(async () => {
      const result = this.db
        .update(emails)
        .set({
          transportState: "unconfirmed",
          messageIdHeader: null,
          transportError: null,
          deliveryStatusJson: [],
        })
        .where(
          and(
            eq(emails.id, id),
            eq(emails.direction, "outgoing"),
            inArray(emails.transportState, ["failed", "unconfirmed"])
          )
        )
        .returning({ id: emails.id })
        .all();

      if (!result.length) return null;
      const email = await this.deliverOutgoing(id);
      this.publishUpdate();

      return email;
    });
  }

  async seedMailbox(
    folderValues: NewFolder[],
    emailValues: NewEmail[],
    conversationValues: {
      id: string;
      mailboxState?: MailboxState;
      folderId?: string | null;
    }[] = [],
    senderValues: (typeof senders.$inferInsert)[] = []
  ) {
    this.db.transaction((tx) => {
      // Prior history first: seeded messages then add to it exactly once.
      for (const sender of senderValues) {
        tx.insert(senders).values(sender).onConflictDoNothing().run();
      }

      // Seeding sets the folder order afresh: seeded folders at their places,
      // system folders at their defaults (so a demo login undoes a reorder).
      tx.delete(systemFolderOrder).run();

      for (const folder of folderValues) {
        tx.insert(folders)
          .values(folder)
          .onConflictDoUpdate({
            target: folders.id,
            set: { sortOrder: folder.sortOrder },
          })
          .run();
      }

      for (const email of emailValues) {
        const inserted = tx
          .insert(emails)
          .values(email)
          .onConflictDoNothing()
          .returning({ id: emails.id })
          .all();

        if (!inserted.length) continue;
        indexInsertedEmail(this.state.storage.sql, email.id);
        recordCorrespondents(this.state.storage.sql, email);
      }

      for (const conversation of conversationValues) {
        tx.update(conversations)
          .set({
            mailboxState: conversation.mailboxState,
            folderId: conversation.folderId,
            stateChangedAt: isRetentionFolder(conversation.mailboxState)
              ? new Date()
              : undefined,
          })
          .where(eq(conversations.id, conversation.id))
          .run();
      }
    });
    this.recentParticipantSources = null;
    await this.syncInboxCounts();
    this.scheduleRetention();

    return { folders: folderValues.length, emails: emailValues.length };
  }

  /**
   * Demo logins start from the same safety state every time: no reports,
   * unsubscribes or trust, and only the seeded blocks.
   */
  resetDemoSafetyState(input: {
    emailIds: string[];
    blockedPatterns: { pattern: string; at: number }[];
  }) {
    const storage = this.state.storage.sql;
    this.db.transaction(() => {
      storage.exec(
        "update emails set report_label = null where id in (select value from json_each(?))",
        stringListJson(input.emailIds)
      );
      storage.exec("delete from unsubscriptions");
      storage.exec("delete from sender_feedback");
      storage.exec(
        "update senders set trusted_at = null, reported_at = null, blocked_at = null"
      );

      for (const block of input.blockedPatterns) {
        setSenderBlocked(storage, block.pattern, true, block.at);
      }
    });
    this.recentParticipantSources = null;
  }

  bulkUpdateConversations(
    conversationIds: string[],
    sourceFolderId: string,
    update: ConversationUpdate
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
    const values: (string | number | null)[] = [];

    // A custom folder is a classification inside the active Inbox
    // distribution, so assigning one also restores the conversation.
    const mailboxState = update.folderId
      ? ("active" as const)
      : update.mailboxState;

    if (mailboxState !== undefined) {
      assignments.push("mailbox_state = ?");
      values.push(mailboxState);
    }

    // Retention counts from entering Trash or Spam, not from a move within it.
    if (isRetentionFolder(mailboxState)) {
      assignments.push(
        "state_changed_at = case when mailbox_state = ? then state_changed_at else ? end"
      );
      values.push(mailboxState, Date.now());
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
    const targetPredicate =
      update.folderId === undefined ? "" : "and c.has_incoming = 1";

    const result = this.db.transaction(() => {
      // Keep the source-folder guard in the update itself so a stale shared
      // selection cannot overwrite a teammate's newer move.
      const moved = this.state.storage.sql
        .exec<{ id: string }>(
          `
      update conversations as c
      set ${assignments.join(", ")}
      where c.id in (
        select cast(value as text) from json_each(?)
      )
        and ${membership.predicate}
        ${targetPredicate}
      returning id
    `,
          ...values,
          candidatesJson,
          ...membership.bindings
        )
        .toArray();

      // Mail kept out of a conversation as spam rejoins it once moved out of Spam.
      this.rejoinSplitConversations(moved.map((row) => row.id));

      return moved;
    });

    if (result.length) {
      this.publishUpdate();

      if (isRetentionFolder(mailboxState)) this.scheduleRetention();
    }

    return result.length;
  }

  /** Deletes conversations that are all in `fromState` (Trash unless emptying Spam). */
  async permanentlyDeleteConversations(
    conversationIds: string[],
    fromState: RetentionFolder = "trash"
  ) {
    const candidates = [...new Set(conversationIds)];

    if (!candidates.length) {
      return { outcome: "not_found" as const, deletedCount: 0 };
    }

    const candidatesJson = stringListJson(candidates);

    const storedConversations = this.db
      .select({
        id: conversations.id,
        mailboxState: conversations.mailboxState,
      })
      .from(conversations)
      .where(sql`${conversations.id} in (
        select cast(value as text) from json_each(${candidatesJson})
      )`)
      .all();

    if (storedConversations.length !== candidates.length) {
      return { outcome: "not_found" as const, deletedCount: 0 };
    }

    if (
      storedConversations.some(
        (conversation) => conversation.mailboxState !== fromState
      )
    ) {
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
      )
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

    const objectKeys = [
      ...new Set(
        storedEmails.flatMap((email) => [
          ...(email.bodyHtmlR2Key ? [email.bodyHtmlR2Key] : []),
          ...(email.rawMimeR2Key ? [email.rawMimeR2Key] : []),
          ...email.attachmentsJson.flatMap((attachment) => [
            attachment.r2Key,
            ...(officePreviewExtension(attachment.filename)
              ? [officePreviewKey(attachment.r2Key)]
              : []),
          ]),
        ])
      ),
    ];

    const referencedObjectKeys = this.referencedObjectKeys(
      objectKeys,
      candidates
    );

    const ownedObjectKeys = objectKeys.filter(
      (objectKey) => !referencedObjectKeys.has(objectKey)
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
    excludedConversationIds: string[]
  ) {
    if (!objectKeys.length) return new Set<string>();

    const rows = this.state.storage.sql
      .exec<{ object_key: string }>(
        `
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
    `,
        stringListJson(objectKeys),
        stringListJson(excludedConversationIds)
      )
      .toArray();

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
    status: RecipientDeliveryStatus
  ) {
    const email = this.getEmailByMessageId(messageIdHeader);

    if (!email || email.direction !== "outgoing") return "not_found" as const;

    const existing = email.deliveryStatusJson.find(
      (item) => item.recipient === status.recipient
    );

    if (existing?.eventId === status.eventId) return "duplicate" as const;

    if (existing && existing.eventAt > status.eventAt) return "stale" as const;

    const next = [
      ...email.deliveryStatusJson.filter(
        (item) => item.recipient !== status.recipient
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
    await this.finishImport();
    // Object deletion runs first, so a delivery that keeps failing (or keeps
    // getting the alarm killed) cannot hold it back.
    await this.processObjectDeletionJobs(now);

    try {
      await this.processInboundJobs(now);
      await this.processRetention(now);
    } finally {
      // Previews of the mail just stored are queued in the same wake.
      await dispatchOfficePreviewJobs(
        this.state.storage.sql,
        this.bindings,
        this.state.id.name ?? "unknown-mailbox"
      );
      await this.scheduleRemainingWork();
    }
  }

  /**
   * One message reaches a person once: a copy from a team list is dropped when
   * the same message already arrived directly (or the reverse), and a list
   * copy of the person's own post is dropped next to the sent message.
   */
  private isDuplicateDelivery(job: PendingInbound, rawMime: ArrayBuffer) {
    const messageId = rawMessageId(rawMime);

    if (!messageId) return false;
    const existing = this.getEmailByMessageId(messageId);

    if (!existing) return false;

    return existing.direction === "incoming" || Boolean(job.listAddress);
  }

  private async processInboundJobs(now: number) {
    const jobs = this.db
      .select()
      .from(pendingInbound)
      .where(lte(pendingInbound.nextAttemptAt, new Date(now)))
      .orderBy(
        asc(pendingInbound.nextAttemptAt),
        asc(pendingInbound.receivedAt)
      )
      // MIME parsing can be memory-heavy; the next due row schedules a quick
      // follow-up, so one delivery per wake keeps peak memory bounded.
      .limit(INBOUND_ALARM_BATCH_SIZE)
      .all();

    for (const job of jobs) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one delivery at a time keeps MIME parsing's peak memory bounded
      await this.processInboundJob(job, now);
    }
  }

  private async processInboundJob(job: PendingInbound, now: number) {
    const messageId = inboundMessageId(job.id);
    const existing = this.getEmail(messageId);

    if (existing) {
      await this.finishStoredInbound(job, existing, now, false);

      return;
    }

    if (job.attempts > 0 && isPastRetryAge(job, now)) {
      // Earlier attempts ended without an outcome (the alarm was killed
      // mid-parse, say); this message is not parsed again.
      await this.storeUnparsedInbound(
        job,
        now,
        "Message processing did not finish within 24 hours"
      );

      return;
    }

    if (job.unfinishedAttempts >= MAX_UNFINISHED_INBOUND_ATTEMPTS) {
      // Processing it got the alarm killed every time: other mail goes first.
      await this.storeUnparsedInbound(
        job,
        now,
        `Message processing did not finish in ${MAX_UNFINISHED_INBOUND_ATTEMPTS} attempts`
      );

      return;
    }

    await this.recordInboundAttempt(job, now);

    try {
      const rawMime = await readInboundRawMime(this.bindings, job);

      if (this.isDuplicateDelivery(job, rawMime)) {
        this.db
          .delete(pendingInbound)
          .where(eq(pendingInbound.id, job.id))
          .run();

        return;
      }

      const prepared = await prepareInboundEmail({
        env: this.bindings,
        mailboxId: this.state.id.name ?? "unknown-mailbox",
        job,
        rawMime,
        resolveParent: (inReplyTo, references) =>
          this.resolveParent(inReplyTo, references),
      });

      const { intel, delivery, signals, screening } =
        await this.inboundSenderSignals(prepared.email, prepared.linkDomains);

      const screeningJson: EmailScreening | null = screening.block
        ? { blocked: screening.block.workspace ? "workspace" : "mailbox" }
        : null;

      const email: NewEmail = {
        ...prepared.email,
        senderIntelJson: intel,
        deliveryJson: delivery,
        screeningJson,
      };

      let classification: EmailAiClassification | null = null;
      // Blocked senders need no model.
      const skipAi = Boolean(screening.block);

      try {
        if (!skipAi) {
          classification = await this.classifyInbound(rawMime, signals);
        }
      } catch (error) {
        if (!(error instanceof EmailAiClassificationError)) throw error;
        const aiAttempts = job.aiAttempts + 1;

        if (aiAttempts < MAILBOX_AI_MAX_ATTEMPTS) {
          this.db
            .update(pendingInbound)
            .set({
              // The model failed, not the delivery: the attempt recorded
              // before parsing is given back.
              attempts: job.attempts,
              unfinishedAttempts: job.unfinishedAttempts,
              aiAttempts,
              nextAttemptAt: new Date(now + retryDelay(aiAttempts)),
            })
            .where(eq(pendingInbound.id, job.id))
            .run();
          console.error(
            `Could not classify inbound delivery ${job.id}; retrying`,
            error
          );

          return;
        }

        console.error(
          `Could not classify inbound delivery ${job.id}; delivering to Inbox`,
          error
        );
      }

      const stored = this.insertClassifiedInboundEmail(
        email,
        classification,
        this.inboundPlacement(screening, classification)
      );

      if (!stored) {
        throw new Error("Parsed inbound email was not persisted");
      }

      // After the message is stored, and never able to delay or fail it.
      this.state.waitUntil(
        this.maybeAutoReply(job, stored, rawMime).catch((error) => {
          console.error(`Auto-reply check failed for ${stored.id}`, error);
        })
      );
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

        return;
      }

      if (isPastRetryAge(job, now)) {
        const fallback = prepareUnprocessableInboundEmail({
          job,
          reason: "Message processing remained unavailable for 24 hours",
          rawMimeR2Key:
            error instanceof MissingRawMimeError ? null : job.rawObjectKey,
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
          error
        );

        return;
      }

      const attempts = job.attempts + 1;
      this.db
        .update(pendingInbound)
        .set({
          attempts,
          // This attempt ended with a failure, not a killed alarm.
          unfinishedAttempts: job.unfinishedAttempts,
          nextAttemptAt: new Date(now + retryDelay(attempts)),
        })
        .where(eq(pendingInbound.id, job.id))
        .run();
      console.error(`Could not ingest inbound delivery ${job.id}`, error);
    }
  }

  /**
   * Counts an attempt and backs the delivery off before it is parsed, and
   * makes that durable: when parsing gets the alarm killed (CPU or memory),
   * no catch runs, and the delivery must not stay first in line. The
   * attempt also counts as unfinished until a path with an outcome gives
   * that back (storing deletes the row; a failure restores the count).
   */
  private async recordInboundAttempt(job: PendingInbound, now: number) {
    const attempts = job.attempts + 1;
    const nextAttemptAt = now + retryDelay(attempts);
    this.db
      .update(pendingInbound)
      .set({
        attempts,
        unfinishedAttempts: job.unfinishedAttempts + 1,
        nextAttemptAt: new Date(nextAttemptAt),
      })
      .where(eq(pendingInbound.id, job.id))
      .run();
    // The retry's wake, in case this alarm never gets to schedule it.
    await this.scheduleAlarm(nextAttemptAt);
    this.attemptAlarmAt = nextAttemptAt;
    await this.state.storage.sync();
  }

  /**
   * Stores a delivery that is not parsed again as an unreadable message,
   * with a link to its raw MIME. The delivery is backed off first, so a
   * failure here (R2 or storage) waits its turn behind newer mail.
   */
  private async storeUnparsedInbound(
    job: PendingInbound,
    now: number,
    reason: string
  ) {
    await this.recordInboundAttempt(job, now);

    try {
      // Without an answer from R2 the link is kept: a missing object only
      // makes the download fail.
      const raw = await this.bindings.MAIL_STORAGE.head(job.rawObjectKey).then(
        (object) => object !== null,
        () => true
      );

      const fallback = prepareUnprocessableInboundEmail({
        job,
        reason,
        rawMimeR2Key: raw ? job.rawObjectKey : null,
      });

      const stored = await this.insertEmail(fallback);

      if (!stored) {
        throw new Error("Unparsed inbound fallback was not persisted");
      }

      await this.finishStoredInbound(job, stored, now, true);
      console.error(`Stored fallback for unparsed inbound delivery ${job.id}`);
    } catch (error) {
      console.error(
        `Could not store unparsed inbound delivery ${job.id}`,
        error
      );
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

    const retainedKeys = objectKeys.filter((key) =>
      referencedObjectKeys.has(key)
    );

    if (retainedKeys.length) {
      this.db
        .delete(pendingObjectDeletions)
        .where(inArray(pendingObjectDeletions.objectKey, retainedKeys))
        .run();
    }

    const deletableJobs = jobs.filter(
      (job) => !referencedObjectKeys.has(job.objectKey)
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

  /** When the earliest pending job (inbound, object deletion, Office preview) is due, or null. */
  private nextDueWork() {
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

    const officePreviewAttempt = nextOfficePreviewAttempt(
      this.state.storage.sql
    );

    const retentionAt = this.nextRetentionAt();

    const attemptTimes = [
      nextInbound,
      nextObjectDeletion,
      ...(retentionAt === null
        ? []
        : [{ nextAttemptAt: new Date(retentionAt) }]),
      ...(officePreviewAttempt === undefined
        ? []
        : [{ nextAttemptAt: new Date(officePreviewAttempt) }]),
    ].flatMap((job) => (job ? [job.nextAttemptAt.getTime()] : []));

    return attemptTimes.length > 0 ? Math.min(...attemptTimes) : null;
  }

  /**
   * Schedules the next wake for the work left. A wake set only for a parse
   * that might never finish (`recordInboundAttempt`) is replaced by the real
   * next due time, or removed when nothing is due, so a stored message does
   * not cause an empty wake. Any other alarm is only moved earlier.
   */
  private async scheduleRemainingWork() {
    const { attemptAlarmAt } = this;
    this.attemptAlarmAt = null;
    const current = await this.state.storage.getAlarm();
    // Read after the await, so nothing changes between the read and the write.
    const nextAttemptAt = this.nextDueWork();

    const wakeAt =
      nextAttemptAt === null
        ? null
        : Math.max(Date.now() + ALARM_WAKE_DELAY_MS, nextAttemptAt);

    const ownWake =
      current !== null &&
      current === attemptAlarmAt &&
      // Imported mail waits for this alarm to be announced.
      !this.state.storage.kv.get<boolean>(IMPORT_PENDING_KEY);

    if (ownWake) {
      await (wakeAt === null
        ? this.state.storage.deleteAlarm()
        : this.state.storage.setAlarm(wakeAt));
    } else if (wakeAt !== null) {
      await this.scheduleAlarm(wakeAt);
    }
  }

  private async deliverOutgoing(id: string) {
    const message = this.getEmail(id);

    if (
      !message ||
      message.direction !== "outgoing" ||
      message.transportState !== "unconfirmed"
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

      if (!failed) {
        throw new Error("Failed message was not persisted", { cause: error });
      }

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

  /** Permanently deletes one batch from Trash or Spam; callers repeat while `remaining > 0`. */
  async emptyFolder(state: RetentionFolder) {
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

    const remaining =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(conversations)
        .where(eq(conversations.mailboxState, state))
        .all()[0]?.count ?? 0;

    return { deleted: result.deletedCount, remaining };
  }

  private async processRetention(now: number) {
    for (const { state, ms } of retentionRules(this.bindings)) {
      const expired = this.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.mailboxState, state),
            lte(conversations.stateChangedAt, new Date(now - ms))
          )
        )
        .orderBy(asc(conversations.stateChangedAt))
        .limit(RETENTION_BATCH_SIZE)
        .all()
        .map((row) => row.id);

      if (expired.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Trash then Spam, one bounded batch each
        await this.permanentlyDeleteConversations(expired, state);
      }
    }
  }

  /** When the oldest Trash or Spam conversation reaches its retention limit. */
  private nextRetentionAt() {
    const due = retentionRules(this.bindings).flatMap(({ state, ms }) => {
      const oldest = this.db
        .select({ at: conversations.stateChangedAt })
        .from(conversations)
        .where(
          and(
            eq(conversations.mailboxState, state),
            isNotNull(conversations.stateChangedAt)
          )
        )
        .orderBy(asc(conversations.stateChangedAt))
        .limit(1)
        .all()[0]?.at;

      return oldest ? [oldest.getTime() + ms] : [];
    });

    return due.length > 0 ? Math.min(...due) : null;
  }

  /**
   * Call after mail enters Trash or Spam: wakes when the oldest there is due.
   * Only moves the alarm earlier, so it can run beside `scheduleRemainingWork`.
   */
  private scheduleRetention() {
    const at = this.nextRetentionAt();

    if (at === null) return;
    this.state.waitUntil(
      this.scheduleAlarm(Math.max(Date.now() + ALARM_WAKE_DELAY_MS, at))
    );
  }

  getAutoReply(): AutoReplySettings | null {
    return this.db.select().from(autoReplySettings).all()[0] ?? null;
  }

  setAutoReply(input: AutoReplyInput, userId: string) {
    const previous = this.getAutoReply();

    const settings: AutoReplySettings = {
      ...input,
      id: 1,
      updatedBy: userId,
      updatedAt: new Date(),
    };

    // Each absence starts fresh: switching on or moving the window forgets
    // who has been answered.
    const newAbsence =
      input.enabled &&
      (!previous?.enabled ||
        previous.startsAt?.getTime() !== input.startsAt?.getTime() ||
        previous.endsAt?.getTime() !== input.endsAt?.getTime());

    this.db.transaction((tx) => {
      tx.insert(autoReplySettings)
        .values(settings)
        .onConflictDoUpdate({ target: autoReplySettings.id, set: settings })
        .run();

      if (newAbsence) tx.delete(autoReplyLog).run();
    });

    return settings;
  }

  turnOffAutoReply(userId: string) {
    this.db
      .update(autoReplySettings)
      .set({ enabled: false, updatedBy: userId, updatedAt: new Date() })
      .run();

    return this.getAutoReply();
  }

  /** Whether this mailbox has written to `address` (To, Cc or Bcc). */
  private hasSentTo(address: string) {
    const needle = `"address":${JSON.stringify(address.toLowerCase())}`;

    return (
      this.db
        .select({ id: emails.id })
        .from(emails)
        .where(
          and(
            eq(emails.direction, "outgoing"),
            or(
              sql`instr(lower(${emails.toJson}), ${needle}) > 0`,
              sql`instr(lower(${emails.ccJson}), ${needle}) > 0`,
              sql`instr(lower(${emails.bccJson}), ${needle}) > 0`
            )
          )
        )
        .limit(1)
        .all().length > 0
    );
  }

  /**
   * The automatic reply to a live delivery (never an import): the message
   * for people inside the workspace or the one for everyone else. It is
   * sent, not stored, and never retried: the sender is logged before
   * sending, so a failure can't turn into a loop.
   */
  private async maybeAutoReply(
    job: PendingInbound,
    email: Email,
    rawMime: ArrayBuffer
  ) {
    const settings = this.getAutoReply();
    const now = new Date();

    if (!settings || autoReplyStatus(settings, now) !== "active") return;

    const conversation = this.db
      .select({ mailboxState: conversations.mailboxState })
      .from(conversations)
      .where(eq(conversations.id, email.conversationId))
      .all()[0];

    const mailboxId = this.state.id.name ?? "";
    const db = createDb(this.bindings.DB);

    const [mailbox, aliases] = await Promise.all([
      db
        .select({
          address: mailboxAddressSql,
          displayName: mailboxes.displayName,
        })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({
          address: mailboxAddressSql,
          displayName: mailboxes.displayName,
        })
        .from(mailboxes)
        .where(eq(mailboxes.aliasOf, mailboxId)),
    ]);

    if (!mailbox) return;

    const mailboxAddress = normalizeMailboxAddress(mailbox.address);

    if (
      messageSkipReason({
        headers: parseHeaderBlock(rawMime),
        envelopeFrom: job.envelopeFrom,
        ownAddresses: [
          mailboxAddress,
          ...aliases.map((alias) => alias.address),
        ].map((address) => address.toLowerCase()),
        listAddress: job.listAddress,
        mailboxState: conversation?.mailboxState,
        email,
      })
    ) {
      return;
    }

    const recipient = autoReplyRecipient(job.envelopeFrom);
    // One reply per sender, however they spell their address's case.
    const sender = recipient.toLowerCase();
    const inside = mailDomainAllowed(recipient);
    const message = inside ? settings.inside : settings.outside;

    if (!message.enabled) return;

    if (
      !inside &&
      settings.outside.audience === "knownSenders" &&
      !this.hasSentTo(recipient)
    ) {
      return;
    }

    const intervalMs = settings.replyIntervalDays * DAY_MS;

    const reserved = this.db.transaction((tx) => {
      tx.delete(autoReplyLog)
        .where(
          lt(autoReplyLog.lastRepliedAt, new Date(now.getTime() - intervalMs))
        )
        .run();

      if (
        tx
          .select({ sender: autoReplyLog.senderAddress })
          .from(autoReplyLog)
          .where(eq(autoReplyLog.senderAddress, sender))
          .all().length > 0
      ) {
        return false;
      }

      const lastHour =
        tx
          .select({ count: sql<number>`count(*)` })
          .from(autoReplyLog)
          .where(
            gt(autoReplyLog.lastRepliedAt, new Date(now.getTime() - 3_600_000))
          )
          .all()[0]?.count ?? 0;

      if (lastHour >= AUTO_REPLY_HOURLY_CAP) return false;

      tx.insert(autoReplyLog)
        .values({
          senderAddress: sender,
          lastRepliedAt: now,
          lastOriginalEmailId: email.id,
        })
        .run();

      return true;
    });

    if (!reserved) return;

    // Mail that came through an alias is answered from the alias.
    const from = replyAlias(email, aliases) ?? mailbox;

    try {
      const images = await Promise.all(
        inlineImages(
          autoReplyImagePrefix(mailboxId),
          message.html,
          message.images
        ).map(async (image) => {
          const object = await this.bindings.MAIL_STORAGE.get(image.r2Key);

          if (!object) throw new Error(`Image ${image.contentId} is missing`);

          return {
            contentId: image.contentId,
            filename: image.filename,
            type: image.contentType,
            content: await object.arrayBuffer(),
          };
        })
      );

      const result = await this.bindings.EMAIL.send(
        buildAutoReply({
          from: {
            address: normalizeMailboxAddress(from.address),
            name: from.displayName,
          },
          recipient,
          original: email,
          message,
          images,
        })
      );

      this.db
        .update(autoReplyLog)
        .set({ lastOutboundMessageId: result.messageId })
        .where(eq(autoReplyLog.senderAddress, sender))
        .run();
    } catch (error) {
      console.error(`Auto-reply to ${recipient} failed`, error);
    }
  }

  private async scheduleAlarm(at: number) {
    const current = await this.state.storage.getAlarm();

    if (current === null || current > at) await this.state.storage.setAlarm(at);
  }

  /**
   * Message-ID is intentionally non-unique. Ordered header arrays decide which
   * locally known copy is the parent; References fall back newest-to-oldest.
   *
   * Anyone can send mail that copies a Message-ID, so among the copies of
   * one Message-ID:
   * 1. a message this mailbox sent comes first: its Message-ID is the one
   *    the counterparty's reply names, and a stranger's copy of it must not
   *    take that reply (into Spam, say);
   * 2. then a copy whose conversation is outside Spam and Trash, so a copy
   *    in Spam is picked only when every copy is in Spam or Trash;
   * 3. then the newest.
   */
  resolveParent(inReplyTo: string[], references: string[]) {
    const candidates = [...new Set([...inReplyTo, ...references])];

    if (!candidates.length) return null;

    const rows = this.db
      .select({ email: emails, mailboxState: conversations.mailboxState })
      .from(emails)
      .leftJoin(conversations, eq(conversations.id, emails.conversationId))
      .where(inArray(emails.messageIdHeader, candidates))
      .orderBy(desc(emails.timelineAt))
      .all();

    const rank = (row: (typeof rows)[number]) =>
      (row.email.direction === "outgoing" ? 0 : 2) +
      (row.mailboxState === "spam" || row.mailboxState === "trash" ? 1 : 0);

    const byMessageId = new Map<string, (typeof rows)[number]>();

    // Rows are newest first, so a later row replaces a kept one only when it ranks better.
    for (const row of rows) {
      const messageId = row.email.messageIdHeader;

      if (!messageId) continue;
      const kept = byMessageId.get(messageId);

      if (!kept || rank(row) < rank(kept)) byMessageId.set(messageId, row);
    }

    for (const messageId of [...inReplyTo, ...references.toReversed()]) {
      const row = byMessageId.get(messageId);

      if (row) return row.email;
    }

    return null;
  }
}

export function mailboxStub(env: Env, mailboxId: string) {
  return env.MAILBOX.getByName(mailboxId);
}
