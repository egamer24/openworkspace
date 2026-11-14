import {
  oauthScope,
  zValidator,
  requireAuthWith,
  mailboxKind,
  apiError,
  createId,
  normalizeMailboxAddress,
  aiObjectRunner,
  aiFeatureEnabled,
  aiModel,
  timed,
  overRateLimit,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { attachmentPreview } from "../../shared/attachment-preview";
import {
  baseSubject,
  isComposerInlineImageContentType,
} from "../../shared/mail";
import { remoteImageUrls } from "../../shared/mail-remote";
import { MAX_TRANSLATION_CHARACTERS } from "../../shared/mail-translation";
import { officePreviewKey } from "../../shared/office-preview";
import {
  MAIL_ORGANIZE_SCOPE,
  MAIL_READ_SCOPE,
  MAIL_SEND_SCOPE,
} from "../../shared/permissions";
import { mailboxStub } from "../mailbox";
import type { MailboxDO } from "../mailbox";
import { isRetentionFolder } from "../mailbox/retention";
import type { Email } from "../mailbox/schema";
import {
  accessibleMailbox,
  accessibleMailboxes,
  mailAccessCompanion,
} from "./access";
import type { MailboxListRow } from "./access";
import { translateEmailSegments } from "./ai-translation";
import { BIMI_LOGO_HEADERS, bimiLogoPath, bimiObjectKey } from "./bimi";
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from "./conversation-cursor";
import { readStoredBody } from "./edge-cache";
import {
  headerAuthentication,
  senderIntelPending,
  withSenderIntel,
} from "./header-metadata";
import { listMailboxUsersByIds } from "./mailbox-directory";
import type { SenderHistory } from "./message-security";
import { emailListKey, emailSecurity, senderStatus } from "./message-view";
import type { MessageSafetyContext } from "./message-view";
import {
  ComposerAttachmentLimitError,
  preflightOutgoingAttachments,
} from "./outbound";
import {
  deferEmailSentWebhook,
  OutgoingRequestConflictError,
  submitOutgoing,
} from "./outbound-service";
import {
  OutgoingContextError,
  resolveForwardContext,
  resolveReplyContext,
} from "./outgoing-context";
import { participantLabels } from "./participants";
import { signR2GetUrl } from "./r2-presigned-urls";
import { signRemoteToken } from "./remote-token";
import { buildReplyPlan } from "./reply-plan";
import { mailSafetyRoutes } from "./safety-routes";
import {
  attachmentPreflightSchema,
  bulkConversationActionSchema,
  composeSchema,
  conversationListQuerySchema,
  conversationMessagesQuerySchema,
  createFolderSchema,
  createUploadSchema,
  forwardSchema,
  mailboxAiConfigurationSchema,
  mailboxQuerySchema,
  messageReadSchema,
  messageTranslationSchema,
  recipientSuggestionQuerySchema,
  renameFolderSchema,
  reorderFoldersSchema,
  retentionFolderSchema,
  replySchema,
  uploadIdSchema,
} from "./schemas";
import { cachedWorkspaceIdentity, spamhausDqsKey } from "./security-settings";
import type { WorkspaceIdentity } from "./security-settings";
import { storedSenderIntel } from "./sender-intel";
import {
  createComposerUploadIntent,
  discardComposerUploads,
  finalizeComposerUpload,
  UploadValidationError,
} from "./uploads";
import { cachedWorkspaceBlockPatterns } from "./workspace-safety";

function mediaType(contentType: string) {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * The range R2 returned. Its runtime object can carry every key of R2Range
 * with the unused ones undefined (`{ offset, length, suffix: undefined }`),
 * so it is parsed rather than narrowed with `in`.
 */
const returnedRangeSchema = z.union([
  z.object({ suffix: z.number() }),
  z.object({
    offset: z.number().optional(),
    length: z.number().optional(),
  }),
]);

function returnedObjectRange(object: R2ObjectBody, totalBytes: number) {
  if (!object.range) return { offset: 0, length: totalBytes };
  const range = returnedRangeSchema.parse(object.range);

  if ("suffix" in range) {
    const length = Math.min(range.suffix, totalBytes);

    return { offset: totalBytes - length, length };
  }

  const offset = range.offset ?? 0;
  const available = Math.max(0, totalBytes - offset);
  const length = Math.min(range.length ?? available, available);

  return { offset, length };
}

function storedObjectResponse(input: {
  object: R2ObjectBody;
  contentType: string;
  contentDisposition: string;
  totalBytes: number;
  rangeRequested: boolean;
}) {
  const { object } = input;
  const returnedRange = returnedObjectRange(object, input.totalBytes);

  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": input.contentDisposition,
    "content-length": String(returnedRange.length),
    "content-type": input.contentType,
    "x-content-type-options": "nosniff",
  });

  if (!input.rangeRequested || !object.range) {
    return new Response(object.body, { headers });
  }

  headers.set(
    "content-range",
    `bytes ${returnedRange.offset}-${returnedRange.offset + returnedRange.length - 1}/${input.totalBytes}`
  );

  return new Response(object.body, { status: 206, headers });
}

