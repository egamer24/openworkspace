import {
  Dialog,
  DialogTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@open-workspace/core/ui";
import {
  Download,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { attachmentPreview } from "../../shared/attachment-preview";
import { AttachmentPreviewDialog } from "./attachment-preview-dialog";
import { formatBytes } from "./format-bytes";
import type { MessageAttachment } from "./types";

type FileKind = { label: string; Icon: LucideIcon; hue: number };

const ARCHIVE = /^(zip|rar|7z|gz|tgz|tar|bz2|xz)$/u;
const SHEET = /^(xlsx?|xlsm|ods|csv|tsv|numbers)$/u;
const SLIDES = /^(pptx?|odp|key)$/u;
const DOCUMENT = /^(docx?|odt|rtf|pages|txt|md)$/u;

function fileHueStyle(
  hue: number
): CSSProperties & Record<"--file-hue", number> {
  return { "--file-hue": hue };
}

function fileKind(attachment: MessageAttachment): FileKind {
  const { filename } = attachment;
  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();

  const type = attachment.contentType.toLowerCase();
  const label = extension ? extension.toUpperCase().slice(0, 5) : "File";

  if (type === "application/pdf" || extension === "pdf") {
    return { label: "PDF", Icon: FileText, hue: 25 };
  }

  if (type.startsWith("image/")) return { label, Icon: FileImage, hue: 300 };

  if (SHEET.test(extension)) return { label, Icon: FileSpreadsheet, hue: 150 };

  if (SLIDES.test(extension)) return { label, Icon: Presentation, hue: 55 };

  if (DOCUMENT.test(extension) || type.startsWith("text/")) {
    return { label, Icon: FileText, hue: 255 };
  }

  if (ARCHIVE.test(extension) || type.includes("zip")) {
    return { label, Icon: FileArchive, hue: 80 };
  }

  return { label, Icon: File, hue: 260 };
}

export function MessageAttachments({
  messageId,
  mailboxId,
  attachments,
}: {
  messageId: string;
  mailboxId?: string;
  attachments: MessageAttachment[];
}) {
  if (!attachments.length) return null;

  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.size,
    0
  );

  return (
    <section aria-label="Attachments" className="mt-5">
      <p className="text-muted-foreground mb-2 text-xs font-medium">
        {attachments.length}{" "}
        {attachments.length === 1 ? "attachment" : "attachments"}
        <span aria-hidden="true"> · </span>
        <span className="tabular-nums">{formatBytes(totalBytes)}</span>
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12.5rem),1fr))] gap-2">
        {attachments.map((attachment) => (
          <AttachmentTile
            key={attachment.id}
            messageId={messageId}
            mailboxId={mailboxId}
            attachment={attachment}
          />
        ))}
      </ul>
    </section>
  );
}

function AttachmentTile({
  messageId,
  mailboxId,
  attachment,
}: {
  messageId: string;
  mailboxId?: string;
  attachment: MessageAttachment;
}) {
  const baseUrl = `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`;
  const query = `?mailboxId=${encodeURIComponent(mailboxId ?? "")}`;
  const downloadUrl = `${baseUrl}${query}`;
  const preview = attachmentPreview(attachment);
  const kind = fileKind(attachment);

  const body = (
    <>
      <span
        aria-hidden="true"
        style={fileHueStyle(kind.hue)}
        className="file-tile-icon grid size-9 shrink-0 place-items-center rounded-md"
      >
        <kind.Icon className="size-4.5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="text-foreground block truncate text-[13px] font-medium"
          title={attachment.filename}
        >
          {attachment.filename}
        </span>
        <span className="text-muted-foreground block text-[11.5px] tabular-nums">
          {kind.label} · {formatBytes(attachment.size)}
        </span>
      </span>
    </>
  );

  const mainClassName =
    "flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg py-2 pr-1 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

  return (
    <li className="group/file border-border bg-surface hover:border-input hover:bg-surface-sunken flex items-stretch rounded-lg border transition-colors">
      {preview ? (
        <Dialog>
          <DialogTrigger
            className={mainClassName}
            aria-label={`Preview ${attachment.filename}`}
          >
            {body}
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
      ) : (
        <a
          className={mainClassName}
          href={downloadUrl}
          download={attachment.filename}
        >
          {body}
        </a>
      )}
      {preview ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring my-1.5 mr-1.5 grid w-8 shrink-0 place-items-center rounded-md transition-colors outline-none focus-visible:ring-2"
                href={downloadUrl}
                download={attachment.filename}
                aria-label={`Download ${attachment.filename}`}
              />
            }
          >
            <Download className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
      ) : (
        <span
          aria-hidden="true"
          className="text-muted-foreground/70 my-1.5 mr-1.5 grid w-8 shrink-0 place-items-center"
        >
          <Download className="size-4" />
        </span>
      )}
    </li>
  );
}
