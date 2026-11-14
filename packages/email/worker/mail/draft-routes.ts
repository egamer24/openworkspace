import {
  apiError,
  createId,
  oauthScope,
  zValidator,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import {
  composerAttachmentLimitError,
  isComposerInlineImageContentType,
} from "../../shared/mail";
import { MAIL_SEND_SCOPE } from "../../shared/permissions";
import type { StoredImageRef } from "../../shared/rich-content";
import { mailboxStub } from "../mailbox";
import type { SaveDraftResult } from "../mailbox";
import type { Draft, DraftAttachment } from "../mailbox/schema";
import { accessibleMailbox } from "./access";
import {
  draftIdSchema,
  mailboxQuerySchema,
  saveDraftSchema,
  uploadIdSchema,
} from "./schemas";
import { withSignature } from "./signatures";
import {
  copyDraftFile,
  draftFileKey,
  loadComposerUpload,
  readDraftFile,
  UploadValidationError,
} from "./uploads";

const draftParamSchema = z.object({ id: draftIdSchema });

/** A draft as the API returns it; the owner is always the caller. */
export function draftView({ userId: _, attachments, ...draft }: Draft) {
  return {
    ...draft,
    attachments: attachments.map(({ r2Key: _key, ...file }) => file),
  };
}

type DraftSave = z.output<typeof saveDraftSchema>;

type DraftOwner = {
  env: Env;
  user: { id: string; name: string };
  mailbox: { id: string; ownerUserId: string | null };
};

/** A file of a save: one the draft holds already, or one to copy in from `copyFrom`. */
type ResolvedFile = { file: DraftAttachment; copyFrom: string | null };

/**
 * The uploads a save names, with what the draft already holds reused and new
 * uploads checked against the composer's limits. Copies nothing yet.
 */
async function resolveUploads(
  owner: DraftOwner,
  files: DraftSave["attachments"],
  current: Draft | null
): Promise<ResolvedFile[]> {
  const { env, user, mailbox } = owner;

  const held = new Map(
    current?.attachments.map((file) => [file.uploadId, file])
  );

  const resolved = await Promise.all(
    files.map(async (file) => {
      const known = held.get(file.uploadId);

      const upload =
        known ??
        (await loadComposerUpload({
          env,
          mailboxId: mailbox.id,
          userId: user.id,
          uploadId: file.uploadId,
        }));

      if (
        file.disposition === "inline" &&
        !isComposerInlineImageContentType(upload.contentType)
      ) {
        throw new UploadValidationError(
          "Inline images must be PNG, JPEG, GIF, or WebP"
        );
      }

      const r2Key = draftFileKey(mailbox.id, user.id, file.uploadId);

      return {
        copyFrom: known || upload.r2Key === r2Key ? null : upload.r2Key,
        file: {
          assetId: file.assetId,
          uploadId: file.uploadId,
          disposition: file.disposition,
          contentId: file.contentId ?? null,
          filename: upload.filename,
          contentType: upload.contentType,
          size: upload.size,
          r2Key,
        },
      };
    })
  );

  const limitError = composerAttachmentLimitError(
    resolved.map((entry) => entry.file)
  );

  if (limitError) throw new UploadValidationError(limitError);

  return resolved;
}

const storedKey = (ref: StoredImageRef) => `${ref.ownerId}/${ref.contentId}`;

/**
 * The signature images a save shows, each as the draft's own copy, so a
 * later change to the signature leaves the draft as it was. Copies are made
 * once; the sender may use only the signatures a message may (withSignature).
 */
async function resolveStoredImages(
  owner: DraftOwner,
  refs: readonly StoredImageRef[],
  current: Draft | null
): Promise<ResolvedFile[]> {
  const held = new Map(
    current?.attachments.flatMap((file) =>
      file.storedImage ? [[storedKey(file.storedImage), file] as const] : []
    )
  );

  const unique = [
    ...new Map(refs.map((ref) => [storedKey(ref), ref])).values(),
  ];

  const missing = unique.filter((ref) => !held.has(storedKey(ref)));

  const { inlineImages } = missing.length
    ? await withSignature({
        env: owner.env,
        sender: owner.user,
        mailbox: owner.mailbox,
        kind: "new",
        message: { bodyText: "", storedImages: missing },
      })
    : { inlineImages: [] };

  const copied = inlineImages.map((image, index): ResolvedFile => {
    const uploadId = createId("upl");

    return {
      copyFrom: image.r2Key,
      file: {
        assetId: crypto.randomUUID(),
        uploadId,
        disposition: "inline",
        contentId: image.contentId,
        filename: image.filename,
        contentType: image.contentType,
        size: image.size,
        r2Key: draftFileKey(owner.mailbox.id, owner.user.id, uploadId),
        storedImage: missing[index],
      },
    };
  });

  return [
    ...unique.flatMap((ref) => {
      const file = held.get(storedKey(ref));

      return file ? [{ file, copyFrom: null }] : [];
    }),
    ...copied,
  ];
}

export type StoreDraftResult =
  | SaveDraftResult
  | { status: "invalid"; message: string };

/**
 * Saves the caller's draft `id` in their mailbox: its files are copied out
 * of the expiring upload prefix (only those it doesn't hold yet, so
 * autosaving while typing copies nothing), then the row is written if it is
 * still at `expectedVersion`. Used by the drafts API and JMAP Email/set.
 */
export async function storeDraft(
  owner: DraftOwner,
  id: string,
  save: DraftSave
): Promise<StoreDraftResult> {
  const { expectedVersion, attachments, storedImages, ...input } = save;
  const stub = mailboxStub(owner.env, owner.mailbox.id);
  const current = await stub.getDraft(owner.user.id, id);
  let files: ResolvedFile[];

  try {
    files = [
      ...(await resolveUploads(owner, attachments, current)),
      ...(await resolveStoredImages(owner, storedImages, current)),
    ];
  } catch (error) {
    if (!(error instanceof UploadValidationError)) throw error;

    return { status: "invalid", message: error.message };
  }

  const copied = files.filter((entry) => entry.copyFrom !== null);

  const copies = await Promise.allSettled(
    copied.map((entry) =>
      copyDraftFile(owner.env, entry.copyFrom ?? "", entry.file)
    )
  );

  const copiedKeys = copied.map((entry) => entry.file.r2Key);

  const failed = copies.find(
    (copy): copy is PromiseRejectedResult => copy.status === "rejected"
  );

  if (failed) {
    await stub.forgetDraftFiles(copiedKeys);

    if (failed.reason instanceof UploadValidationError) {
      return { status: "invalid", message: failed.reason.message };
    }

    throw failed.reason;
  }

  return stub.saveDraft(
    owner.user.id,
    { ...input, id, attachments: files.map((entry) => entry.file) },
    expectedVersion,
    copiedKeys
  );
}

function forbidden(c: Context<AppEnv>) {
  return apiError(c, 403, "FORBIDDEN", "Send access is required");
}

/**
 * Deletes the sender's draft once its message is accepted, before answering,
 * so the client's next drafts list no longer has it. A failure leaves a stale
 * draft, which is harmless next to the sent message.
 */
export async function discardSentDraft(
  c: Context<AppEnv>,
  mailboxId: string,
  draftId: string | undefined
) {
  if (!draftId) return;

  try {
    await mailboxStub(c.env, mailboxId).deleteDraft(c.get("user").id, draftId);
  } catch (error) {
    console.error("Could not delete the sent draft", error);
  }
}

/**
 * Autosaved drafts, private to their author in any mailbox. Saving one needs
 * send access, like the message it becomes.
 */
export const mailDraftRoutes = new Hono<AppEnv>()
  .get(
    "/",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "send"))) {
        return forbidden(c);
      }

      const rows = await mailboxStub(c.env, mailboxId).listDrafts(
        c.get("user").id
      );

      return c.json({ ok: true as const, drafts: rows.map(draftView) });
    }
  )
  .get(
    "/files/:uploadId",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("param", z.object({ uploadId: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "send"))) {
        return forbidden(c);
      }

      const object = await readDraftFile({
        env: c.env,
        mailboxId,
        userId: c.get("user").id,
        uploadId: c.req.valid("param").uploadId,
      });

      const contentType = object?.httpMetadata?.contentType ?? "";

      // Only inline images are shown in the composer; nothing else is served.
      if (!object || !isComposerInlineImageContentType(contentType)) {
        return apiError(c, 404, "NOT_FOUND", "Draft file was not found");
      }

      return c.body(object.body, 200, {
        "content-type": contentType,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      });
    }
  )
  .put(
    "/:id",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("param", draftParamSchema),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", saveDraftSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const access = await accessibleMailbox(c, mailboxId, "send");

      if (!access) return forbidden(c);

      const result = await storeDraft(
        { env: c.env, user: c.get("user"), mailbox: access },
        c.req.valid("param").id,
        c.req.valid("json")
      );

      if (result.status === "invalid") {
        return apiError(c, 400, "BAD_REQUEST", result.message);
      }

      if (result.status === "limit") {
        return apiError(
          c,
          409,
          "CONFLICT",
          "Too many drafts: send or discard some first"
        );
      }

      if (result.status === "conflict") {
        return c.json(
          {
            ok: false as const,
            error: {
              code: "DRAFT_CHANGED" as const,
              message: "This draft was changed in another window",
            },
            draft: result.draft ? draftView(result.draft) : null,
          },
          409
        );
      }

      return c.json({ ok: true as const, draft: draftView(result.draft) });
    }
  )
  .delete(
    "/:id",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("param", draftParamSchema),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");

      if (!(await accessibleMailbox(c, mailboxId, "send"))) {
        return forbidden(c);
      }

      await mailboxStub(c.env, mailboxId).deleteDraft(
        c.get("user").id,
        c.req.valid("param").id
      );

      return c.json({ ok: true as const });
    }
  );