function getStoredObject(
  bucket: R2Bucket,
  key: string,
  range: string | undefined
) {
  return range
    ? bucket.get(key, { range: new Headers({ range }) })
    : bucket.get(key);
}

/** Our own route for a BIMI logo, when DMARC allowed one for this message. */
function senderLogoUrl(email: Email) {
  const bimi =
    email.direction === "incoming"
      ? storedSenderIntel(email.senderIntelJson)?.bimi
      : null;

  return bimi?.status === "ok" ? bimiLogoPath(bimi.domain) : null;
}

function toMessageSummary(email: Email) {
  const from = email.fromJson[0] ?? { address: "unknown@invalid", name: null };

  return {
    id: email.id,
    conversationId: email.conversationId,
    direction: email.direction,
    fromAddress: from.address,
    fromName: from.name,
    toAddresses: email.toJson.map((item) => item.address),
    ccAddresses: email.ccJson.map((item) => item.address),
    bccAddresses: email.bccJson.map((item) => item.address),
    replyToAddresses: email.replyToJson.map((item) => item.address),
    subject: email.subject,
    preview: email.preview,
    transportState: email.transportState,
    transportError: email.transportError,
    deliveryStatuses: email.deliveryStatusJson,
    timelineAt: email.timelineAt,
    senderLogoUrl: senderLogoUrl(email),
  };
}

/** The workspace mailing list a received copy came through, if any. */
function workspaceListAddress(email: Email) {
  return email.direction === "incoming" &&
    email.listPostAddress &&
    email.envelopeTo &&
    normalizeMailboxAddress(email.envelopeTo) === email.listPostAddress
    ? email.listPostAddress
    : null;
}

function toMessageDetail(
  email: Email,
  ownAddress: string,
  identity: WorkspaceIdentity,
  history: Record<string, SenderHistory>,
  safety: MessageSafetyContext,
  bodyHtml: string | null,
  readReceipt: {
    isRead: boolean;
    viewedBy: {
      userId: string;
      name: string;
      readAt: Date;
    }[];
  }
) {
  return {
    ...toMessageSummary(email),
    bodyText: email.bodyText,
    quotedText: email.quotedText,
    bodyHtml,
    aiClassification: email.aiClassificationJson,
    security: emailSecurity(email, identity, history, safety),
    sender: senderStatus(email, safety),
    listId: email.listId,
    viaList: workspaceListAddress(email),
    unsubscription: safety.unsubscriptions[emailListKey(email) ?? ""] ?? null,
    reported: email.reportLabel !== null,
    screening: email.screeningJson,
    senderIntel:
      email.direction === "incoming"
        ? storedSenderIntel(email.senderIntelJson)
        : null,
    hasOriginal: Boolean(email.rawMimeR2Key),
    attachments: email.attachmentsJson.map((file) => ({
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      contentId: file.contentId,
      disposition: file.disposition,
      pdfPreviewStatus: file.pdfPreviewStatus ?? null,
    })),
    replyPlan: buildReplyPlan(ownAddress, email),
    ...readReceipt,
  };
}

function conversationLabel(ownAddress: string, latest: Email) {
  const labels = participantLabels(
    [...latest.fromJson, ...latest.toJson, ...latest.ccJson],
    ownAddress
  );

  if (!labels.length) {
    return (
      latest.fromJson[0]?.name ||
      latest.fromJson[0]?.address ||
      "Unknown sender"
    );
  }

  if (labels.length <= 3) return labels.join(", ");

  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

function conversationSubject(subject: string) {
  return baseSubject(subject) || "(no subject)";
}

function outboundTransportState(email: Email) {
  if (email.transportState === "received") {
    throw new Error("Outgoing message has an inbound transport state");
  }

  return email.transportState;
}

/** Keeps `work` running after the response; failures are only logged. */
function runInBackground(c: Context<AppEnv>, work: Promise<unknown>) {
  const guarded = work.catch((error) =>
    console.error("Background work failed", error)
  );

  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (in-process calls): the promise still runs.
  }
}

function outgoingResponse(email: Email, detached: boolean) {
  return {
    ok: true as const,
    messageId: email.id,
    conversationId: email.conversationId,
    transportState: outboundTransportState(email),
    transportError: email.transportError,
    detached,
    externalizedAttachments: email.attachmentsJson.filter(
      (file) => file.delivery === "download_link"
    ).length,
  };
}

function outgoingFailure(c: Parameters<typeof apiError>[0], cause: unknown) {
  if (
    cause instanceof ComposerAttachmentLimitError ||
    cause instanceof UploadValidationError
  ) {
    return apiError(c, 400, "BAD_REQUEST", cause.message);
  }

  if (cause instanceof OutgoingRequestConflictError) {
    return apiError(c, 409, "CONFLICT", cause.message);
  }

  if (cause instanceof OutgoingContextError) {
    return apiError(c, cause.status, cause.code, cause.message);
  }

  throw cause;
}

/**
 * GET /mailboxes without `ok`. Each mailbox's `version` is the change
 * counter its `unreadCount` reflects; see `update:<version>`.
 */
