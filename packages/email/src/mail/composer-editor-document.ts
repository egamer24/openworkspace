import type { Editor } from "@tiptap/react";

import type { StoredImageRef } from "../../shared/rich-content";
import type { ComposerSession } from "./composer-session";
import { takeStoredImages } from "./rich-content";

export type ComposerContent = {
  bodyHtml: string;
  /** The editor's own HTML, asset references included, which a draft keeps. */
  editorHtml: string;
  bodyText: string;
  inlineAssetIds: string[];
  linkedAssetIds: string[];
  /** Saved images (rich-content.ts) the body shows, sent by reference. */
  storedImages: StoredImageRef[];
};

/**
 * Serializes the editor from stable asset references. Upload metadata stays in
 * ComposerSession and never has to be copied back into ProseMirror attributes.
 */
export function composerContent(
  editor: Editor,
  session: ComposerSession
): ComposerContent {
  const editorHtml = editor.getHTML();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = editorHtml;
  const inlineAssetIds: string[] = [];
  const linkedAssetIds: string[] = [];

  for (const reference of wrapper.querySelectorAll<HTMLElement>(
    "[data-composer-asset]"
  )) {
    const assetId = reference.dataset.composerAsset ?? "";
    const asset = session.getAsset(assetId);

    if (!asset?.uploadId) {
      reference.remove();
      continue;
    }

    if (session.isLinked(asset.id)) {
      linkedAssetIds.push(asset.id);
      const placeholder = document.createElement("span");
      placeholder.dataset.linkedAttachment = asset.uploadId;
      placeholder.dataset.linkedAttachmentFilename = asset.filename;
      placeholder.textContent = asset.filename;
      reference.replaceWith(placeholder);
      continue;
    }

    if (asset.intent === "inline" && asset.contentId) {
      inlineAssetIds.push(asset.id);
      const image = document.createElement("img");
      image.src = `cid:${asset.contentId}`;
      image.alt = asset.filename;
      image.title = asset.filename;
      reference.replaceWith(image);
      continue;
    }

    reference.remove();
  }

  const storedImages = takeStoredImages(wrapper);

  return {
    bodyHtml: wrapper.innerHTML,
    editorHtml,
    bodyText: editor.getText({ blockSeparator: "\n\n" }),
    inlineAssetIds,
    linkedAssetIds,
    storedImages,
  };
}
