import type { z } from "zod";

import { isComposerInlineImageContentType } from "../../shared/mail";
import type { RichImage, StoredImageRef } from "../../shared/rich-content";
import { escapeHtml } from "./outbound-content";
import type { richContentFields } from "./schemas";
import {
  copyStoredAttachmentToMessage,
  loadComposerUpload,
  UploadValidationError,
} from "./uploads";

/**
 * Saved rich content (signatures, auto-replies): HTML
 * from the composer's editor whose images live in R2 under an owner prefix
 * that never expires, sent as inline `cid:` attachments.
 */

/** An image to send inline, with the R2 object it is copied from. */
export type InlineImage = RichImage & { r2Key: string };

export type RichContentInput = z.infer<z.ZodObject<typeof richContentFields>>;

/** An image saved with rich content stays small: it goes out with every message. */
const MAX_RICH_IMAGE_BYTES = 1_000_000;

function referencedImages<T extends { contentId: string }>(
  html: string,
  images: readonly T[]
) {
  return images.filter((image) => html.includes(`cid:${image.contentId}`));
}

/** Whether saving `content` should delete it instead: no text and no image. */
export function isEmptyRichContent(content: RichContentInput) {
  return (
    !content.text.trim() &&
    !referencedImages(content.html, content.images).length
  );
}

/**
 * Stores the images of `content` under `prefix`: new composer uploads are
 * copied in, and images it keeps must be among the `previous` ones. Returns
 * the images its HTML uses. Once the content itself is saved, call
 * `deleteRichImages(prefix, keep)` to drop the ones no longer used.
 */
export function storeRichImages(input: {
  env: Env;
  userId: string;
  prefix: string;
  previous: readonly RichImage[];
  content: RichContentInput;
}): Promise<RichImage[]> {
  const { content } = input;

  return Promise.all(
    referencedImages(content.html, content.images).map(async (image) => {
      if (!image.uploadId) {
        const kept = input.previous.find(
          (candidate) => candidate.contentId === image.contentId
        );

        if (!kept) throw new UploadValidationError("Image was not found");

        return kept;
      }

      // Upload keys carry the uploader's id, so only their own uploads load.
      const upload = await loadComposerUpload({
        env: input.env,
        mailboxId: content.uploadMailboxId ?? "",
        userId: input.userId,
        uploadId: image.uploadId,
      });

      if (!isComposerInlineImageContentType(upload.contentType)) {
        throw new UploadValidationError(
          "Images must be PNG, JPEG, GIF, or WebP"
        );
      }

      if (upload.size > MAX_RICH_IMAGE_BYTES) {
        throw new UploadValidationError("Images are limited to 1 MB each");
      }

      await copyStoredAttachmentToMessage({
        env: input.env,
        sourceKey: upload.r2Key,
        destinationKey: `${input.prefix}${image.contentId}`,
        contentType: upload.contentType,
      });

      return {
        contentId: image.contentId,
        filename: upload.filename,
        contentType: upload.contentType,
        size: upload.size,
      };
    })
  );
}

/** Deletes the objects under `prefix` except `keep` (content ids). */
export async function deleteRichImages(
  bucket: R2Bucket,
  prefix: string,
  keep: ReadonlySet<string> = new Set()
) {
  // ponytail: one page; saved content holds far fewer than 1000 images.
  const page = await bucket.list({ prefix, limit: 1000 });

  const stale = page.objects
    .map((object) => object.key)
    .filter((key) => !keep.has(key.slice(prefix.length)));

  if (stale.length) await bucket.delete(stale);
}

/** The images `html` uses, to send inline from their objects under `prefix`. */
export function inlineImages(
  prefix: string,
  html: string,
  images: readonly RichImage[]
): InlineImage[] {
  return referencedImages(html, images).map((image) => ({
    ...image,
    r2Key: `${prefix}${image.contentId}`,
  }));
}

/**
 * The message with rich content appended after a blank line, and the images
 * it uses to send inline. A text-only body gets an HTML part, so they show.
 */
export function appendRichContent<
  T extends { bodyText: string; bodyHtml?: string },
>(
  message: T,
  content: { html: string; text: string; images: readonly RichImage[] },
  prefix: string
): T & { bodyHtml: string; inlineImages: InlineImage[] } {
  const body = message.bodyText.trimEnd();

  const bodyHtml =
    message.bodyHtml ??
    (body ? `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>` : "");

  return {
    ...message,
    bodyText: body ? `${body}\n\n${content.text}` : content.text,
    bodyHtml: `${bodyHtml}<div data-rich-content><br>${content.html}</div>`,
    inlineImages: inlineImages(prefix, content.html, content.images),
  };
}

/**
 * The saved images a composed message refers to (its editor inserted them
 * without uploading them again), each from one of `sources`, the content the
 * sender may use; throws for any other.
 */
export function referencedStoredImages(
  refs: readonly StoredImageRef[],
  sources: readonly {
    ownerId: string;
    prefix: string;
    images: readonly RichImage[];
  }[]
): InlineImage[] {
  return refs.map((ref) => {
    const source = sources.find(
      (candidate) => candidate.ownerId === ref.ownerId
    );

    const image = source?.images.find(
      (candidate) => candidate.contentId === ref.contentId
    );

    if (!source || !image) {
      throw new UploadValidationError("Inline image was not found");
    }

    return { ...image, r2Key: `${source.prefix}${image.contentId}` };
  });
}
