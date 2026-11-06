import { format, isThisYear, isToday, isYesterday } from "date-fns";
import { CircleAlert, FilePen, LoaderCircle, Paperclip, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DraftSummary } from "./use-draft-autosave";

function shortDate(value: string | Date) {
  const date = new Date(value);
  if (isToday(date)) return format(date, "HH:mm");
  if (isYesterday(date)) return "Yesterday";
  if (isThisYear(date)) return format(date, "MMM d");
  return format(date, "MMM d, yyyy");
}

const kindLabels = { reply: "Reply", forward: "Forward" } as const;

export function DraftList({
  drafts,
  loading,
  error,
  openingId,
  onRetry,
  onOpen,
}: {
  drafts: DraftSummary[] | undefined;
  loading: boolean;
  error?: string;
  openingId: string | null;
  onRetry: () => void;
  onOpen: (draft: DraftSummary) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-5 py-6 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Loading drafts…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-5 py-4">
        <p className="flex items-center gap-2 text-sm text-destructive">
          <CircleAlert className="size-4" /> {error}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw /> Retry
        </Button>
      </div>
    );
  }
  if (!drafts?.length) {
    return (
      <div className="grid min-h-80 place-items-center rounded-xl border border-border bg-surface px-8 py-16 text-center">
        <div>
          <span className="mx-auto grid size-12 place-items-center rounded-lg bg-surface-sunken text-muted-foreground ring-1 ring-border">
            <FilePen className="size-6" strokeWidth={1.75} />
          </span>
          <p className="mt-4 text-base font-semibold tracking-[-0.01em]">No drafts</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
            Messages you start writing are saved here automatically.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="divide-y divide-border/60">
        {drafts.map((draft) => (
          <button
            key={draft.id}
            type="button"
            disabled={openingId !== null}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset sm:px-5"
            onClick={() => onOpen(draft)}
          >
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[0.9375rem] leading-6 font-semibold">
                  {draft.to.length ? draft.to.join(", ") : "(no recipients)"}
                </span>
                {draft.kind !== "compose" ? (
                  <Badge variant="outline">{kindLabels[draft.kind]}</Badge>
                ) : null}
              </span>
              <span className="mt-0.5 block truncate text-sm text-foreground/90">
                {draft.subject || "(no subject)"}
                {draft.preview ? (
                  <span className="text-muted-foreground"> — {draft.preview}</span>
                ) : null}
              </span>
            </span>
            <span className="flex items-center gap-2 pt-0.5 text-xs text-muted-foreground tabular-nums">
              {openingId === draft.id ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {draft.attachmentCount ? <Paperclip className="size-3.5" aria-label="Has attachments" /> : null}
              {shortDate(draft.updatedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
