import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_MAIL_RECIPIENTS,
  replyActionModes,
} from "../../shared/mail";
import { emailSchema } from "../auth/schemas";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { mailboxStub } from "../mailbox";
import type { DraftAttachment } from "../mailbox/model";
import type { Draft } from "../mailbox/schema";
import { getMailboxAccess } from "./access";
import { mailboxQuerySchema, uploadIdSchema } from "./schemas";
import {
  loadComposerUpload,
  restoreComposerUpload,
  UploadValidationError,
} from "./uploads";

const INLINE_PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function draftPrefix(mailboxId: string, draftId: string) {
  return `mailboxes/${mailboxId}/drafts/${draftId}/`;
}

function draftObjectKey(mailboxId: string, draftId: string, uploadId: string) {
  return `${draftPrefix(mailboxId, draftId)}${uploadId}`;
}

const draftIdSchema = z.string().regex(/^dft_[a-zA-Z0-9-]{8,64}$/u, "Draft id is invalid");

const saveDraftSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  kind: z.enum(["compose", "reply", "forward"]),
  replyMode: z.enum(replyActionModes).nullable().default(null),
  sourceMessageId: z.string().min(1).max(200).nullable().default(null),
  conversationId: z.string().min(1).max(200).nullable().default(null),
  to: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  replyTo: emailSchema.nullable().default(null),
  subject: z.string().max(998).default(""),
  editorBody: z.string().max(1_000_000).default(""),
  bodyText: z.string().max(500_000).default(""),
  attachments: z.array(z.object({
    assetId: z.string().min(1).max(80),
    uploadId: uploadIdSchema,
    intent: z.enum(["attachment", "inline"]),
    contentId: z.string().max(255).nullable().default(null),
  })).max(MAX_COMPOSER_ATTACHMENT_COUNT).default([]),
});

function draftSummary(draft: Draft) {
  return {
    id: draft.id,
    kind: draft.kind,
    replyMode: draft.replyMode,
    sourceMessageId: draft.sourceMessageId,
    conversationId: draft.conversationId,
    to: draft.toJson,
    subject: draft.subject,
    preview: draft.bodyText.replace(/\s+/gu, " ").trim().slice(0, 160),
    attachmentCount: draft.attachmentsJson.length,
    updatedAt: draft.updatedAt,
  };
}

/** Deletes a draft and every object stored for it. */
export async function discardDraft(env: Env, mailboxId: string, userId: string, draftId: string) {
  const deleted = await mailboxStub(env, mailboxId).deleteDraft(userId, draftId);
  const prefix = draftPrefix(mailboxId, draftId);
  while (true) {
    const page = await env.MAIL_STORAGE.list({ prefix, limit: 1_000 });
    if (!page.objects.length) break;
    await env.MAIL_STORAGE.delete(page.objects.map((object) => object.key));
  }
  return deleted;
}

/**
 * Copies newly referenced composer uploads under the draft prefix, which the
 * composer-uploads/ lifecycle rule does not expire. Metadata comes from the
 * verified upload, never from the client.
 */
async function preserveAttachments(input: {
  env: Env;
  mailboxId: string;
  userId: string;
  draftId: string;
  attachments: z.infer<typeof saveDraftSchema>["attachments"];
  previous: DraftAttachment[];
}): Promise<DraftAttachment[]> {
  const previous = new Map(input.previous.map((file) => [file.uploadId, file]));
  return Promise.all(input.attachments.map(async (file) => {
    const kept = previous.get(file.uploadId);
    if (kept) return { ...kept, assetId: file.assetId, intent: file.intent, contentId: file.contentId };
    const upload = await loadComposerUpload({ ...input, uploadId: file.uploadId });
    const object = await input.env.MAIL_STORAGE.get(upload.r2Key);
    if (!object) throw new UploadValidationError("Attachment upload was not found");
    await input.env.MAIL_STORAGE.put(
      draftObjectKey(input.mailboxId, input.draftId, file.uploadId),
      object.body,
      { httpMetadata: { contentType: upload.contentType } },
    );
    return {
      assetId: file.assetId,
      uploadId: file.uploadId,
      filename: upload.filename,
      contentType: upload.contentType,
      size: upload.size,
      intent: file.intent,
      contentId: file.contentId,
    };
  }));
}

/** Makes every draft attachment sendable again as a composer upload. */
async function restoreAttachments(env: Env, mailboxId: string, draft: Draft) {
  await Promise.all(draft.attachmentsJson.map(async (file) => {
    try {
      await loadComposerUpload({ env, mailboxId, userId: draft.userId, uploadId: file.uploadId });
      return;
    } catch (error) {
      if (!(error instanceof UploadValidationError)) throw error;
    }
    const copy = await env.MAIL_STORAGE.get(draftObjectKey(mailboxId, draft.id, file.uploadId));
    if (!copy) return;
    await restoreComposerUpload({
      env,
      mailboxId,
      userId: draft.userId,
      uploadId: file.uploadId,
      filename: file.filename,
      contentType: file.contentType,
      body: copy.body,
      size: file.size,
    });
  }));
}