export function mailboxListView(rows: MailboxListRow[]) {
  return {
    mailboxes: rows.map(
      ({ ownerUserId, isPrimary: _isPrimary, ...mailbox }) => ({
        ...mailbox,
        kind: mailboxKind(ownerUserId),
      })
    ),
  };
}

/** GET /mailboxes/:id/folders without `ok`. */
export function folderListView(view: ReturnType<MailboxDO["folderView"]>) {
  return {
    version: view.version,
    folders: view.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      kind: folder.kind,
      systemType: folder.systemType,
      /** The folder's place in the mailbox's one order; Inbox is 0. */
      sortOrder: folder.sortOrder,
      totalCount: folder.totalCount,
      unreadCount: folder.unreadCount,
      /** Days mail stays in Trash or Spam before it is deleted; null keeps it. */
      retentionDays: isRetentionFolder(folder.systemType)
        ? view.retention[folder.systemType]
        : null,
    })),
  };
}

/** GET /conversations without `ok`. */
export function conversationPageView(
  page: NonNullable<ReturnType<MailboxDO["listConversations"]>>,
  mailboxAddress: string
) {
  return {
    version: page.version,
    conversations: page.items.map((item) => ({
      ...toMessageSummary(item.email),
      subject: conversationSubject(item.email.subject),
      conversationLabel: conversationLabel(mailboxAddress, item.email),
      messageCount: item.messageCount,
      unreadCount: item.unreadCount,
      isUnread: item.unreadCount > 0,
      hasIncoming: item.hasIncoming,
    })),
    nextCursor: page.next ? encodeConversationCursor(page.next) : null,
  };
}

