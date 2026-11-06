import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { attachmentPreview } from "../../shared/attachment-preview";
import { officePreviewKey } from "../../shared/office-preview";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  baseSubject,
  isComposerInlineImageContentType,
} from "../../shared/mail";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import { domains, mailboxMembers, mailboxes } from "../db/schema";
import {
  mailboxAddressSql,
  mailboxKind,
  mailboxKindOrderSql,
} from "../db/mailboxes";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import { getMailboxAccess } from "./access";
import { globalAiProcessingEnabled } from "../ai/configuration";
import { MAILBOX_AI_MODEL } from "./ai-classification";
import { MAX_TRANSLATION_CHARACTERS } from "../../shared/mail-translation";
import { translateEmailSegments } from "./ai-translation";
import { listMailboxUsersByIds } from "./mailbox-directory";
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from "./conversation-cursor";
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
import { buildReplyPlan } from "./reply-plan";
import {
  CLOUDFLARE_EMAIL_ANALYTICS_RETENTION_MS,
  fetchCloudflareEmailAuthentication,
} from "./email-authentication";
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
  remoteProxyQuerySchema,
  reorderFoldersSchema,
  replySchema,
  uploadIdSchema,
} from "./schemas";
import {
  assertProxyableRemoteUrl,
  fetchProxiedRemoteMedia,
} from "./remote-proxy";
import { checkRateLimit } from "../lib/rate-limit";
import {
  createComposerUploadIntent,
  DirectUploadUnavailableError,
  discardComposerUploads,
  finalizeComposerUpload,
  storeComposerUploadContent,
  UploadValidationError,
} from "./uploads";
import { signR2GetUrl } from "./r2-presigned-urls";

function mediaType(contentType: string) {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function requestContentLength(value: string | undefined) {
  return value === undefined ? undefined : Number(value);
}

function returnedObjectRange(object: R2ObjectBody, totalBytes: number) {
  if (!object.range) return { offset: 0, length: totalBytes };
  const suffix = "suffix" in object.range ? object.range.suffix : undefined;
  if (typeof suffix === "number") {
    const length = Math.min(suffix, totalBytes);
    return { offset: totalBytes - length, length };
  }

  const offset = "offset" in object.range ? object.range.offset ?? 0 : 0;
  const available = Math.max(0, totalBytes - offset);
  const requestedLength = "length" in object.range
    ? object.range.length
    : undefined;
  const length = Math.min(requestedLength ?? available, available);
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
    `bytes ${returnedRange.offset}-${returnedRange.offset + returnedRange.length - 1}/${input.totalBytes}`,
  );
  return new Response(object.body, { status: 206, headers });
}

function getStoredObject(
  bucket: R2Bucket,
  key: string,
  range: string | undefined,
) {
  return range
    ? bucket.get(key, { range: new Headers({ range }) })
    : bucket.get(key);
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
  };
}

function toMessageDetail(
  email: Email,
  ownAddress: string,
  bodyHtml: string | null,
  readReceipt: {
    isRead: boolean;
    viewedBy: Array<{
      userId: string;
      name: string;
      readAt: Date;
    }>;
  },
) {
  return {
    ...toMessageSummary(email),
    bodyText: email.bodyText,
    quotedText: email.quotedText,
    bodyHtml,
    aiClassification: email.aiClassificationJson,
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
    ownAddress,
  );
  if (!labels.length) return latest.fromJson[0]?.name || latest.fromJson[0]?.address || "Unknown sender";
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

async function accessibleMailbox(
  env: Env,
  userId: string,
  mailboxId: string,
  permission: "read" | "send",
) {
  const access = await getMailboxAccess(createDb(env.DB), userId, mailboxId);
  if (!access || (permission === "send" && !access.canSend)) return null;
  return access;
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
      (file) => file.delivery === "download_link",
    ).length,
  };
}

function outgoingFailure(
  c: Parameters<typeof apiError>[0],
  error: unknown,
) {
  if (error instanceof DirectUploadUnavailableError) {
    return apiError(c, 503, "UNAVAILABLE", error.message);
  }
  if (
    error instanceof ComposerAttachmentLimitError
    || error instanceof UploadValidationError
  ) {
    return apiError(c, 400, "BAD_REQUEST", error.message);
  }
  if (error instanceof OutgoingRequestConflictError) {
    return apiError(c, 409, "CONFLICT", error.message);
  }
  if (error instanceof OutgoingContextError) {
    return apiError(c, error.status, error.code, error.message);
  }
  throw error;
}