async function canSend(env: Env, userId: string, mailboxId: string) {
  const access = await getMailboxAccess(createDb(env.DB), userId, mailboxId);
  return Boolean(access?.canSend);
}

export const draftRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", zValidator("query", mailboxQuerySchema), async (c) => {
    const { mailboxId } = c.req.valid("query");
    const userId = c.get("user").id;
    if (!await canSend(c.env, userId, mailboxId)) {
      return apiError(c, 403, "FORBIDDEN", "Send access is required");
    }
    const rows = await mailboxStub(c.env, mailboxId).listDrafts(userId);
    return c.json({ ok: true as const, drafts: rows.map(draftSummary) });
  })
  .get(
    "/:id",
    zValidator("param", z.object({ id: draftIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const userId = c.get("user").id;
      if (!await canSend(c.env, userId, mailboxId)) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const draft = await mailboxStub(c.env, mailboxId).getDraft(userId, c.req.valid("param").id);
      if (!draft) return apiError(c, 404, "NOT_FOUND", "Draft not found");
      await restoreAttachments(c.env, mailboxId, draft);
      const { userId: _userId, ...body } = draft;
      return c.json({ ok: true as const, draft: body });
    },
  )
  .get(
    "/:id/attachments/:uploadId",
    zValidator("param", z.object({ id: draftIdSchema, uploadId: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const { id, uploadId } = c.req.valid("param");
      const userId = c.get("user").id;
      if (!await canSend(c.env, userId, mailboxId)) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const draft = await mailboxStub(c.env, mailboxId).getDraft(userId, id);
      const file = draft?.attachmentsJson.find((candidate) => candidate.uploadId === uploadId);
      const object = file
        ? await c.env.MAIL_STORAGE.get(draftObjectKey(mailboxId, id, uploadId))
        : null;
      if (!file || !object) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
      // Only images are ever rendered by the composer; everything else downloads.
      const inline = INLINE_PREVIEW_TYPES.has(file.contentType);
      return new Response(object.body, {
        headers: {
          "content-type": inline ? file.contentType : "application/octet-stream",
          "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=300",
        },
      });
    },
  )
  .put(
    "/:id",
    zValidator("param", z.object({ id: draftIdSchema })),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", saveDraftSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = c.get("user").id;
      if (!await canSend(c.env, userId, mailboxId)) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const stub = mailboxStub(c.env, mailboxId);
      const current = await stub.getDraft(userId, id);
      if ((current?.version ?? 0) !== input.expectedVersion) {
        return c.json({ ok: false as const, error: { code: "CONFLICT" as const, message: "Draft changed in another window" }, draft: current }, 409);
      }
      let attachments: DraftAttachment[];
      try {
        attachments = await preserveAttachments({
          env: c.env,
          mailboxId,
          userId,
          draftId: id,
          attachments: input.attachments,
          previous: current?.attachmentsJson ?? [],
        });
      } catch (error) {
        if (!(error instanceof UploadValidationError)) throw error;
        return apiError(c, 400, "BAD_REQUEST", error.message);
      }
      const result = await stub.saveDraft(userId, {
        id,
        kind: input.kind,
        replyMode: input.replyMode,
        sourceMessageId: input.sourceMessageId,
        conversationId: input.conversationId,
        toJson: input.to,
        ccJson: input.cc,
        bccJson: input.bcc,
        replyTo: input.replyTo,
        subject: input.subject,
        editorBody: input.editorBody,
        bodyText: input.bodyText,
        attachmentsJson: attachments,
      }, input.expectedVersion);
      if (result.status === "limit") {
        return apiError(c, 409, "CONFLICT", "Too many drafts; send or discard some first");
      }
      if (result.status === "conflict") {
        return c.json({ ok: false as const, error: { code: "CONFLICT" as const, message: "Draft changed in another window" }, draft: result.draft }, 409);
      }
      const removed = (current?.attachmentsJson ?? [])
        .filter((file) => !attachments.some((kept) => kept.uploadId === file.uploadId))
        .map((file) => draftObjectKey(mailboxId, id, file.uploadId));
      if (removed.length) c.executionCtx.waitUntil(c.env.MAIL_STORAGE.delete(removed));
      return c.json({ ok: true as const, draft: draftSummary(result.draft), version: result.draft.version });
    },
  )
  .delete(
    "/:id",
    zValidator("param", z.object({ id: draftIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const userId = c.get("user").id;
      if (!await canSend(c.env, userId, mailboxId)) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const deleted = await discardDraft(c.env, mailboxId, userId, c.req.valid("param").id);
      if (!deleted) return apiError(c, 404, "NOT_FOUND", "Draft not found");
      return c.json({ ok: true as const });
    },
  );
