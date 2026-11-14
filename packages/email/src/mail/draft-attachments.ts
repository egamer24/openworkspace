// Kept apart from use-drafts.ts, which loads the API client, so unit tests
// can import these.
import { EMAIL_SERVICE_MAX_BYTES } from "../../shared/mail";
import type { ComposerContent } from "./composer-editor-document";
import type { ComposerAsset } from "./composer-session";
import type { DraftContent, SavedDraft } from "./use-drafts";

/** The finished uploads a composer's draft keeps. */
export function draftAttachments(
  assets: readonly ComposerAsset[]
): NonNullable<DraftContent["attachments"]> {
  return assets.flatMap((asset) =>
    asset.status === "uploaded" && asset.uploadId
      ? [
          {
            assetId: asset.id,
            uploadId: asset.uploadId,
            disposition: asset.intent,
            // JSON leaves an undefined one out.
            contentId: asset.contentId ?? undefined,
          },
        ]
      : []
  );
}

/** A reopened draft's files as composer assets, already uploaded. */
export function restoredComposerAssets(
  mailboxId: string,
  draft: Pick<SavedDraft, "attachments"> | undefined
): ComposerAsset[] {
  return (draft?.attachments ?? []).map((file) => ({
    id: file.assetId,
    uploadId: file.uploadId,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    intent: file.disposition,
    contentId: file.contentId,
    // As for a new upload: an image too large to send inline becomes a link.
    previewUrl:
      file.disposition === "inline" && file.size <= EMAIL_SERVICE_MAX_BYTES
        ? `/api/mail/drafts/files/${encodeURIComponent(file.uploadId)}?mailboxId=${encodeURIComponent(mailboxId)}`
        : null,
    status: "uploaded",
    error: null,
  }));
}

/**
 * A reopened draft's editor HTML. The signature images it kept as its own
 * files become ordinary inline images of those files, so the draft no longer
 * depends on the signature as it is now.
 */
export function restoredDraftHtml(
  draft: Pick<SavedDraft, "bodyHtml" | "editorHtml" | "attachments">
) {
  // A mail app's draft has no editor HTML; the editor takes its HTML as is.
  const document = new DOMParser().parseFromString(
    draft.editorHtml ?? draft.bodyHtml ?? "",
    "text/html"
  );

  for (const image of document.querySelectorAll<HTMLImageElement>(
    "img[data-stored-owner]"
  )) {
    const contentId = (image.getAttribute("src") ?? "").replace(/^cid:/u, "");

    const copy = draft.attachments.find(
      (file) =>
        file.storedImage?.ownerId === image.dataset.storedOwner &&
        file.storedImage?.contentId === contentId
    );

    if (!copy) {
      image.remove();
      continue;
    }

    const asset = document.createElement("span");
    asset.dataset.composerAsset = copy.assetId;
    asset.dataset.composerAssetIntent = "inline";
    image.replaceWith(asset);
  }

  return document.body.innerHTML;
}

/** The text of HTML the editor opens with, images as their alt text, as the editor reads it. */
export function openingText(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const image of document.querySelectorAll("img")) {
    image.replaceWith(image.alt);
  }

  return document.body.textContent;
}

/**
 * Whether a composer holds nothing but what it opened with (`initialText`,
 * e.g. the signature): no new text, inline images or attachments. Spacing
 * is ignored, since the editor and the opening HTML space blocks apart
 * differently.
 */
export function holdsOnlyInitialContent(
  content: Pick<ComposerContent, "bodyText" | "inlineAssetIds">,
  initialText: string,
  attachmentCount: number
) {
  const squeeze = (text: string) => text.replaceAll(/\s+/gu, "");

  return (
    squeeze(content.bodyText) === squeeze(initialText) &&
    !content.inlineAssetIds.length &&
    !attachmentCount
  );
}
