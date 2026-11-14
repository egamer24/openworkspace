import { Button, cn } from "@open-workspace/core/ui";
import {
  ChevronUp,
  ImagePlus,
  LoaderCircle,
  Minus,
  Paperclip,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { Ref, RefObject } from "react";

import type { ComposerAsset } from "./composer-session";
import { formatBytes } from "./format-bytes";
import type { MessageDetail } from "./types";

export function MinimizedComposer({
  subject,
  restoreRef,
  onRestore,
  onClose,
}: {
  subject: string;
  restoreRef?: Ref<HTMLButtonElement>;
  onRestore: () => void;
  onClose: () => void;
}) {
  return (
    <section
      aria-label="Minimized message composer"
      className="animate-rise bg-surface ring-border fixed right-6 bottom-6 z-50 flex h-13 w-[min(380px,calc(100vw-2rem))] items-center gap-1 rounded-xl pr-1.5 pl-4 shadow-2xl ring-1"
    >
      <button
        ref={restoreRef}
        type="button"
        className="focus-visible:ring-ring min-w-0 flex-1 truncate rounded-sm text-left text-sm font-semibold outline-none focus-visible:ring-2"
        onClick={onRestore}
      >
        {subject || "New message"}
      </button>
      <Button variant="ghost" size="icon-sm" onClick={onRestore}>
        <ChevronUp />
        <span className="sr-only">Restore composer</span>
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onClose}>
        <X />
        <span className="sr-only">Close composer</span>
      </Button>
    </section>
  );
}

export function ComposeWindowHeader({
  from,
  minimizeRef,
  onMinimize,
  onDiscard,
  onClose,
}: {
  from: string;
  minimizeRef?: Ref<HTMLButtonElement>;
  onMinimize: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  return (
    <header className="border-border/70 bg-surface-sunken/70 flex h-12 shrink-0 items-center gap-1 border-b pr-1.5 pl-4 sm:rounded-t-xl">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">New message</p>
        <p className="text-muted-foreground truncate text-[11px]">
          From {from}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Discard draft"
        onClick={onDiscard}
      >
        <Trash2 />
        <span className="sr-only">Discard draft</span>
      </Button>
      <Button
        ref={minimizeRef}
        className="hidden sm:inline-flex"
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onMinimize}
      >
        <Minus />
        <span className="sr-only">Minimize composer</span>
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onClose}>
        <X />
        <span className="sr-only">Close composer</span>
      </Button>
    </header>
  );
}

export function ForwardedMessageNotice({
  message,
}: {
  message: Pick<
    MessageDetail,
    "fromAddress" | "fromName" | "preview" | "subject"
  >;
}) {
  return (
    <div className="border-border/70 bg-primary/8 shrink-0 border-b px-4 py-2.5 text-xs">
      <p className="font-semibold">
        Forwarding {message.fromName || message.fromAddress}
      </p>
      <p className="text-muted-foreground mt-0.5 truncate">
        {message.subject} · {message.preview}
      </p>
    </div>
  );
}

export function ComposeWindowFooter({
  fileInput,
  inlineFileInput,
  uploads,
  error,
  sending,
  sendDisabled,
  onAddAttachments,
  onAddInlineImages,
}: {
  fileInput: RefObject<HTMLInputElement | null>;
  inlineFileInput: RefObject<HTMLInputElement | null>;
  uploads: readonly ComposerAsset[];
  error: string | null;
  sending: boolean;
  sendDisabled: boolean;
  onAddAttachments: (files: File[]) => void;
  onAddInlineImages: (files: File[]) => void;
}) {
  return (
    <footer className="border-border/70 bg-surface-sunken/70 flex min-h-14 shrink-0 items-center gap-2 border-t px-3 py-2 sm:rounded-b-xl">
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        disabled={sending}
        multiple
        onChange={(event) => {
          onAddAttachments(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <input
        ref={inlineFileInput}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        disabled={sending}
        onChange={(event) => {
          onAddInlineImages(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button type="submit" disabled={sendDisabled}>
        {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
        Send
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Add attachments"
        disabled={sending}
        onClick={() => fileInput.current?.click()}
      >
        <Paperclip />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Insert inline image"
        disabled={sending}
        onClick={() => inlineFileInput.current?.click()}
      >
        <ImagePlus />
      </Button>
      <span
        className={cn(
          "text-muted-foreground min-w-0 flex-1 truncate text-[11px]",
          error && "text-destructive"
        )}
      >
        {error ||
          (uploads.length
            ? `${uploads.length} files · ${formatBytes(
                uploads.reduce((total, upload) => total + upload.size, 0)
              )}`
            : "Drop files into message · up to 500 MB")}
      </span>
    </footer>
  );
}