export const mailRoutes = new Hono<AppEnv>()
  .use("*", requireAuthWith(mailAccessCompanion))
  .get("/mailboxes", oauthScope(MAIL_READ_SCOPE), async (c) => {
    const rows = await accessibleMailboxes(c);

    return c.json({ ok: true as const, ...mailboxListView(rows) });
  })
  .get("/mailboxes/:id/realtime", oauthScope(MAIL_READ_SCOPE), async (c) => {
    if (c.get("authKind") !== "session") {
      return apiError(
        c,
        401,
        "UNAUTHORIZED",
        "A browser session is required for realtime updates"
      );
    }

    const origin = c.req.header("origin");

    if (!origin || origin !== new URL(c.req.url).origin) {
      return apiError(c, 403, "FORBIDDEN", "Cross-origin WebSocket rejected");
    }

    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return apiError(c, 426, "UPGRADE_REQUIRED", "WebSocket upgrade required");
    }

    const mailboxId = c.req.param("id");
    const user = c.get("user");

    if (!(await accessibleMailbox(c, mailboxId, "read"))) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set("x-openworkspace-user-id", user.id);
    headers.set("x-openworkspace-session-id", c.get("sessionId"));
    headers.set(
      "x-openworkspace-session-token-hash",
      c.get("sessionTokenHash")
    );
    headers.set(
      "x-openworkspace-visibility",
      c.req.query("visibility") === "hidden" ? "hidden" : "visible"
    );

    return mailboxStub(c.env, mailboxId).fetch(
      new Request(c.req.raw, { headers })
    );
  })
  .post(
    "/uploads",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", createUploadSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const body = c.req.valid("json");
      const user = c.get("user");
      const access = await accessibleMailbox(c, mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      const rateExceeded = await overRateLimit(
        c,
        "RATE_LIMIT_30",
        "mail-upload",
        user.id
      );

      if (rateExceeded) {
        return apiError(c, 429, "RATE_LIMITED", "Too many attachment uploads");
      }

      try {
        const upload = await createComposerUploadIntent({
          env: c.env,
          mailboxId,
          userId: user.id,
          filename: body.filename,
          contentType: body.contentType,
          size: body.size,
        });

        return c.json({ ok: true as const, upload }, 201);
      } catch (error) {
        return outgoingFailure(c, error);
      }
    }
  )
  .post(
    "/uploads/:id/complete",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("param", z.object({ id: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const { id: uploadId } = c.req.valid("param");
      const user = c.get("user");
      const access = await accessibleMailbox(c, mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      try {
        const upload = await finalizeComposerUpload({
          env: c.env,
          mailboxId,
          userId: user.id,
          uploadId,
          defer: (task) => c.executionCtx.waitUntil(task),
        });

        return c.json({ ok: true as const, upload });
      } catch (error) {
        return outgoingFailure(c, error);
      }
    }
  )
  .delete(
    "/uploads/:id",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("param", z.object({ id: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c, mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      const { id: uploadId } = c.req.valid("param");
      await discardComposerUploads({
        env: c.env,
        mailboxId,
        userId: user.id,
        uploadIds: [uploadId],
      });

      return c.json({ ok: true as const });
    }
  )
  .get(
    "/mailboxes/:id/recipient-suggestions",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", recipientSuggestionQuerySchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      const access = await accessibleMailbox(c, mailboxId, "read");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const query = c.req.valid("query");

      return c.json({
        ok: true as const,
        suggestions: await mailboxStub(c.env, mailboxId).suggestRecipients(
          access.address,
          query.q,
          query.limit
        ),
      });
    }
  )
  .get("/mailboxes/:id/folders", oauthScope(MAIL_READ_SCOPE), async (c) => {
    const mailboxId = c.req.param("id");
    const access = await accessibleMailbox(c, mailboxId, "read");

    if (!access) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }

    const view = await timed(c, "do", "folders", () =>
      mailboxStub(c.env, mailboxId).folderView(c.get("user").id)
    );

    return c.json({ ok: true as const, ...folderListView(view) });
  })
  .get("/mailboxes/:id/ai", oauthScope(MAIL_READ_SCOPE), async (c) => {
    const mailboxId = c.req.param("id");

    if (!(await accessibleMailbox(c, mailboxId, "read"))) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }

    return c.json({
      ok: true as const,
      settings: await mailboxStub(c.env, mailboxId).getMailboxAiSettings(),
    });
  })
  .put(
    "/mailboxes/:id/ai",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", mailboxAiConfigurationSchema),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      return c.json({
        ok: true as const,
        settings: await mailboxStub(c.env, mailboxId).setMailboxAiConfiguration(
          c.req.valid("json")
        ),
      });
    }
  )
  .post(
    "/mailboxes/:id/folders/:folder/empty",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator(
      "param",
      z.object({ id: z.string(), folder: retentionFolderSchema })
    ),
    async (c) => {
      const { id: mailboxId, folder } = c.req.valid("param");

      if (!(await accessibleMailbox(c, mailboxId, "send"))) {
        return apiError(
          c,
          403,
          "FORBIDDEN",
          "Send access is required to delete conversations permanently"
        );
      }

      const result = await mailboxStub(c.env, mailboxId).emptyFolder(folder);

      return c.json({ ok: true as const, ...result });
    }
  )
  .post(
    "/mailboxes/:id/folders",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", createFolderSchema),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const result = await mailboxStub(c.env, mailboxId).createFolder(
        createId("fld"),
        c.req.valid("json").name
      );

      if (result.status === "conflict") {
        return apiError(c, 409, "CONFLICT", "Folder name already exists");
      }

      if (result.status === "limit") {
        return apiError(c, 409, "CONFLICT", "Mailbox folder limit reached");
      }

      if (result.status === "invalid") {
        return apiError(c, 400, "BAD_REQUEST", "Folder name is invalid");
      }

      return c.json({ ok: true as const, folder: result.folder }, 201);
    }
  )
  .put(
    "/mailboxes/:id/folders/order",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", reorderFoldersSchema),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const result = await mailboxStub(c.env, mailboxId).reorderFolders(
        c.req.valid("json").folderIds
      );

      if (result.status === "conflict") {
        return apiError(
          c,
          409,
          "CONFLICT",
          "Folders changed; refresh and try again"
        );
      }

      return c.json({ ok: true as const });
    }
  )
  .patch(
    "/mailboxes/:id/folders/:folderId",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", renameFolderSchema),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const result = await mailboxStub(c.env, mailboxId).renameFolder(
        c.req.param("folderId"),
        c.req.valid("json").name
      );

      if (result.status === "not_found") {
        return apiError(c, 404, "NOT_FOUND", "Folder not found");
      }

      if (result.status === "conflict") {
        return apiError(c, 409, "CONFLICT", "Folder name already exists");
      }

      if (result.status === "invalid") {
        return apiError(c, 400, "BAD_REQUEST", "Folder name is invalid");
      }

      return c.json({ ok: true as const, folder: result.folder });
    }
  )
  .delete(
    "/mailboxes/:id/folders/:folderId",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const result = await mailboxStub(c.env, mailboxId).deleteFolder(
        c.req.param("folderId")
      );

      if (result.status === "not_found") {
        return apiError(c, 404, "NOT_FOUND", "Folder not found");
      }

      return c.json({ ok: true as const });
    }
  )
  .get(
    "/conversations",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", conversationListQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const access = await accessibleMailbox(c, query.mailboxId, "read");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const cursor = query.cursor
        ? decodeConversationCursor(query.cursor)
        : null;

      if (query.cursor && !cursor) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Conversation cursor is invalid"
        );
      }

      const page = await timed(c, "do", "conversations", () =>
        mailboxStub(c.env, query.mailboxId).listConversations(
          c.get("user").id,
          query.folder,
          query.limit,
          cursor,
          query.search,
          query.unreadOnly === "true"
        )
      );

      if (!page) return apiError(c, 404, "NOT_FOUND", "Folder not found");

      return c.json({
        ok: true as const,
        ...conversationPageView(page, access.address),
      });
    }
  )
  .patch(
    "/conversations/bulk",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", bulkConversationActionSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c, mailboxId, "read");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const input = c.req.valid("json");
      const stub = mailboxStub(c.env, mailboxId);

      if (input.type === "read") {
        const updatedCount = await stub.bulkSetConversationRead(
          user.id,
          input.conversationIds,
          input.isRead
        );

        return c.json({ ok: true as const, updatedCount });
      }

      if (input.type === "update") {
        const updatedCount = await stub.bulkUpdateConversations(
          input.conversationIds,
          input.sourceFolderId,
          input.update
        );

        if (updatedCount === null) {
          return apiError(
            c,
            404,
            "NOT_FOUND",
            "Source or target folder not found"
          );
        }

        return c.json({ ok: true as const, updatedCount });
      }

      if (!access.canSend) {
        return apiError(
          c,
          403,
          "FORBIDDEN",
          "Send access is required to delete conversations permanently"
        );
      }

      const result = await stub.permanentlyDeleteConversations(
        input.conversationIds
      );

      if (result.outcome === "not_found") {
        return apiError(c, 404, "NOT_FOUND", "Conversations not found");
      }

      if (result.outcome === "not_in_trash") {
        return apiError(
          c,
          409,
          "CONFLICT",
          "Only conversations in Trash can be deleted permanently"
        );
      }

      return c.json({
        ok: true as const,
        updatedCount: result.deletedCount,
      });
    }
  )
  .get(
    "/conversations/:id",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", conversationMessagesQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const { mailboxId } = query;
      const currentUserId = c.get("user").id;
      const access = await accessibleMailbox(c, mailboxId, "read");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const cursor = query.cursor
        ? decodeConversationCursor(query.cursor)
        : null;

      if (query.cursor && !cursor) {
        return apiError(c, 400, "BAD_REQUEST", "Message cursor is invalid");
      }

      const mailbox = mailboxStub(c.env, mailboxId);

      // Workspace-wide inputs come from this isolate's cache when it has them,
      // and otherwise load from D1 alongside the mailbox call.
      const workspace = timed(c, "d1", "workspace", () =>
        Promise.all([
          cachedWorkspaceIdentity(c.env.DB),
          cachedWorkspaceBlockPatterns(c.env.DB),
        ])
      );

      workspace.catch(() => undefined);

      const view = await timed(c, "do", "conversation", () =>
        mailbox.getConversationView(
          c.req.param("id"),
          currentUserId,
          query.limit,
          cursor
        )
      );

      if (!view) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
      const self = c.get("user");

      const otherReaderIds = [
        ...new Set(view.readStates.map((readState) => readState.userId)),
      ].filter((userId) => userId !== currentUserId);

      const [readers, [identity, workspaceBlocks], bodies] = await Promise.all([
        otherReaderIds.length
          ? timed(c, "d1", "readers", () =>
              listMailboxUsersByIds(c.env.DB, mailboxId, otherReaderIds)
            )
          : [],
        workspace,
        Promise.all(
          view.messages.map((stored) =>
            stored.bodyHtmlR2Key
              ? readStoredBody(c, stored.bodyHtmlR2Key)
              : null
          )
        ),
      ]);

      /** One proxy token per remote image URL in the HTML (remote-token.ts). */
      const remoteTokens = async (bodyHtml: string) =>
        Object.fromEntries(
          await Promise.all(
            remoteImageUrls(bodyHtml).map(
              async (url) =>
                [
                  url,
                  await signRemoteToken(
                    c.env.MAIL_REMOTE_KEY,
                    currentUserId,
                    mailboxId,
                    url
                  ),
                ] as const
            )
          )
        );

      const readerById = new Map([
        [self.id, { id: self.id, name: self.name }],
        ...readers.map((reader) => [reader.id, reader] as const),
      ]);

      const readStatesByEmail = new Map<string, typeof view.readStates>();

      for (const readState of view.readStates) {
        const states = readStatesByEmail.get(readState.emailId) ?? [];
        states.push(readState);
        readStatesByEmail.set(readState.emailId, states);
      }

      const safety: MessageSafetyContext = { ...view.safety, workspaceBlocks };

      const intelContext = (bodyHtml: string | null) => ({
        bodyHtml,
        workspaceDomains: identity.domains,
        dqsKey: spamhausDqsKey(c.env),
      });

      // The browser gets the conversation at once and the sender lookups
      // (DNS, up to SENDER_INTEL_BUDGET_MS) from a follow-up request, while
      // they run here in the background; other clients get them inline.
      const inline = c.get("authKind") !== "session";
      const now = Date.now();

      const messages = await Promise.all(
        view.messages.map(async (stored, index) => {
          const bodyHtml = bodies[index] ?? null;
          let email = stored;
          let intelPending = false;

          if (senderIntelPending(stored, now)) {
            if (inline) {
              email = await timed(c, "intel", "sender", () =>
                withSenderIntel(c.env, mailbox, stored, intelContext(bodyHtml))
              );
            } else {
              intelPending = true;
              runInBackground(
                c,
                withSenderIntel(c.env, mailbox, stored, intelContext(bodyHtml))
              );
            }
          }

          const readStates = readStatesByEmail.get(email.id) ?? [];

          return {
            ...toMessageDetail(
              email,
              access.address,
              identity,
              view.history,
              safety,
              bodyHtml,
              {
                isRead: readStates.some(
                  (readState) => readState.userId === currentUserId
                ),
                viewedBy: readStates.flatMap((readState) => {
                  const reader = readerById.get(readState.userId);

                  return reader
                    ? [
                        {
                          userId: reader.id,
                          name: reader.name,
                          readAt: readState.readAt,
                        },
                      ]
                    : [];
                }),
              }
            ),
            /**
             * Sender lookups are still running: `security` lacks their
             * blocklist warnings until GET /messages/:id/sender-intel answers.
             */
            senderIntelPending: intelPending,
            /**
             * For each remote image URL in `bodyHtml`, the token it is
             * proxied with (GET /api/mail/remote); an image without one is
             * not shown (remote-token.ts).
             */
            remoteTokens: bodyHtml ? await remoteTokens(bodyHtml) : null,
          };
        })
      );

      return c.json({
        ok: true as const,
        version: view.version,
        mailboxState: view.mailboxState,
        folderId: view.folderId,
        hasIncoming: view.hasIncoming,
        hasOutgoing: view.hasOutgoing,
        messageCount: view.messageCount,
        unreadCount: view.unreadCount,
        nextCursor: view.next ? encodeConversationCursor(view.next) : null,
        messages,
      });
    }
  )
  .get(
    "/messages/:id/sender-intel",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const mailbox = mailboxStub(c.env, mailboxId);

      const workspace = timed(c, "d1", "workspace", () =>
        Promise.all([
          cachedWorkspaceIdentity(c.env.DB),
          cachedWorkspaceBlockPatterns(c.env.DB),
        ])
      );

      workspace.catch(() => undefined);

      const view = await timed(c, "do", "message", () =>
        mailbox.getMessageSenderView(c.req.param("id"))
      );

      if (!view || view.email.direction !== "incoming") {
        return apiError(c, 404, "NOT_FOUND", "Message not found");
      }

      const stored = view.email;

      const [[identity, workspaceBlocks], bodyHtml] = await Promise.all([
        workspace,
        senderIntelPending(stored) && stored.bodyHtmlR2Key
          ? readStoredBody(c, stored.bodyHtmlR2Key)
          : null,
      ]);

      // Joins the lookup the conversation request started in this isolate.
      const email = await timed(c, "intel", "sender", () =>
        withSenderIntel(c.env, mailbox, stored, {
          bodyHtml,
          workspaceDomains: identity.domains,
          dqsKey: spamhausDqsKey(c.env),
        })
      );

      const safety: MessageSafetyContext = { ...view.safety, workspaceBlocks };

      return c.json({
        ok: true as const,
        senderIntel: storedSenderIntel(email.senderIntelJson),
        senderIntelPending: false,
        security: emailSecurity(email, identity, view.history, safety),
        sender: senderStatus(email, safety),
        senderLogoUrl: senderLogoUrl(email),
      });
    }
  )
  .patch(
    "/messages/:id/read",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", messageReadSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const version = await timed(c, "do", "read", async () => {
        const updated = await mailboxStub(c.env, mailboxId).setMessageRead(
          user.id,
          c.req.param("id"),
          c.req.valid("json").isRead
        );

        return updated ? updated.version : null;
      });

      if (version === null) {
        return apiError(c, 404, "NOT_FOUND", "Message not found");
      }

      return c.json({ ok: true as const, version });
    }
  )
  .post(
    "/messages/:id/translate",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", messageTranslationSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const userId = c.get("user").id;

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const model = aiFeatureEnabled("translation")
        ? await aiModel(c.env, "translation")
        : null;

      if (!model) {
        return apiError(
          c,
          409,
          "CONFLICT",
          "Translation is not configured for this workspace"
        );
      }

      const limitExceeded = await overRateLimit(
        c,
        "RATE_LIMIT_20",
        "mail-translation",
        userId
      );

      if (limitExceeded) {
        return apiError(
          c,
          429,
          "RATE_LIMITED",
          "Too many translation requests"
        );
      }

      const message = await mailboxStub(c.env, mailboxId).getEmail(
        c.req.param("id")
      );

      if (!message) return apiError(c, 404, "NOT_FOUND", "Message not found");
      const { language, segments } = c.req.valid("json");

      if (segments.join("").length > MAX_TRANSLATION_CHARACTERS) {
        return apiError(
          c,
          422,
          "BAD_REQUEST",
          "Message is too long to translate"
        );
      }

      try {
        const translations = await translateEmailSegments({
          segments,
          language,
          run: aiObjectRunner(model),
        });

        return c.json({ ok: true as const, translations });
      } catch {
        return apiError(
          c,
          502,
          "BAD_GATEWAY",
          "Could not translate this message"
        );
      }
    }
  )
  .get(
    "/messages/:messageId/authentication",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const access = await accessibleMailbox(c, mailboxId, "read");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const mailbox = mailboxStub(c.env, mailboxId);
      const stored = await mailbox.getEmail(c.req.param("messageId"));

      if (!stored?.rawMimeR2Key || stored.direction !== "incoming") {
        return apiError(c, 404, "NOT_FOUND", "Original message not found");
      }

      const message = stored;
      const from = message.fromJson[0]?.address ?? "";

      const [identity, history] = await Promise.all([
        cachedWorkspaceIdentity(c.env.DB),
        mailbox.getSenderHistory(from ? [from] : []),
      ]);

      return c.json({
        ok: true as const,
        original: {
          subject: message.subject,
          from: message.fromJson[0]?.address ?? "unknown@invalid",
          to: message.toJson.map((recipient) => recipient.address),
          messageId: message.messageIdHeader,
          receivedAt: message.timelineAt.toISOString(),
          envelopeFrom: message.envelopeFrom,
          envelopeTo: message.envelopeTo,
        },
        authentication: headerAuthentication(message),
        security: emailSecurity(message, identity, history),
        senderIntel: storedSenderIntel(message.senderIntelJson),
      });
    }
  )
  .get("/bimi/:domain", oauthScope(MAIL_READ_SCOPE), async (c) => {
    const domain = c.req.param("domain").toLocaleLowerCase();

    if (
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(
        domain
      )
    ) {
      return apiError(c, 400, "BAD_REQUEST", "Domain is invalid");
    }

    const object = await c.env.MAIL_STORAGE.get(bimiObjectKey(domain));

    if (
      !object ||
      object.customMetadata?.status !== "ok" ||
      object.size === 0
    ) {
      return apiError(c, 404, "NOT_FOUND", "No logo for this domain");
    }

    return new Response(object.body, { headers: BIMI_LOGO_HEADERS });
  })
  .get(
    "/messages/:messageId/original",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const message = await mailboxStub(c.env, mailboxId).getEmail(
        c.req.param("messageId")
      );

      if (!message?.rawMimeR2Key) {
        return apiError(c, 404, "NOT_FOUND", "Original message not found");
      }

      const requestedRange = c.req.header("range");

      const object = await getStoredObject(
        c.env.MAIL_STORAGE,
        message.rawMimeR2Key,
        requestedRange
      );

      if (!object) {
        return apiError(c, 404, "NOT_FOUND", "Original message is missing");
      }

      return storedObjectResponse({
        object,
        contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(`${message.id}.eml`)}`,
        contentType: "text/plain; charset=utf-8",
        totalBytes: object.size,
        rangeRequested: Boolean(requestedRange),
      });
    }
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId")
      );

      if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
      const requestedRange = c.req.header("range");

      const object = await getStoredObject(
        c.env.MAIL_STORAGE,
        file.r2Key,
        requestedRange
      );

      if (!object) {
        return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
      }

      return storedObjectResponse({
        object,
        contentType: file.contentType,
        contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        totalBytes: file.size,
        rangeRequested: Boolean(requestedRange),
      });
    }
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId/preview",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId")
      );

      if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
      const preview = attachmentPreview(file);

      if (!preview) {
        return apiError(
          c,
          422,
          "BAD_REQUEST",
          "Preview is not available for this file"
        );
      }

      if (file.pdfPreviewStatus === "pending") {
        return apiError(c, 409, "NOT_READY", "Preview is being generated");
      }

      if (file.pdfPreviewStatus === "failed") {
        return apiError(
          c,
          422,
          "UNAVAILABLE",
          "Preview could not be generated"
        );
      }

      const requestedRange = c.req.header("range");

      const previewKey =
        file.pdfPreviewStatus === "ready"
          ? officePreviewKey(file.r2Key)
          : file.r2Key;

      const object = await getStoredObject(
        c.env.MAIL_STORAGE,
        previewKey,
        requestedRange
      );

      if (!object) {
        return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
      }

      const response = storedObjectResponse({
        object,
        contentType: preview.contentType,
        contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.pdfPreviewStatus === "ready" ? `${file.filename}.pdf` : file.filename)}`,
        totalBytes: object.size,
        rangeRequested: Boolean(requestedRange),
      });

      response.headers.set("cross-origin-resource-policy", "same-origin");
      response.headers.set("content-security-policy", "frame-ancestors 'self'");

      return response;
    }
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId/download-url",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId")
      );

      if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");

      if (!(await c.env.MAIL_STORAGE.head(file.r2Key))) {
        return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
      }

      const download = await signR2GetUrl({
        env: c.env,
        r2Key: file.r2Key,
      });

      return c.json({
        ok: true as const,
        attachment: {
          id: file.id,
          filename: file.filename,
          contentType: file.contentType,
          size: file.size,
          url: download.url,
          expiresAt: download.expiresAt,
        },
      });
    }
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId/inline",
    oauthScope(MAIL_READ_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId")
      );

      const contentType = file ? mediaType(file.contentType) : "";

      if (!file?.contentId || !isComposerInlineImageContentType(contentType)) {
        return apiError(c, 404, "NOT_FOUND", "Inline image not found");
      }

      const object = await c.env.MAIL_STORAGE.get(file.r2Key);

      if (!object) {
        return apiError(c, 404, "NOT_FOUND", "Inline image data is missing");
      }

      return new Response(object.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          "content-type": contentType,
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        },
      });
    }
  )
  .post(
    "/messages/:id/send-again",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const access = await accessibleMailbox(c, mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      const stub = mailboxStub(c.env, mailboxId);
      const message = await stub.getEmail(c.req.param("id"));

      if (!message || message.direction !== "outgoing") {
        return apiError(c, 404, "NOT_FOUND", "Outgoing message not found");
      }

      const resent = await stub.resendOutgoing(message.id);

      if (!resent) {
        return apiError(
          c,
          409,
          "CONFLICT",
          "Only failed or unconfirmed messages can be sent again"
        );
      }

      deferEmailSentWebhook({
        env: c.env,
        mailboxId,
        email: resent,
        defer: (task) => c.executionCtx.waitUntil(task),
      });

      return c.json({
        ok: true as const,
        messageId: resent.id,
        transportState: outboundTransportState(resent),
        transportError: resent.transportError,
      });
    }
  )
  .post(
    "/attachment-preflight",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("json", attachmentPreflightSchema),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");
      const access = await accessibleMailbox(c, input.mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      const rateExceeded = await overRateLimit(
        c,
        "RATE_LIMIT_120",
        "mail-attachment-preflight",
        `${user.id}:${input.mailboxId}`
      );

      if (rateExceeded) {
        return apiError(c, 429, "RATE_LIMITED", "Too many attachment checks");
      }

      try {
        let subject = input.kind === "compose" ? input.subject : "";
        let related: Email | null = null;
        let forwarded: Email | null = null;
        let includeRelatedContext = false;

        if (input.kind === "forward") {
          const context = await resolveForwardContext({
            env: c.env,
            mailboxId: input.mailboxId,
            sourceEmailId: input.sourceEmailId,
          });

          forwarded = context.source;
          subject = context.subject;
        } else if (input.kind === "reply") {
          const context = await resolveReplyContext({
            env: c.env,
            mailboxId: input.mailboxId,
            ownAddress: access.address,
            sourceEmailId: input.sourceEmailId,
            mode: input.mode,
            cc: input.cc,
            bcc: input.bcc,
          });

          related = context.source;
          subject = context.subject;
          includeRelatedContext = context.includeRelatedContext;
        }

        const result = await preflightOutgoingAttachments({
          env: c.env,
          compose: {
            mailboxId: input.mailboxId,
            userId: user.id,
            subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            attachments: input.attachments,
          },
          related,
          forwarded,
          includeRelatedContext,
        });

        return c.json({ ok: true as const, ...result });
      } catch (error) {
        return outgoingFailure(c, error);
      }
    }
  )
  .post(
    "/messages",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("json", composeSchema),
    async (c) => {
      const input = c.req.valid("json");
      const access = await accessibleMailbox(c, input.mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      try {
        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            ...input,
            userId: c.get("user").id,
          },
          conversationId: createId("conv"),
          related: null,
          forwarded: null,
          includeRelatedContext: false,
          fromAddress: access.address,
          fromName: access.displayName,
          defer: (task) => c.executionCtx.waitUntil(task),
        });

        return c.json(
          outgoingResponse(submission.email, false),
          submission.inserted ? 201 : 200
        );
      } catch (error) {
        return outgoingFailure(c, error);
      }
    }
  )
  .post(
    "/messages/:id/replies",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("json", replySchema),
    async (c) => {
      const input = c.req.valid("json");
      const access = await accessibleMailbox(c, input.mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      try {
        const context = await resolveReplyContext({
          env: c.env,
          mailboxId: input.mailboxId,
          ownAddress: access.address,
          sourceEmailId: c.req.param("id"),
          mode: input.mode,
          cc: input.cc,
          bcc: input.bcc,
        });

        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            requestId: input.requestId,
            mailboxId: input.mailboxId,
            userId: c.get("user").id,
            ...context.recipients,
            subject: context.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            attachments: input.attachments,
          },
          conversationId: context.detached
            ? createId("conv")
            : context.source.conversationId,
          related: context.source,
          forwarded: null,
          includeRelatedContext: context.includeRelatedContext,
          fromAddress: access.address,
          fromName: access.displayName,
          defer: (task) => c.executionCtx.waitUntil(task),
        });

        return c.json(
          outgoingResponse(submission.email, context.detached),
          submission.inserted ? 201 : 200
        );
      } catch (error) {
        return outgoingFailure(c, error);
      }
    }
  )
  .post(
    "/messages/:id/forward",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("json", forwardSchema),
    async (c) => {
      const input = c.req.valid("json");
      const access = await accessibleMailbox(c, input.mailboxId, "send");

      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }

      try {
        const context = await resolveForwardContext({
          env: c.env,
          mailboxId: input.mailboxId,
          sourceEmailId: c.req.param("id"),
        });

        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            ...input,
            userId: c.get("user").id,
            subject: context.subject,
          },
          conversationId: createId("conv"),
          related: null,
          forwarded: context.source,
          includeRelatedContext: false,
          fromAddress: access.address,
          fromName: access.displayName,
          defer: (task) => c.executionCtx.waitUntil(task),
        });

        return c.json(
          outgoingResponse(submission.email, false),
          submission.inserted ? 201 : 200
        );
      } catch (error) {
        return outgoingFailure(c, error);
      }
    }
  )
  .route("/", mailSafetyRoutes);
