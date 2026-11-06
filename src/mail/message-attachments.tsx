import { Download, FileText, HardDrive } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { useDriveStatus } from "@/drive/drive-status";
import { api, responseJson } from "@/lib/api";
import { attachmentPreview } from "../../shared/attachment-preview";
import { AttachmentPreviewDialog } from "./attachment-preview-dialog";
import { formatBytes } from "./format-bytes";
import type { MessageAttachment } from "./types";

const attachmentClassName = "flex max-w-full items-center gap-2 rounded-lg border border-current/12 bg-current/4 px-2.5 py-1.5 text-xs transition-colors hover:border-current/25 hover:bg-current/8 focus-visible:outline-2 focus-visible:outline-ring";

export function MessageAttachments({
  messageId,
  mailboxId,
  attachments,
}: {
  messageId: string;
  mailboxId?: string;
  attachments: MessageAttachment[];
}) {
  const drive = useDriveStatus();
  if (!attachments.length) return null;

  async function saveToDrive(attachmentId: string) {
    try {
      const { item } = await responseJson(await api.api.drive.items["from-attachment"].$post({
        json: { mailboxId: mailboxId ?? "", messageId, attachmentId },
      }));
      toast.success(`Saved ${item.name} to Drive`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save to Drive");
    }
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2 border-t border-current/10 pt-3">
      {attachments.map((attachment) => {
        const baseUrl = `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`;
        const query = `?mailboxId=${encodeURIComponent(mailboxId ?? "")}`;
        const downloadUrl = `${baseUrl}${query}`;
        const preview = attachmentPreview(attachment);
        const Icon = preview ? FileText : Download;
        const label = (
          <>
            <Icon className="size-3.5 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate font-medium">{attachment.filename}</span>
            <span className="shrink-0 opacity-60 tabular-nums">{formatBytes(attachment.size)}</span>
          </>
        );

        const save = drive.isSuccess && mailboxId ? (
          <button
            type="button"
            className="rounded-md p-1 opacity-60 hover:bg-current/8 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Save ${attachment.filename} to Drive`}
            title="Save to Drive"
            onClick={() => void saveToDrive(attachment.id)}
          >
            <HardDrive className="size-3.5" />
          </button>
        ) : null;

        if (!preview) {
          return (
            <span key={attachment.id} className="flex max-w-full items-center gap-0.5">
              <a className={attachmentClassName} href={downloadUrl}>
                {label}
              </a>
              {save}
            </span>
          );
        }
        return (
          <span key={attachment.id} className="flex max-w-full items-center gap-0.5">
            <Dialog>
              <DialogTrigger className={attachmentClassName} aria-label={`Preview ${attachment.filename}`}>
                {label}
              </DialogTrigger>
              <AttachmentPreviewDialog
                messageId={messageId}
                mailboxId={mailboxId ?? ""}
                attachment={attachment}
                preview={preview}
                previewUrl={`${baseUrl}/preview${query}`}
                downloadUrl={downloadUrl}
              />
            </Dialog>
            {save}
          </span>
        );
      })}
    </div>
  );
}
