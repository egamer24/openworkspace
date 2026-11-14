import { hashToken, randomToken } from "@open-workspace/core/module";
import type { z } from "zod";

import {
  attachmentsRequiringDownloadLinks,
  composerAttachmentLimitError,
  isComposerInlineImageContentType,
} from "../../shared/mail";
import type { StoredAttachment } from "../mailbox/model";
import type { Email, NewEmail } from "../mailbox/schema";
import {
  appendForwardedMessage,
  contextForNewRecipient,
  escapeHtml,
  externalizeLinkedInlineImages,
  htmlWithQuotedContext,
  resolveLinkedAttachmentPlaceholders,
  textWithQuotedContext,
} from "./outbound-content";
import { address, replyThreadHeaders } from "./rfc";
import type { InlineImage } from "./rich-content";
import type { composeSchema } from "./schemas";
import {
  copyStoredAttachmentToMessage,
  loadComposerUpload,
  loadComposerUploadMetadata,
  UploadValidationError,
} from "./uploads";

const DOWNLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Stored image references are resolved to `inlineImages` by the routes.
export type OutgoingMessageInput = Omit<
  z.infer<typeof composeSchema>,
  "storedImages"
> & {
  /** Set by the route from the authenticated session. */
  userId: string;
  /** Saved images (rich-content.ts) the body uses, sent inline like composer images. */
  inlineImages?: InlineImage[];
};

type PreparedAttachment = StoredAttachment & {
  downloadUrl: string | null;
  sourceUploadId?: string;
  sourceObjectKey?: string;
};

export class ComposerAttachmentLimitError extends Error {}

type OutgoingAttachmentDraft = Pick<
  OutgoingMessageInput,
  | "attachments"
  | "bodyHtml"
  | "bodyText"
  | "mailboxId"
  | "subject"
  | "userId"
  | "inlineImages"
>;

export async function discardPreparedObjects(env: Env, storageKeys: string[]) {
  if (!storageKeys.length) return;

  try {
    await env.MAIL_STORAGE.delete(storageKeys);
  } catch (error) {
    // Attempt-scoped keys cannot corrupt the winning idempotent request.
    console.error("Could not remove unused outgoing mail objects", error);
  }
}

export function outgoingRequestFingerprint(compose: OutgoingMessageInput) {
  const { userId: _, ...payload } = compose;

  return hashToken(`outgoing-request-v2\0${JSON.stringify(payload)}`);
}

export { attachmentsRequiringDownloadLinks };

export function withDownloadLinks(
  bodyText: string,
  bodyHtml: string | undefined,
  attachments: PreparedAttachment[],
  expiresAt: Date
) {
  const positioned = resolveLinkedAttachmentPlaceholders({
    bodyText,
    bodyHtml,
    attachments: attachments.map((attachment) => ({
      uploadId: attachment.sourceUploadId ?? null,
      filename: attachment.filename,
      downloadUrl: attachment.downloadUrl,
    })),
  });

  const links = attachments.filter(
    (attachment): attachment is PreparedAttachment & { downloadUrl: string } =>
      attachment.downloadUrl !== null
  );

  if (!links.length) {
    return {
      bodyText: positioned.bodyText,
      bodyHtml: positioned.bodyHtml,
    };
  }

  const expiry = expiresAt.toISOString().slice(0, 10);

  const fallbackTextLinks = links.filter(
    (attachment) =>
      !attachment.sourceUploadId ||
      !positioned.textPlacedUploadIds.has(attachment.sourceUploadId)
  );

  const textBlock = fallbackTextLinks.length
    ? [
        `Attachments (download links expire ${expiry}):`,
        ...fallbackTextLinks.map(
          (attachment) => `- ${attachment.filename}: ${attachment.downloadUrl}`
        ),
      ].join("\n")
    : "";

  const nextText = textBlock
    ? `${positioned.bodyText.trimEnd()}${positioned.bodyText.trimEnd() ? "\n\n" : ""}${textBlock}`
    : positioned.bodyText;

  const positionedHtml = positioned.bodyHtml;

  if (!positionedHtml) {
    return { bodyText: nextText, bodyHtml: positionedHtml };
  }

  const inlineImagePlacements = new Set(
    links.flatMap((attachment) =>
      attachment.disposition === "inline" &&
      attachment.contentId &&
      positionedHtml.includes(`cid:${attachment.contentId}`)
        ? [attachment.id]
        : []
    )
  );

  const nextHtml = externalizeLinkedInlineImages(positionedHtml, links);

  const fallbackHtmlLinks = links.filter(
    (attachment) =>
      (!attachment.sourceUploadId ||
        !positioned.htmlPlacedUploadIds.has(attachment.sourceUploadId)) &&
      !inlineImagePlacements.has(attachment.id)
  );

  if (!fallbackHtmlLinks.length) {
    return { bodyText: nextText, bodyHtml: nextHtml };
  }

  const htmlBlock = [
    `<p>Attachments (download links expire ${escapeHtml(expiry)}):</p>`,
    "<ul>",
    ...fallbackHtmlLinks.map(
      (attachment) =>
        `<li><a href="${escapeHtml(attachment.downloadUrl)}">${escapeHtml(attachment.filename)}</a></li>`
    ),
    "</ul>",
  ].join("");

  return { bodyText: nextText, bodyHtml: `${nextHtml}${htmlBlock}` };
}

