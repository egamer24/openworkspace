import { Badge, Button } from "@open-workspace/core/ui";
import {
  AlertCircle,
  Image,
  Link2,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  X,
} from "lucide-react";

import type { ComposerAsset } from "./composer-session";
import { useComposerUploadProgress } from "./composer-upload-progress";
import type { ComposerUploadProgressStore } from "./composer-upload-progress";
import { formatBytes } from "./format-bytes";

export function ComposerAttachmentList({
  uploads,
  linkedIds,
  progress,
  onRemove,
  onRetry,
  disabled = false,
}: {
  uploads: readonly ComposerAsset[];
  linkedIds: ReadonlySet<string>;
  progress: ComposerUploadProgressStore;
  onRemove: (upload: ComposerAsset) => void;
  onRetry: (upload: ComposerAsset) => void;
  disabled?: boolean;
}) {
  if (!uploads.length) return null;

  return (
    <div className="border-border/70 max-h-32 shrink-0 overflow-y-auto border-t px-3 py-2">
      {uploads.map((upload) => (
        <ComposerAttachmentRow
          key={upload.id}
          upload={upload}
          linked={linkedIds.has(upload.id)}
          progressStore={progress}
          disabled={disabled}
          onRemove={onRemove}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

function ComposerAttachmentRow({
  upload,
  linked,
  progressStore,
  disabled,
  onRemove,
  onRetry,
}: {
  upload: ComposerAsset;
  linked: boolean;
  progressStore: ComposerUploadProgressStore;
  disabled: boolean;
  onRemove: (upload: ComposerAsset) => void;
  onRetry: (upload: ComposerAsset) => void;
}) {
  const progress = useComposerUploadProgress(progressStore, upload.id);

  return (
    <div className="relative flex min-h-9 items-center gap-2 overflow-hidden rounded-lg px-1.5 text-xs">
      {upload.intent === "inline" ? (
        <Image className="text-muted-foreground size-3.5 shrink-0" />
      ) : (
        <Paperclip className="text-muted-foreground size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate font-medium">
        {upload.filename}
      </span>
      <span className="text-muted-foreground shrink-0 tabular-nums">
        {formatBytes(upload.size)}
      </span>
      {upload.status === "uploading" ? (
        <Badge variant="secondary">
          <LoaderCircle className="animate-spin" />
          {Math.round(progress * 100)}%
        </Badge>
      ) : null}
      {upload.status === "error" ? (
        <Badge variant="destructive" title={upload.error ?? undefined}>
          <AlertCircle />
          Failed
        </Badge>
      ) : null}
      {upload.status === "uploaded" && linked ? (
        <Badge
          variant="warning"
          title="A 30-day download link will be added to the message"
        >
          <Link2 />
          30-day link
        </Badge>
      ) : null}
      {upload.status === "uploaded" && !linked ? (
        <Badge variant="success">
          {upload.intent === "inline" ? <Image /> : <Paperclip />}
          {upload.intent === "inline" ? "Inline" : "Attached"}
        </Badge>
      ) : null}
      {upload.status === "error" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Retry ${upload.filename}`}
          disabled={disabled}
          onClick={() => onRetry(upload)}
        >
          <RotateCcw />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${upload.filename}`}
        disabled={disabled}
        onClick={() => onRemove(upload)}
      >
        <X />
      </Button>
      {upload.status === "uploading" ? (
        <span
          className="bg-primary absolute inset-x-1.5 bottom-0 h-0.5 origin-left rounded-full transition-transform"
          style={{ transform: `scaleX(${progress})` }}
        />
      ) : null}
    </div>
  );
}
