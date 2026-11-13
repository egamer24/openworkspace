import {
  buttonVariants,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@open-workspace/core/ui";
import { Download, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import type { attachmentPreview } from "../../shared/attachment-preview";
import type { PdfPreviewStatus } from "../../shared/office-preview";
import { formatBytes } from "./format-bytes";
import type { MessageAttachment } from "./types";

const PdfPreview = lazy(() => import("./pdf-preview"));

export function AttachmentPreviewDialog({
  attachment,
  preview,
  previewUrl,
  downloadUrl,
  messageId,
  mailboxId,
}: {
  attachment: MessageAttachment;
  preview: NonNullable<ReturnType<typeof attachmentPreview>>;
  previewUrl: string;
  downloadUrl: string;
  messageId: string;
  mailboxId: string;
}) {
  return (
    <DialogContent className="flex h-[90dvh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-7xl">
      <div className="flex min-w-0 items-center gap-3 border-b px-4 py-3 pr-12">
        <div className="min-w-0 flex-1">
          <DialogTitle
            className="truncate leading-6"
            title={attachment.filename}
          >
            {attachment.filename}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {formatBytes(attachment.size)}
          </DialogDescription>
        </div>
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={downloadUrl}
          download={attachment.filename}
        >
          <Download /> Download
        </a>
      </div>
      <AttachmentPreviewContent
        filename={attachment.filename}
        kind={preview.kind}
        url={previewUrl}
        status={attachment.pdfPreviewStatus}
        messageId={messageId}
        mailboxId={mailboxId}
      />
    </DialogContent>
  );
}

function AttachmentPreviewContent({
  filename,
  kind,
  url,
  status,
  messageId,
  mailboxId,
}: {
  filename: string;
  kind: "pdf" | "image" | "text";
  url: string;
  status?: PdfPreviewStatus | null;
  messageId: string;
  mailboxId: string;
}) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const unavailable = failed || status === "failed";

  if (status === "pending") {
    return (
      <div
        role="status"
        className="text-muted-foreground grid min-h-0 flex-1 place-content-center justify-items-center gap-3"
      >
        <LoaderCircle className="size-6 animate-spin" />
        <span>Generating preview</span>
      </div>
    );
  }

  if (kind === "pdf" && !unavailable) {
    return (
      <Suspense
        fallback={
          <div role="status" className="grid flex-1 place-items-center">
            <LoaderCircle className="size-6 animate-spin" />
            <span className="sr-only">Loading PDF</span>
          </div>
        }
      >
        <PdfPreview
          key={url}
          url={url}
          filename={filename}
          messageId={messageId}
          mailboxId={mailboxId}
        />
      </Suspense>
    );
  }

  return (
    <div className="bg-surface-sunken relative min-h-0 flex-1">
      {unavailable ? (
        <p
          role="status"
          className="text-muted-foreground grid h-full place-items-center p-6 text-sm"
        >
          Preview unavailable
        </p>
      ) : (
        <>
          {loading && (
            <div
              role="status"
              className="pointer-events-none absolute inset-0 grid place-items-center"
            >
              <LoaderCircle className="text-muted-foreground size-6 animate-spin" />
              <span className="sr-only">Loading preview</span>
            </div>
          )}
          {kind === "image" ? (
            <img
              src={url}
              alt={filename}
              className="h-full w-full object-contain p-4"
              onLoad={() => setLoading(false)}
              onError={() => setFailed(true)}
            />
          ) : (
            <iframe
              src={url}
              title={`Preview of ${filename}`}
              className="h-full w-full border-0 bg-white"
              sandbox=""
              referrerPolicy="no-referrer"
              onLoad={() => setLoading(false)}
              onError={() => setFailed(true)}
            />
          )}
        </>
      )}
    </div>
  );
}