export async function messageIdForRequest(
  mailboxId: string,
  requestId: string
) {
  return `msg_${await hashToken(`${mailboxId}:${requestId}`)}`;
}

async function loadPreparedComposerAttachments(input: {
  env: Env;
  compose: OutgoingAttachmentDraft;
  storagePrefix: string;
  finalized: boolean;
}): Promise<PreparedAttachment[]> {
  const loadUpload = input.finalized
    ? loadComposerUpload
    : loadComposerUploadMetadata;

  const uploads = input.compose.attachments;

  const savedImages = (input.compose.inlineImages ?? []).map(
    (image, offset) => {
      const id = `att_${uploads.length + offset + 1}`;

      return {
        id,
        sourceObjectKey: image.r2Key,
        r2Key: `${input.storagePrefix}/attachments/${id}`,
        filename: image.filename,
        contentType: image.contentType,
        size: image.size,
        contentId: image.contentId,
        disposition: "inline",
        delivery: "attached",
        downloadTokenHash: null,
        downloadExpiresAt: null,
        downloadUrl: null,
      } satisfies PreparedAttachment;
    }
  );

  const uploaded = await Promise.all(
    uploads.map(async (file, index) => {
      try {
        const upload = await loadUpload({
          env: input.env,
          mailboxId: input.compose.mailboxId,
          userId: input.compose.userId,
          uploadId: file.uploadId,
        });

        if (
          file.disposition === "inline" &&
          !isComposerInlineImageContentType(upload.contentType)
        ) {
          throw new UploadValidationError(
            "Inline images must be PNG, JPEG, GIF, or WebP"
          );
        }

        return {
          id: `att_${index + 1}`,
          sourceUploadId: file.uploadId,
          sourceObjectKey: upload.r2Key,
          r2Key: `${input.storagePrefix}/attachments/att_${index + 1}`,
          filename: upload.filename,
          contentType: upload.contentType,
          size: upload.size,
          contentId: file.contentId ?? null,
          disposition: file.disposition,
          delivery: "attached" as const,
          downloadTokenHash: null,
          downloadExpiresAt: null,
          downloadUrl: null,
        } satisfies PreparedAttachment;
      } catch (error) {
        if (error instanceof UploadValidationError) {
          throw new ComposerAttachmentLimitError(error.message);
        }

        throw error;
      }
    })
  );

  return [...uploaded, ...savedImages];
}

function planOutgoingAttachments(input: {
  compose: OutgoingAttachmentDraft;
  uploaded: PreparedAttachment[];
  forwarded: Email | null;
  related: Email | null;
  includeRelatedContext: boolean;
  storagePrefix?: string;
}) {
  // A persisted forward gets message-owned copies. Preflight has no storage
  // prefix and only needs attachment metadata for the delivery plan.
  const forwardedAttachments: PreparedAttachment[] = (
    input.forwarded?.attachmentsJson ?? []
  ).map((file, index) => {
    const id = `fwd_att_${index + 1}`;

    return {
      ...file,
      id,
      r2Key: input.storagePrefix
        ? `${input.storagePrefix}/attachments/${id}`
        : file.r2Key,
      sourceObjectKey: input.storagePrefix ? file.r2Key : undefined,
      contentId: null,
      disposition: "attachment",
      delivery: "attached",
      downloadTokenHash: null,
      downloadExpiresAt: null,
      downloadUrl: null,
    };
  });

  const attachments = [...input.uploaded, ...forwardedAttachments];
  const limitError = composerAttachmentLimitError(attachments);

  if (limitError) throw new ComposerAttachmentLimitError(limitError);

  const forwardedContent = appendForwardedMessage(
    input.compose.bodyText,
    input.compose.bodyHtml,
    input.forwarded
  );

  const quotedText =
    input.includeRelatedContext && input.related
      ? contextForNewRecipient(input.related)
      : null;

  const linkedIds = attachmentsRequiringDownloadLinks({
    subject: input.compose.subject,
    bodyText: textWithQuotedContext(forwardedContent.bodyText, quotedText),
    bodyHtml: forwardedContent.bodyHtml
      ? htmlWithQuotedContext(forwardedContent.bodyHtml, quotedText)
      : undefined,
    attachments,
  });

  return {
    attachments,
    forwardedContent,
    linkedIds,
    quotedText,
  };
}

export async function preflightOutgoingAttachments(input: {
  env: Env;
  compose: OutgoingAttachmentDraft;
  forwarded: Email | null;
  related: Email | null;
  includeRelatedContext: boolean;
}) {
  const uploaded = await loadPreparedComposerAttachments({
    env: input.env,
    compose: input.compose,
    storagePrefix: "preflight",
    finalized: false,
  });

  const plan = planOutgoingAttachments({
    ...input,
    uploaded,
  });

  return {
    externalizedAttachments: plan.linkedIds.size,
    linkedUploadIds: uploaded.flatMap((attachment) =>
      plan.linkedIds.has(attachment.id) && attachment.sourceUploadId
        ? [attachment.sourceUploadId]
        : []
    ),
  };
}