export const mailRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/mailboxes", async (c) => {
    const userId = c.get("user").id;
    const rows = await createDb(c.env.DB)
      .select({
        id: mailboxes.id,
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
        ownerUserId: mailboxes.ownerUserId,
        isPrimary: mailboxes.isPrimary,
        canSend: mailboxMembers.canSend,
      })
      .from(mailboxMembers)
      .innerJoin(mailboxes, eq(mailboxMembers.mailboxId, mailboxes.id))
      .innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .where(eq(mailboxMembers.userId, userId))
      .orderBy(
        mailboxKindOrderSql,
        desc(mailboxes.isPrimary),
        mailboxes.displayName,
      );

    const rowsWithUnreadCounts = await Promise.all(rows.map(async (mailbox) => {
      const stub = mailboxStub(c.env, mailbox.id);
      const [inbox, autoReply] = await Promise.all([
        stub.getFolderCounts(userId, "inbox"),
        mailbox.canSend ? stub.autoReplyState() : null,
      ]);
      const { ownerUserId, isPrimary: _isPrimary, ...publicMailbox } = mailbox;
      return {
        ...publicMailbox,
        kind: mailboxKind(ownerUserId),
        unreadCount: inbox?.unreadCount ?? 0,
        autoReply,
      };
    }));

    return c.json({ ok: true as const, mailboxes: rowsWithUnreadCounts });
  })
  .get("/mailboxes/:id/realtime", async (c) => {
    if (c.get("authKind") !== "session") {
      return apiError(
        c,
        401,
        "UNAUTHORIZED",
        "A browser session is required for realtime updates",
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
    if (!await accessibleMailbox(c.env, user.id, mailboxId, "read")) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-openworkspace-user-id", user.id);
    headers.set("x-openworkspace-session-id", c.get("sessionId"));
    headers.set("x-openworkspace-session-token-hash", c.get("sessionTokenHash"));
    headers.set(
      "x-openworkspace-visibility",
      c.req.query("visibility") === "hidden" ? "hidden" : "visible",
    );
    return mailboxStub(c.env, mailboxId).fetch(
      new Request(c.req.raw, { headers }),
    );
  })
  .post(
    "/uploads",
    zValidator(
      "query",
      mailboxQuerySchema.extend({
        directOnly: z.literal("true").optional(),
      }),
    ),
    zValidator("json", createUploadSchema),
    async (c) => {
      const { mailboxId, directOnly } = c.req.valid("query");
      const body = c.req.valid("json");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
      if (!access) return apiError(c, 403, "FORBIDDEN", "Send access is required");

      const rate = await checkRateLimit(c.env.DB, {
        action: "mail-upload",
        identifier: user.id,
        limit: 30,
        windowMs: 60_000,
      });
      if (!rate.allowed) {
        c.header("retry-after", String(rate.retryAfterSeconds));
        return apiError(c, 429, "RATE_LIMITED", "Too many attachment uploads");
      }

      try {
        const upload = await createComposerUploadIntent({
          env: c.env,
          requestOrigin: new URL(c.req.url).origin,
          mailboxId,
          userId: user.id,
          filename: body.filename,
          contentType: body.contentType,
          size: body.size,
          directOnly: directOnly === "true",
        });
        return c.json({ ok: true as const, upload }, 201);
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  )
  .put(
    "/uploads/content",
    zValidator(
      "query",
      mailboxQuerySchema.extend({
        uploadId: uploadIdSchema,
      }),
    ),
    async (c) => {
      const { mailboxId, uploadId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
      if (!access) return apiError(c, 403, "FORBIDDEN", "Send access is required");
      try {
        await storeComposerUploadContent({
          env: c.env,
          mailboxId,
          userId: user.id,
          uploadId,
          body: c.req.raw.body,
          contentType: c.req.header("content-type") ?? undefined,
          contentLength: requestContentLength(
            c.req.header("content-length") ?? undefined,
          ),
        });
        return c.json({ ok: true as const });
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  )
  .post(
    "/uploads/:id/complete",
    zValidator("param", z.object({ id: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const { id: uploadId } = c.req.valid("param");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
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
    },
  )
  .delete(
    "/uploads/:id",
    zValidator("param", z.object({ id: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
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
    },
  )
  .get(
    "/mailboxes/:id/recipient-suggestions",
    zValidator("query", recipientSuggestionQuerySchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      const access = await accessibleMailbox(
        c.env,
        c.get("user").id,
        mailboxId,
        "read",
      );
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const query = c.req.valid("query");
      return c.json({
        ok: true as const,
        suggestions: await mailboxStub(c.env, mailboxId).suggestRecipients(
          access.address,
          query.q,
          query.limit,
        ),
      });
    },
  )
  .get("/mailboxes/:id/folders", async (c) => {
    const mailboxId = c.req.param("id");
    const access = await accessibleMailbox(
      c.env,
      c.get("user").id,
      mailboxId,
      "read",
    );
    if (!access) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    const storedFolders = await mailboxStub(c.env, mailboxId).listFolders(
      c.get("user").id,
    );
    return c.json({
      ok: true as const,
      folders: storedFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        kind: folder.kind,
        systemType: folder.systemType,
        totalCount: folder.totalCount,
        unreadCount: folder.unreadCount,
      })),
    });
  })
  .get("/mailboxes/:id/ai", async (c) => {
    const mailboxId = c.req.param("id");
    if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    return c.json({
      ok: true as const,
      settings: await mailboxStub(c.env, mailboxId).getMailboxAiSettings(),
    });
  })
  .put(
    "/mailboxes/:id/ai",
    zValidator("json", mailboxAiConfigurationSchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      return c.json({
        ok: true as const,
        settings: await mailboxStub(c.env, mailboxId)
          .setMailboxAiConfiguration(c.req.valid("json")),
      });
    },
  )
  .post(
    "/mailboxes/:id/folders",
    zValidator("json", createFolderSchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const result = await mailboxStub(c.env, mailboxId).createFolder(
        createId("fld"),
        c.req.valid("json").name,
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
    },
  )
  .put(
    "/mailboxes/:id/folders/order",
    zValidator("json", reorderFoldersSchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const result = await mailboxStub(c.env, mailboxId).reorderFolders(
        c.req.valid("json").folderIds,
      );
      if (result.status === "conflict") {
        return apiError(
          c,
          409,
          "CONFLICT",
          "Folders changed; refresh and try again",
        );
      }
      return c.json({ ok: true as const });
    },
  )
  .patch(
    "/mailboxes/:id/folders/:folderId",
    zValidator("json", renameFolderSchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const result = await mailboxStub(c.env, mailboxId).renameFolder(
        c.req.param("folderId"),
        c.req.valid("json").name,
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
    },
  )
  .delete("/mailboxes/:id/folders/:folderId", async (c) => {
    const mailboxId = c.req.param("id");
    if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    const result = await mailboxStub(c.env, mailboxId).deleteFolder(
      c.req.param("folderId"),
    );
    if (result.status === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Folder not found");
    }
    return c.json({ ok: true as const });
  })
  .get("/conversations", zValidator("query", conversationListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const access = await accessibleMailbox(c.env, c.get("user").id, query.mailboxId, "read");
    if (!access) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    const cursor = query.cursor ? decodeConversationCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      return apiError(c, 400, "BAD_REQUEST", "Conversation cursor is invalid");
    }
    const page = await mailboxStub(c.env, query.mailboxId).listConversations(
      c.get("user").id,
      query.folder,
      query.limit,
      cursor,
      query.search,
      query.unreadOnly === "true",
    );
    if (!page) return apiError(c, 404, "NOT_FOUND", "Folder not found");
    return c.json({
      ok: true as const,
      conversations: page.items.map((item) => ({
        ...toMessageSummary(item.email),
        subject: conversationSubject(item.email.subject),
        conversationLabel: conversationLabel(
          access.address,
          item.email,
        ),
        messageCount: item.messageCount,
        unreadCount: item.unreadCount,
        isUnread: item.unreadCount > 0,
        hasIncoming: item.hasIncoming,
      })),
      nextCursor: page.next ? encodeConversationCursor(page.next) : null,
    });
  })
  .patch(
    "/conversations/bulk",
    zValidator("query", mailboxQuerySchema),
    zValidator("json", bulkConversationActionSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "read");
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const input = c.req.valid("json");
      const stub = mailboxStub(c.env, mailboxId);
      if (input.type === "read") {
        const updatedCount = await stub.bulkSetConversationRead(
          user.id,
          input.conversationIds,
          input.isRead,
        );
        return c.json({ ok: true as const, updatedCount });
      }
      if (input.type === "update") {
        const updatedCount = await stub.bulkUpdateConversations(
          input.conversationIds,
          input.sourceFolderId,
          input.update,
        );
        if (updatedCount === null) {
          return apiError(c, 404, "NOT_FOUND", "Source or target folder not found");
        }
        return c.json({ ok: true as const, updatedCount });
      }
      if (!access.canSend) {
        return apiError(
          c,
          403,
          "FORBIDDEN",
          "Send access is required to delete conversations permanently",
        );
      }

      const result = await stub.permanentlyDeleteConversations(
        input.conversationIds,
      );
      if (result.outcome === "not_found") {
        return apiError(c, 404, "NOT_FOUND", "Conversations not found");
      }
      if (result.outcome === "not_in_trash") {
        return apiError(
          c,
          409,
          "CONFLICT",
          "Only conversations in Trash can be deleted permanently",
        );
      }
      return c.json({
        ok: true as const,
        updatedCount: result.deletedCount,
      });
    },
  )
  .get(
    "/conversations/:id",
    zValidator("query", conversationMessagesQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const { mailboxId } = query;
      const currentUserId = c.get("user").id;
      const access = await accessibleMailbox(c.env, currentUserId, mailboxId, "read");
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const cursor = query.cursor ? decodeConversationCursor(query.cursor) : null;
      if (query.cursor && !cursor) {
        return apiError(c, 400, "BAD_REQUEST", "Message cursor is invalid");
      }
      const snapshot = await mailboxStub(c.env, mailboxId)
        .getConversationPageSnapshot(
          c.req.param("id"),
          currentUserId,
          query.limit,
          cursor,
        );
      if (!snapshot) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
      const readerIds = [...new Set(
        snapshot.readStates.map((readState) => readState.userId),
      )];
      const readers = await listMailboxUsersByIds(
        c.env.DB,
        mailboxId,
        readerIds,
      );
      const readerById = new Map(readers.map((reader) => [reader.id, reader]));
      const readStatesByEmail = new Map<
        string,
        typeof snapshot.readStates
      >();
      for (const readState of snapshot.readStates) {
        const states = readStatesByEmail.get(readState.emailId) ?? [];
        states.push(readState);
        readStatesByEmail.set(readState.emailId, states);
      }
      const messages = await Promise.all(snapshot.messages.map(async (email) => {
        const object = email.bodyHtmlR2Key
          ? await c.env.MAIL_STORAGE.get(email.bodyHtmlR2Key)
          : null;
        const readStates = readStatesByEmail.get(email.id) ?? [];
        return toMessageDetail(
          email,
          access.address,
          object ? await object.text() : null,
          {
            isRead: readStates.some(
              (readState) => readState.userId === currentUserId,
            ),
            viewedBy: readStates.flatMap((readState) => {
              const reader = readerById.get(readState.userId);
              return reader
                ? [{
                    userId: reader.id,
                    name: reader.name,
                    readAt: readState.readAt,
                  }]
                : [];
            }),
          },
        );
      }));
      return c.json({
        ok: true as const,
        mailboxState: snapshot.mailboxState,
        folderId: snapshot.folderId,
        hasIncoming: snapshot.hasIncoming,
        messageCount: snapshot.messageCount,
        unreadCount: snapshot.unreadCount,
        nextCursor: snapshot.next
          ? encodeConversationCursor(snapshot.next)
          : null,
        messages,
      });
    },
  )
  .patch(
    "/messages/:id/read",
    zValidator("query", mailboxQuerySchema),
    zValidator("json", messageReadSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      if (!await accessibleMailbox(c.env, user.id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const updated = await mailboxStub(c.env, mailboxId).setMessageRead(
        user.id,
        c.req.param("id"),
        c.req.valid("json").isRead,
      );
      if (!updated) return apiError(c, 404, "NOT_FOUND", "Message not found");
      return c.json({ ok: true as const });
    },
  )
  .post(
    "/messages/:id/translate",
    zValidator("query", mailboxQuerySchema),
    zValidator("json", messageTranslationSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const userId = c.get("user").id;
      if (!await accessibleMailbox(c.env, userId, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      if (!await globalAiProcessingEnabled(c.env.DB)) {
        return apiError(c, 409, "CONFLICT", "AI mail processing is disabled by an administrator");
      }
      const limit = await checkRateLimit(c.env.DB, {
        action: "mail-translation",
        identifier: userId,
        limit: 20,
        windowMs: 60_000,
      });
      if (!limit.allowed) {
        c.header("retry-after", String(limit.retryAfterSeconds));
        return apiError(c, 429, "RATE_LIMITED", "Too many translation requests");
      }
      const message = await mailboxStub(c.env, mailboxId).getEmail(c.req.param("id"));
      if (!message) return apiError(c, 404, "NOT_FOUND", "Message not found");
      const { language, segments } = c.req.valid("json");
      if (segments.join("").length > MAX_TRANSLATION_CHARACTERS) {
        return apiError(c, 422, "BAD_REQUEST", "Message is too long to translate");
      }
      try {
        const translations = await translateEmailSegments({
          segments,
          language,
          run: (request, signal) => c.env.AI.run(MAILBOX_AI_MODEL, request, {
            signal,
            tags: ["openworkspace:mail-translation"],
            extraHeaders: { "cf-aig-collect-log": "false" },
          }),
        });
        return c.json({ ok: true as const, translations });
      } catch {
        return apiError(c, 502, "BAD_GATEWAY", "Could not translate this message");
      }
    },
  )
  .get(
    "/remote",
    zValidator("query", remoteProxyQuerySchema),
    async (c) => {
      const { mailboxId, url } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      try {
        assertProxyableRemoteUrl(url);
      } catch (error) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : "Remote URL is invalid",
        );
      }
      const limited = await checkRateLimit(c.env.DB, {
        action: "mail-remote-proxy",
        identifier: c.get("user").id,
        limit: 120,
        windowMs: 60_000,
      });
      if (!limited.allowed) {
        return apiError(
          c,
          429,
          "RATE_LIMITED",
          "Too many remote content requests. Try again shortly.",
        );
      }
      try {
        const remote = await fetchProxiedRemoteMedia(url);
        return new Response(remote.body, {
          headers: {
            "cache-control": "private, max-age=3600",
            "content-type": remote.contentType,
            "content-disposition": "inline",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return apiError(
          c,
          502,
          "BAD_GATEWAY",
          error instanceof Error ? error.message : "Remote content unavailable",
        );
      }
    },
  )
  .get(
    "/messages/:messageId/authentication",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const userId = c.get("user").id;
      const access = await accessibleMailbox(c.env, userId, mailboxId, "read");
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const mailbox = mailboxStub(c.env, mailboxId);
      const message = await mailbox.getEmail(c.req.param("messageId"));
      if (!message?.rawMimeR2Key || message.direction !== "incoming") {
        return apiError(c, 404, "NOT_FOUND", "Original message not found");
      }
      const original = {
        subject: message.subject,
        from: message.fromJson[0]?.address ?? "unknown@invalid",
        to: message.toJson.map((recipient) => recipient.address),
        messageId: message.messageIdHeader,
        receivedAt: message.timelineAt.toISOString(),
      };
      if (message.authenticationResultsJson) {
        return c.json({
          ok: true as const,
          state: "available" as const,
          original,
          authentication: message.authenticationResultsJson,
        });
      }

      const zoneId = access.cloudflareZoneId?.trim();
      const token = c.env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
      if (!zoneId || !token) {
        return c.json({
          ok: true as const,
          state: "unavailable" as const,
          original,
          reason: "not_configured" as const,
        });
      }
      if (!message.messageIdHeader) {
        return c.json({
          ok: true as const,
          state: "unavailable" as const,
          original,
          reason: "missing_message_id" as const,
        });
      }
      if (
        Date.now() - message.timelineAt.getTime()
        > CLOUDFLARE_EMAIL_ANALYTICS_RETENTION_MS
      ) {
        return c.json({
          ok: true as const,
          state: "unavailable" as const,
          original,
          reason: "expired" as const,
        });
      }

      const limited = await checkRateLimit(c.env.DB, {
        action: "mail-email-authentication",
        identifier: `${userId}:${message.id}`,
        limit: 4,
        windowMs: 60_000,
      });
      if (!limited.allowed) {
        return c.json({
          ok: true as const,
          state: "unavailable" as const,
          original,
          reason: "rate_limited" as const,
        });
      }

      try {
        const authentication = await fetchCloudflareEmailAuthentication({
          zoneId,
          token,
          messageId: message.messageIdHeader,
          timelineAt: message.timelineAt.getTime(),
        });
        if (!authentication) {
          return c.json({
            ok: true as const,
            state: "unavailable" as const,
            original,
            reason: "not_found" as const,
          });
        }
        await mailbox.setEmailAuthenticationResults(message.id, authentication);
        return c.json({
          ok: true as const,
          state: "available" as const,
          original,
          authentication,
        });
      } catch (error) {
        console.error(
          `Could not load Cloudflare authentication for ${message.id}`,
          error,
        );
        return c.json({
          ok: true as const,
          state: "unavailable" as const,
          original,
          reason: "request_failed" as const,
        });
      }
    },
  )
  .get(
    "/messages/:messageId/original",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const message = await mailboxStub(c.env, mailboxId)
        .getEmail(c.req.param("messageId"));
      if (!message?.rawMimeR2Key) {
        return apiError(c, 404, "NOT_FOUND", "Original message not found");
      }
      const requestedRange = c.req.header("range");
      const object = await getStoredObject(
        c.env.MAIL_STORAGE,
        message.rawMimeR2Key,
        requestedRange,
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
    },
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      );
      if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
      const requestedRange = c.req.header("range");
      const object = await getStoredObject(
        c.env.MAIL_STORAGE,
        file.r2Key,
        requestedRange,
      );
      if (!object) return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
      return storedObjectResponse({
        object,
        contentType: file.contentType,
        contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        totalBytes: file.size,
        rangeRequested: Boolean(requestedRange),
      });
    },
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId/preview",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      );
      if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
      const preview = attachmentPreview(file);
      if (!preview) {
        return apiError(c, 422, "BAD_REQUEST", "Preview is not available for this file");
      }
      if (file.pdfPreviewStatus === "pending") {
        return apiError(c, 409, "NOT_READY", "Preview is being generated");
      }
      if (file.pdfPreviewStatus === "failed") {
        return apiError(c, 422, "UNAVAILABLE", "Preview could not be generated");
      }
      const requestedRange = c.req.header("range");
      const previewKey = file.pdfPreviewStatus === "ready" ? officePreviewKey(file.r2Key) : file.r2Key;
      const object = await getStoredObject(c.env.MAIL_STORAGE, previewKey, requestedRange);
      if (!object) return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
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
    },
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId/download-url",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      );
      if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
      if (!await c.env.MAIL_STORAGE.head(file.r2Key)) {
        return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
      }
      const download = await signR2GetUrl({
        env: c.env,
        r2Key: file.r2Key,
      });
      if (!download) {
        return apiError(
          c,
          503,
          "UNAVAILABLE",
          "Direct R2 downloads are not configured",
        );
      }
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
    },
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId/inline",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      );
      const contentType = file ? mediaType(file.contentType) : "";
      if (
        !file?.contentId
        || !isComposerInlineImageContentType(contentType)
      ) {
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
    },
  )
  .post(
    "/messages/:id/send-again",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const access = await accessibleMailbox(c.env, c.get("user").id, mailboxId, "send");
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
        return apiError(c, 409, "CONFLICT", "Only failed or unconfirmed messages can be sent again");
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
    },
  )
  .post(
    "/attachment-preflight",
    zValidator("json", attachmentPreflightSchema),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");
      const access = await accessibleMailbox(
        c.env,
        user.id,
        input.mailboxId,
        "send",
      );
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const rate = await checkRateLimit(c.env.DB, {
        action: "mail-attachment-preflight",
        identifier: `${user.id}:${input.mailboxId}`,
        limit: 120,
        windowMs: 60_000,
      });
      if (!rate.allowed) {
        c.header("retry-after", String(rate.retryAfterSeconds));
        return apiError(
          c,
          429,
          "RATE_LIMITED",
          "Too many attachment checks",
        );
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
    },
  )
  .post("/messages", zValidator("json", composeSchema), async (c) => {
    const input = c.req.valid("json");
    const access = await accessibleMailbox(c.env, c.get("user").id, input.mailboxId, "send");
    if (!access) return apiError(c, 403, "FORBIDDEN", "Send access is required");
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
        submission.inserted ? 201 : 200,
      );
    } catch (error) {
      return outgoingFailure(c, error);
    }
  })
  .post(
    "/messages/:id/replies",
    zValidator("json", replySchema),
    async (c) => {
      const input = c.req.valid("json");
      const access = await accessibleMailbox(
        c.env,
        c.get("user").id,
        input.mailboxId,
        "send",
      );
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
          submission.inserted ? 201 : 200,
        );
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  )
  .post(
    "/messages/:id/forward",
    zValidator("json", forwardSchema),
    async (c) => {
      const input = c.req.valid("json");
      const access = await accessibleMailbox(
        c.env,
        c.get("user").id,
        input.mailboxId,
        "send",
      );
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
          submission.inserted ? 201 : 200,
        );
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  );
