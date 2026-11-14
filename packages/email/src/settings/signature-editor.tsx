import { Button, Switch } from "@open-workspace/core/ui";
import type { SuccessfulResponse } from "@open-workspace/core/ui";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { mailApi } from "../lib/mail-api";
import { ComposerEditor } from "../mail/composer-editor";
import type { ComposerEditorHandle } from "../mail/composer-editor";
import { useComposerSession } from "../mail/composer-session";
import { signatureEditorHtml } from "../mail/signature-content";

export type SavedSignature = SuccessfulResponse<
  Awaited<ReturnType<typeof mailApi.api.mail.signature.$get>>
>["signature"];

export type SignatureBody = {
  html: string;
  text: string;
  images: { uploadId: string; contentId: string }[];
  uploadMailboxId?: string;
  useOnNew: boolean;
  useOnReply: boolean;
};

/**
 * A signature in the composer's own editor, so it looks as it will once
 * sent. `uploadMailboxId` is a mailbox the editor can upload images through.
 */
export function SignatureEditor({
  saved,
  uploadMailboxId,
  label,
  onSave,
}: {
  saved: SavedSignature;
  uploadMailboxId: string | undefined;
  label: string;
  onSave: (body: SignatureBody) => Promise<void>;
}) {
  const editor = useRef<ComposerEditorHandle>(null);
  const inlineFileInput = useRef<HTMLInputElement>(null);
  const { session, snapshot } = useComposerSession(uploadMailboxId ?? "");
  const [initialHtml, setInitialHtml] = useState<string | null>(null);
  const [documentAssetIds, setDocumentAssetIds] = useState<string[]>([]);
  const [useOnNew, setUseOnNew] = useState(saved?.useOnNew ?? true);
  const [useOnReply, setUseOnReply] = useState(saved?.useOnReply ?? true);

  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => toast.success("Signature saved"),
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Signature wasn't saved"
      );
    },
  });

  const saving = save.isPending;
  const restoring = useRef(false);

  useEffect(() => {
    if (restoring.current) return;
    restoring.current = true;
    void (
      saved
        ? signatureEditorHtml(session, saved.ownerId, saved.html)
        : Promise.resolve("")
    ).then(setInitialHtml);
  }, [session, saved]);

  const uploading = snapshot.assets.some(
    (asset) =>
      documentAssetIds.includes(asset.id) && asset.status !== "uploaded"
  );

  function addImages(files: File[], position?: number) {
    if (!uploadMailboxId) {
      toast.error("You need a mailbox you can send from to add images");

      return;
    }

    const assets = session.addFiles(files, "inline");

    if (assets) editor.current?.insertAssets(assets, position);
  }

  function submit() {
    const content = editor.current?.content();

    if (!content || saving || uploading) return;

    const images = content.inlineAssetIds.flatMap((assetId) => {
      const asset = session.getAsset(assetId);

      return asset?.uploadId && asset.contentId
        ? [{ uploadId: asset.uploadId, contentId: asset.contentId }]
        : [];
    });

    save.mutate({
      html: content.bodyHtml,
      text: content.bodyText,
      images,
      uploadMailboxId,
      useOnNew,
      useOnReply,
    });
  }

  if (initialHtml === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-5 text-sm">
        <LoaderCircle className="size-4 animate-spin" /> Loading signature…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="border-input bg-background focus-within:ring-ring/40 flex h-56 flex-col overflow-hidden rounded-lg border focus-within:ring-2">
        <ComposerEditor
          ref={editor}
          session={session}
          initialHtml={initialHtml}
          label={label}
          placeholder="Your name, role, phone…"
          onChange={() => {}}
          onAssetsChange={setDocumentAssetIds}
          onAddInlineFiles={addImages}
          onAddAttachmentFiles={() => {
            toast.error("Only images can go in a signature");
          }}
          onChooseInlineImage={() => inlineFileInput.current?.click()}
          onSubmitShortcut={submit}
          dragging={false}
          disabled={saving}
        />
      </div>
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={useOnNew} onCheckedChange={setUseOnNew} />
          New messages
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={useOnReply} onCheckedChange={setUseOnReply} />
          Replies and forwards
        </label>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={saving || uploading}
          onClick={submit}
        >
          {saving && <LoaderCircle className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