export async function prepareOutgoingEmail(input: {
  env: Env;
  requestUrl: string;
  compose: OutgoingMessageInput;
  requestFingerprint: string;
  id: string;
  conversationId: string;
  related: Email | null;
  forwarded: Email | null;
  includeRelatedContext: boolean;
  fromAddress: string;
  fromName: string;
  now: Date;
}) {
  const { compose, id, related } = input;
  const storageAttempt = randomToken();
  const storagePrefix = `mailboxes/${compose.mailboxId}/messages/${id}/attempts/${storageAttempt}`;
  const expiresAt = new Date(input.now.getTime() + DOWNLOAD_TTL_MS);

  const uploaded = await loadPreparedComposerAttachments({
    env: input.env,
    compose,
    storagePrefix,
    finalized: true,
  });

  const plan = planOutgoingAttachments({
    compose,
    uploaded,
    forwarded: input.forwarded,
    related,
    includeRelatedContext: input.includeRelatedContext,
    storagePrefix,
  });

  const { forwardedContent, linkedIds, quotedText } = plan;

  const attachments: PreparedAttachment[] = await Promise.all(
    plan.attachments.map(async (file) => {
      if (!linkedIds.has(file.id)) return file;
      const token = `${compose.mailboxId}.${id}.${file.id}.${randomToken()}`;

      return {
        ...file,
        delivery: "download_link" as const,
        downloadTokenHash: await hashToken(token),
        downloadExpiresAt: expiresAt.getTime(),
        downloadUrl: new URL(
          `/api/downloads/mail/${encodeURIComponent(token)}`,
          input.requestUrl
        ).toString(),
      };
    })
  );

  const content = withDownloadLinks(
    forwardedContent.bodyText,
    forwardedContent.bodyHtml,
    attachments,
    expiresAt
  );

  // The stored body is the authored content only. Quoted context is persisted
  // separately and added to the transport payload at delivery time.
  const storedBodyHtml = content.bodyHtml;
  const bodyHtmlR2Key = storedBodyHtml ? `${storagePrefix}/body.html` : null;

  const storageKeys = [
    ...attachments.flatMap((file) =>
      file.sourceObjectKey ? [file.r2Key] : []
    ),
    ...(bodyHtmlR2Key ? [bodyHtmlR2Key] : []),
  ];

  const writes = [
    ...attachments.flatMap((file) => {
      if (!file.sourceObjectKey) return [];

      return [
        copyStoredAttachmentToMessage({
          env: input.env,
          sourceKey: file.sourceObjectKey,
          destinationKey: file.r2Key,
          contentType: file.contentType,
        }),
      ];
    }),
    ...(bodyHtmlR2Key && storedBodyHtml
      ? [
          input.env.MAIL_STORAGE.put(bodyHtmlR2Key, storedBodyHtml, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          }),
        ]
      : []),
  ];

  const writeResults = await Promise.allSettled(writes);

  const failedWrite = writeResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );

  if (failedWrite) {
    await discardPreparedObjects(input.env, storageKeys);
    throw failedWrite.reason;
  }

  const from = address(input.fromAddress, input.fromName);
  const to = compose.to.map((value) => address(value));
  const cc = compose.cc.map((value) => address(value));
  const bcc = compose.bcc.map((value) => address(value));
  const replyTo = compose.replyTo ? [address(compose.replyTo)] : [];

  const threadHeaders = related
    ? replyThreadHeaders(related)
    : { inReplyTo: [], references: [] };

  const continuedList =
    related?.conversationId === input.conversationId ? related : null;

  const email: NewEmail = {
    id,
    requestFingerprint: input.requestFingerprint,
    conversationId: input.conversationId,
    direction: "outgoing",
    messageIdHeader: null,
    inReplyToJson: threadHeaders.inReplyTo,
    referencesJson: threadHeaders.references,
    fromJson: [from],
    replyToJson: replyTo,
    toJson: to,
    ccJson: cc,
    bccJson: bcc,
    subject: compose.subject || "(no subject)",
    preview: content.bodyText.replaceAll(/\s+/gu, " ").trim().slice(0, 220),
    bodyText: content.bodyText,
    quotedText,
    bodyHtmlR2Key,
    attachmentsJson: attachments.map(
      ({ downloadUrl: _, sourceUploadId: __, sourceObjectKey: ___, ...file }) =>
        file
    ),
    listId: continuedList?.listId ?? null,
    listPostAddress: continuedList?.listPostAddress ?? null,
    timelineAt: input.now,
    transportState: "unconfirmed",
    deliveryStatusJson: [],
  };

  return {
    email,
    externalizedAttachments: linkedIds.size,
    // Every key is owned by this attempt, including forwarded attachment
    // copies, so rollback cannot remove an object owned by another message.
    storageKeys,
    composerUploadIds: uploaded.flatMap((file) =>
      file.sourceUploadId ? [file.sourceUploadId] : []
    ),
  };
}
