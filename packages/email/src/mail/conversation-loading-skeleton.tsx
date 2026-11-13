import { Skeleton } from "@open-workspace/core/ui";
import { format, isThisYear, isToday } from "date-fns";

import { messageTextClassName } from "./email-html-body";
import { SenderAvatar } from "./sender-security";
import type { ConversationSummary } from "./types";

function previewDate(value: string) {
  const date = new Date(value);

  if (isToday(date)) return format(date, "HH:mm");

  if (isThisYear(date)) return format(date, "MMM d, HH:mm");

  return format(date, "MMM d, yyyy");
}

/**
 * What the list already knows about a conversation that is loading: its
 * subject, latest sender, date and text preview, laid out like the reader,
 * with the body still to come.
 */
function ConversationPreview({ summary }: { summary: ConversationSummary }) {
  const sender = summary.fromName || summary.fromAddress;

  return (
    <section
      aria-label="Loading conversation"
      aria-busy="true"
      data-testid="conversation-preview"
      className="mx-auto w-full max-w-[60rem] pb-10"
    >
      <header className="px-4 pt-5 pb-4 sm:px-6 sm:pt-6">
        <h1 className="text-[1.3125rem] leading-[1.3] font-semibold tracking-[-0.018em] text-balance [overflow-wrap:anywhere]">
          {summary.subject || "(no subject)"}
        </h1>
        {summary.messageCount > 1 && (
          <p className="text-muted-foreground mt-1 text-xs">
            {summary.messageCount} messages
          </p>
        )}
      </header>
      <div className="border-border border-y px-4 pt-4 pb-5 sm:px-6">
        <div className="flex items-start gap-3">
          <SenderAvatar
            name={sender}
            logoUrl={summary.senderLogoUrl}
            className="mt-0.5 size-9 rounded-full text-[12px]"
          />
          <div className="flex min-h-7 min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {sender}
            </span>
            <time
              dateTime={summary.timelineAt}
              className="text-muted-foreground shrink-0 text-xs tabular-nums"
            >
              {previewDate(summary.timelineAt)}
            </time>
          </div>
        </div>
        <div className="mt-4 min-w-0 @lg/reader:pl-12">
          {summary.preview && (
            <p className={`${messageTextClassName} text-muted-foreground`}>
              {summary.preview}
            </p>
          )}
          <div aria-hidden="true" className="mt-3 max-w-[72ch] space-y-2.5">
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Mirrors the reader layout: subject, meta line, then a collapsed and an open message. */
export function ConversationLoadingSkeleton({
  summary,
}: { summary?: ConversationSummary } = {}) {
  if (summary) return <ConversationPreview summary={summary} />;

  return (
    <section
      aria-label="Loading conversation"
      aria-busy="true"
      className="mx-auto w-full max-w-[60rem] pb-10"
    >
      <div className="px-4 pt-6 pb-4 sm:px-6">
        <Skeleton className="h-6 w-3/5 max-w-md" />
        <Skeleton className="mt-2.5 h-3 w-48" />
      </div>
      <div className="border-border border-y">
        <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="border-border border-t px-4 pt-4 pb-6 sm:px-6">
          <div className="flex items-start gap-3">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex-1 pt-1">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="mt-2 h-3 w-56" />
            </div>
          </div>
          <div className="mt-5 max-w-[72ch] space-y-2.5 @lg/reader:pl-12">
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3.5 w-2/5" />
          </div>
        </div>
      </div>
    </section>
  );
}
