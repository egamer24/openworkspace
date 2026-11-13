import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@open-workspace/core/ui";
import type { ReactNode } from "react";

import { fullDate } from "./message-format";
import { verdictCopy } from "./sender-authentication";
import type { MessageDetail } from "./types";

/** A badge whose explanation shows on hover. */
function HintBadge({
  hint,
  className,
  children,
  ...props
}: {
  hint: string;
  className: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} {...props} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Why the sender is blocked: a button, so the pattern opens on tap and from
 * the keyboard as well as on hover.
 */
function BlockedBadge({
  block,
}: {
  block: NonNullable<MessageDetail["sender"]>["block"] & {};
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={300}
        className="bg-destructive/8 text-destructive focus-visible:ring-ring shrink-0 rounded-sm px-1 py-px text-[10.5px] font-medium outline-none focus-visible:ring-2"
      >
        Blocked
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-auto max-w-xs px-3 py-2 text-xs"
      >
        {block.workspace
          ? `Blocked for everyone by an administrator (${block.pattern})`
          : `You blocked ${block.pattern}`}
      </PopoverContent>
    </Popover>
  );
}

/** The sender's name with its badges (You, via, External, New sender, Blocked); collapses the message when it can. */
export function SenderLine({
  message,
  sender,
  own,
  onCollapse,
}: {
  message: MessageDetail;
  sender: string;
  own: boolean;
  onCollapse?: () => void;
}) {
  const { security } = message;

  const content = (
    <>
      <span className="text-foreground truncate text-[13.5px] font-semibold">
        {sender}
      </span>
      {own && (
        <span className="bg-accent text-accent-foreground shrink-0 rounded-sm px-1 py-px text-[10.5px] font-semibold">
          You
        </span>
      )}
      {security?.via && (
        <HintBadge
          className="text-muted-foreground hidden min-w-0 shrink truncate text-xs @md/reader:inline"
          hint={`Sent through ${security.via} on behalf of ${security.fromDomain ?? message.fromAddress}`}
        >
          via {security.via}
        </HintBadge>
      )}
      {security?.external && !own && (
        <HintBadge
          className="text-muted-foreground ring-border shrink-0 rounded-sm px-1 py-px text-[10.5px] font-medium ring-1 ring-inset"
          hint="This sender is outside your organization"
        >
          External
        </HintBadge>
      )}
      {security?.firstTimeSender && !own && !security.warnings.length && (
        <HintBadge
          data-testid="first-time-sender"
          className="bg-info/10 text-info hidden shrink-0 rounded-sm px-1 py-px text-[10.5px] font-medium @sm/reader:inline"
          hint="This is the first message from this address, and this mailbox has never written to it"
        >
          New sender
        </HintBadge>
      )}
    </>
  );

  const blocked = message.sender?.block ? (
    <BlockedBadge block={message.sender.block} />
  ) : null;

  const className = "flex min-w-0 shrink items-center gap-1.5 text-left";

  if (!onCollapse) {
    return (
      <div className={className}>
        {content}
        {blocked}
      </div>
    );
  }

  return (
    // The Blocked badge is a button of its own, so it sits beside the collapse button, not in it.
    <div className={className}>
      <button
        type="button"
        aria-expanded="true"
        aria-label={`Collapse message from ${sender}`}
        onClick={onCollapse}
        className={cn(
          className,
          "focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
        )}
      >
        {content}
      </button>
      {blocked}
    </div>
  );
}

/** The expanded header's full From/To/Date list, with one line about the sender's authentication. */
export function MessageDetails({
  message,
  onShowOriginal,
}: {
  message: MessageDetail;
  onShowOriginal?: () => void;
}) {
  const rows: [string, ReactNode][] = [
    [
      "From",
      message.fromName
        ? `${message.fromName} <${message.fromAddress}>`
        : message.fromAddress,
    ],
    ["To", message.toAddresses.join(", ") || "—"],
  ];

  if (message.ccAddresses.length) {
    rows.push(["Cc", message.ccAddresses.join(", ")]);
  }

  if (message.bccAddresses.length) {
    rows.push(["Bcc", message.bccAddresses.join(", ")]);
  }

  if (message.replyToAddresses.length) {
    rows.push(["Reply-to", message.replyToAddresses.join(", ")]);
  }

  if (message.viaList) rows.push(["Mailing list", message.viaList]);
  rows.push(["Date", fullDate(message.timelineAt)]);
  // One security line; the full analysis (IP, AI check, headers) lives in Show original.
  const { security } = message;

  if ((security && security.verdict !== "unavailable") || onShowOriginal) {
    const verdict =
      security && security.verdict !== "unavailable"
        ? verdictCopy[security.verdict]
        : null;

    // An authentic signature on a message forwarded from someone else's account is not reassurance.
    const copy =
      verdict &&
      security?.warnings.some(
        (warning) => warning.kind === "addressed_elsewhere"
      )
        ? {
            ...verdict,
            title:
              security.verdict === "verified"
                ? "Signed, but forwarded"
                : verdict.title,
            tone: "warn" as const,
          }
        : verdict;

    rows.push([
      "Security",
      // oxlint-disable-next-line react/jsx-key -- a [label, value] row, rendered with the label as key
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
        {copy && (
          <span
            className={cn(
              copy.tone === "pass" && "text-success",
              copy.tone === "warn" && "text-amber-700 dark:text-amber-300"
            )}
          >
            {copy.title}
          </span>
        )}
        {security?.signedBy && (
          <span className="text-muted-foreground">
            · signed by {security.signedBy}
          </span>
        )}
        {security?.forwardedVia && (
          <span className="text-muted-foreground">
            · forwarded via {security.forwardedVia}
          </span>
        )}
        {onShowOriginal && (
          <button
            type="button"
            className="text-foreground font-medium hover:underline"
            onClick={onShowOriginal}
          >
            {copy ? "· Details" : "Show original"}
          </button>
        )}
      </span>,
    ]);
  }

  return (
    <dl className="bg-surface-sunken ring-border mt-3 grid max-w-2xl grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg px-3.5 py-3 text-xs ring-1 @lg/reader:ml-12">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="[overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
