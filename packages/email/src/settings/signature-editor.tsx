import { Button, Switch, useAddressSection } from "@open-workspace/core/ui";
import type { SuccessfulResponse } from "@open-workspace/core/ui";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import type { mailApi } from "../lib/mail-api";
import { signatureImageUrl } from "../mail/signature";
import { RichContentEditor } from "./rich-content-editor";
import type {
  RichContentEditorHandle,
  RichContentValue,
} from "./rich-content-editor";

export type SavedSignature = SuccessfulResponse<
  Awaited<ReturnType<typeof mailApi.api.mail.signature.$get>>
>["signature"];

export type SignatureBody = RichContentValue & {
  useOnNew: boolean;
  useOnReply: boolean;
};

/**
 * A signature: its text and images in the shared rich content editor, and
 * the switches for new messages and for replies and forwards. With a Save
 * button of its own, or, inside an address editor (`section`), saved by
 * the editor's "Save address" through `useAddressSection`.
 */
export function SignatureEditor({
  saved,
  uploadMailboxId,
  label,
  placeholder,
  section = false,
  onSave,
}: {
  saved: SavedSignature;
  uploadMailboxId: string | undefined;
  label: string;
  placeholder: string;
  section?: boolean;
  onSave: (body: SignatureBody) => Promise<void>;
}) {
  const editor = useRef<RichContentEditorHandle>(null);
  const [edited, setEdited] = useState(false);
  const [useOnNew, setUseOnNew] = useState(saved?.useOnNew ?? true);
  const [useOnReply, setUseOnReply] = useState(saved?.useOnReply ?? true);

  const [savedSwitches, setSavedSwitches] = useState({
    useOnNew: saved?.useOnNew ?? true,
    useOnReply: saved?.useOnReply ?? true,
  });

  const dirty =
    edited ||
    useOnNew !== savedSwitches.useOnNew ||
    useOnReply !== savedSwitches.useOnReply;

  async function save() {
    const value = editor.current?.value();

    if (!value) return;
    await onSave({ ...value, useOnNew, useOnReply });
    setEdited(false);
    setSavedSwitches({ useOnNew, useOnReply });
  }

  // Inside an address editor, its "Save address" saves this; elsewhere a no-op.
  useAddressSection({
    dirty,
    save: () =>
      save().catch((error: Error) => {
        throw new Error(`Signature: ${error.message}`, { cause: error });
      }),
  });

  const saveNow = useMutation({
    mutationFn: save,
    onSuccess: () => toast.success("Signature saved"),
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-3">
      <RichContentEditor
        ref={editor}
        saved={saved}
        imageUrl={signatureImageUrl}
        uploadMailboxId={uploadMailboxId}
        label={label}
        placeholder={placeholder}
        disabled={saveNow.isPending}
        onEdit={() => setEdited(true)}
        onSubmitShortcut={section ? undefined : () => saveNow.mutate()}
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
        {section ? null : (
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            disabled={saveNow.isPending || !dirty}
            onClick={() => saveNow.mutate()}
          >
            {saveNow.isPending && <LoaderCircle className="animate-spin" />}
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
