import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";

import type { RichImage } from "../../shared/rich-content";
import { ComposerEditor } from "../mail/composer-editor";
import type { ComposerEditorHandle } from "../mail/composer-editor";
import { useComposerSession } from "../mail/composer-session";
import { storedImagesHtml } from "../mail/rich-content";

/** Saved rich content as its routes return it (worker/mail/rich-content.ts). */
export type SavedRichContent = {
  ownerId: string;
  html: string;
  images: RichImage[];
};

/** What saving rich content sends (`richContentFields` on the Worker). */
export type RichContentValue = {
  html: string;
  text: string;
  /** New images by upload id; saved images it keeps by content id alone. */
  images: { contentId: string; uploadId?: string }[];
  uploadMailboxId?: string;
};

export type RichContentEditorHandle = {
  /** The content to save; throws while an image is still uploading. */
  value: () => RichContentValue;
};

/**
 * Saved rich content (a signature; auto-replies later) in the composer's own
 * editor, so it looks as it will once sent. Saved images show at once from
 * where they are stored (`imageUrl`); new ones upload through
 * `uploadMailboxId`, a mailbox the person can send from.
 */
export const RichContentEditor = forwardRef<
  RichContentEditorHandle,
  {
    saved: SavedRichContent | null;
    imageUrl: (ownerId: string, contentId: string) => string;
    uploadMailboxId: string | undefined;
    label: string;
    placeholder: string;
    disabled: boolean;
    /** Called on every edit. */
    onEdit: () => void;
    onSubmitShortcut?: () => void;
  }
>(function RichContentEditor(
  {
    saved,
    imageUrl,
    uploadMailboxId,
    label,
    placeholder,
    disabled,
    onEdit,
    onSubmitShortcut,
  },
  ref
) {
  const editor = useRef<ComposerEditorHandle>(null);
  const inlineFileInput = useRef<HTMLInputElement>(null);
  const { session, snapshot } = useComposerSession(uploadMailboxId ?? "");
  const [documentAssetIds, setDocumentAssetIds] = useState<string[]>([]);

  // oxlint-disable-next-line react/hook-use-state -- read once, when the editor is created; nothing sets it
  const [initialHtml] = useState(() =>
    saved
      ? storedImagesHtml(saved.html, saved.ownerId, (contentId) =>
          imageUrl(saved.ownerId, contentId)
        )
      : ""
  );

  useImperativeHandle(ref, () => ({
    value: () => {
      const content = editor.current?.content();

      const uploading = snapshot.assets.some(
        (asset) =>
          documentAssetIds.includes(asset.id) && asset.status !== "uploaded"
      );

      if (!content || uploading) {
        throw new Error("Wait for images to finish uploading");
      }

      const uploads = content.inlineAssetIds.flatMap((assetId) => {
        const asset = session.getAsset(assetId);

        return asset?.uploadId && asset.contentId
          ? [{ uploadId: asset.uploadId, contentId: asset.contentId }]
          : [];
      });

      const kept = content.storedImages.flatMap((image) =>
        image.ownerId === saved?.ownerId ? [{ contentId: image.contentId }] : []
      );

      return {
        html: content.bodyHtml,
        text: content.bodyText,
        images: [...uploads, ...kept],
        uploadMailboxId,
      };
    },
  }));

  function addImages(files: File[], position?: number) {
    if (!uploadMailboxId) {
      toast.error("You need a mailbox you can send from to add images");

      return;
    }

    const assets = session.addFiles(files, "inline");

    if (assets) editor.current?.insertAssets(assets, position);
  }

  return (
    <div className="border-input bg-background focus-within:ring-ring/40 flex h-56 flex-col overflow-hidden rounded-lg border focus-within:ring-2">
      <ComposerEditor
        ref={editor}
        session={session}
        initialHtml={initialHtml}
        label={label}
        placeholder={placeholder}
        onChange={onEdit}
        onAssetsChange={setDocumentAssetIds}
        onAddInlineFiles={addImages}
        onAddAttachmentFiles={() => {
          toast.error("Only images can go in here");
        }}
        onChooseInlineImage={() => inlineFileInput.current?.click()}
        onSubmitShortcut={() => onSubmitShortcut?.()}
        dragging={false}
        disabled={disabled}
      />
      <input
        ref={inlineFileInput}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          addImages(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </div>
  );
});
