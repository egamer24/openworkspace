import { Button, cn } from "@open-workspace/core/ui";
import { ChevronDown, Ellipsis, Eye, Paperclip, RotateCw } from "lucide-react";
import { useState } from "react";

import { DeliveryIndicator } from "./delivery-indicator";
import { canRetry, MessageActions } from "./message-actions";
import type { MessageHandlers } from "./message-actions";
import { MessageAttachments } from "./message-attachments";
import {
  compactDate,
  fullDate,
  isOwnAddress,
  listFormat,
  recipientSummary,
  senderName,
  shortDate,
} from "./message-format";
import { MessageDetails, SenderLine } from "./message-header";
import {
  MessageBody,
  TranslationBar,
  useMessageTranslation,
} from "./message-translation";
import {
  SenderAvatar,
  SenderSecurityBanner,
  SenderStatusNotice,
  SubscriptionAction,
} from "./sender-security";
import type { Mailbox, MessageDetail } from "./types";
import { useVisibleMessageRead } from "./use-visible-message-read";

/**
 * One message in the conversation stack: a one-line summary while collapsed,
 * a full header, body, attachments and actions while expanded.
 */
export function ConversationMessage({
  message,
  mailbox,
  defaultExpanded,
  collapsible,
  showViewedBy,
  resendPending,
  handlers,
}: {
  message: MessageDetail;
  mailbox?: Mailbox;
  defaultExpanded: boolean;
  collapsible: boolean;
  showViewedBy: boolean;
  resendPending: boolean;
  handlers: MessageHandlers;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const shown = expanded || !collapsible;
  const outgoing = message.direction === "outgoing";

  const visibilityRef = useVisibleMessageRead({
    enabled: !message.isRead && (!outgoing || showViewedBy),
    messageId: message.id,
    onVisible: handlers.onViewed,
  });

  return (
    <section
      ref={visibilityRef}
      data-message-id={message.id}
      data-expanded={shown || undefined}
      className="group/message border-border relative border-t first:border-t-0"
    >
      {outgoing && (
        <span
          aria-hidden="true"
          className="bg-primary/55 absolute inset-y-0 left-0 w-0.5"
        />
      )}
      {shown ? (
        <ExpandedMessage
          message={message}
          mailbox={mailbox}
          showViewedBy={showViewedBy}
          resendPending={resendPending}
          handlers={handlers}
          onCollapse={collapsible ? () => setExpanded(false) : undefined}
        />
      ) : (
        <CollapsedMessage
          message={message}
          mailbox={mailbox}
          onExpand={() => setExpanded(true)}
        />
      )}
    </section>
  );
}

function CollapsedMessage({
  message,
  mailbox,
  onExpand,
}: {
  message: MessageDetail;
  mailbox?: Mailbox;
  onExpand: () => void;
}) {
  const sender = senderName(message);
  const own = isOwnAddress(message.fromAddress, mailbox);

  return (
    <button
      type="button"
      aria-expanded="false"
      aria-label={`Show message from ${sender}, ${shortDate(message.timelineAt)}`}
      onClick={onExpand}
      className="focus-visible:ring-ring flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors outline-none hover:bg-(--row-hover) focus-visible:bg-(--row-hover) focus-visible:ring-2 focus-visible:ring-inset sm:px-6"
    >
      <SenderAvatar
        name={sender}
        logoUrl={message.senderLogoUrl}
        className="size-7 rounded-full text-[10.5px]"
      />
      <span className="flex max-w-[45%] shrink-0 items-baseline gap-1.5 truncate">
        <span className="truncate text-[13px] font-semibold">{sender}</span>
        {own && (
          <span className="text-muted-foreground text-[11px] font-medium">
            You
          </span>
        )}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">
        {message.preview || message.bodyText || "No text body"}
      </span>
      {message.attachments.length > 0 && (
        <Paperclip
          aria-label="Has attachments"
          className="text-muted-foreground size-3.5 shrink-0"
        />
      )}
      <time
        dateTime={new Date(message.timelineAt).toISOString()}
        className="text-muted-foreground shrink-0 text-xs tabular-nums"
      >
        {compactDate(message.timelineAt)}
      </time>
    </button>
  );
}

function ExpandedMessage({
  message,
  mailbox,
  showViewedBy,
  resendPending,
  handlers,
  onCollapse,
}: {
  message: MessageDetail;
  mailbox?: Mailbox;
  showViewedBy: boolean;
  resendPending: boolean;
  handlers: MessageHandlers;
  onCollapse?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const translation = useMessageTranslation(message, mailbox?.id);
  const sender = senderName(message);
  const own = isOwnAddress(message.fromAddress, mailbox);
  const outgoing = message.direction === "outgoing";

  const viewedBy = showViewedBy
    ? message.viewedBy.map((viewer) => viewer.name)
    : [];

  return (
    <div className="animate-fade-in px-4 pt-4 pb-5 sm:px-6">
      <header className="flex items-start gap-3">
        <SenderAvatar
          name={sender}
          logoUrl={message.senderLogoUrl}
          className="mt-0.5 size-9 rounded-full text-[12px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-7 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <SenderLine
                message={message}
                sender={sender}
                own={own}
                onCollapse={onCollapse}
              />
              <SubscriptionAction
                message={message}
                onUnsubscribe={handlers.sender?.onUnsubscribe}
              />
            </div>
            <span className="text-muted-foreground flex shrink-0 items-center gap-2.5 text-xs">
              {outgoing && <DeliveryIndicator message={message} />}
              <time
                dateTime={new Date(message.timelineAt).toISOString()}
                title={fullDate(message.timelineAt)}
                className="tabular-nums"
              >
                {shortDate(message.timelineAt)}
              </time>
            </span>
            <MessageActions
              message={message}
              canForward={Boolean(mailbox?.canSend)}
              mailboxId={mailbox?.id}
              translation={translation}
              resendPending={resendPending}
              handlers={handlers}
            />
          </div>
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mt-0.5 flex max-w-full min-w-0 items-center gap-1 rounded-sm text-left text-xs outline-none focus-visible:ring-2"
          >
            <span className="truncate">
              {recipientSummary(message, mailbox)}
            </span>
            <ChevronDown
              className={cn(
                "size-3 shrink-0 transition-transform",
                detailsOpen && "rotate-180"
              )}
            />
            <span className="sr-only">
              {detailsOpen ? "Hide message details" : "Show message details"}
            </span>
          </button>
        </div>
      </header>

      {detailsOpen && (
        <MessageDetails
          message={message}
          onShowOriginal={handlers.onShowOriginal}
        />
      )}

      <SenderStatusNotice
        message={message}
        onUnblock={handlers.sender?.onUnblock}
      />
      <SenderSecurityBanner
        message={message}
        onShowOriginal={handlers.onShowOriginal}
        onTrust={handlers.sender?.onTrust}
      />

      {canRetry(message) && (
        <RetryNotice
          message={message}
          pending={resendPending}
          onResend={handlers.onResend}
        />
      )}

      <div className="mt-4 min-w-0 @lg/reader:pl-12">
        <TranslationBar translation={translation} />
        <MessageBody
          message={message}
          mailboxId={mailbox?.id}
          translation={translation}
        />
        {message.quotedText && <QuotedText text={message.quotedText} />}
        <MessageAttachments
          messageId={message.id}
          mailboxId={mailbox?.id}
          attachments={message.attachments}
        />
        {viewedBy.length > 0 && (
          <p className="text-muted-foreground mt-4 flex items-center gap-1.5 text-xs">
            <Eye className="size-3.5" />
            <span>Viewed by {listFormat(viewedBy)}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function RetryNotice({
  message,
  pending,
  onResend,
}: {
  message: MessageDetail;
  pending: boolean;
  onResend: () => void;
}) {
  const failed = message.transportState === "failed";

  return (
    <div
      className={cn(
        "mt-3 flex items-center gap-3 rounded-md px-3 py-2 text-xs @lg/reader:ml-12",
        failed
          ? "bg-destructive/8 text-destructive"
          : "bg-warning/12 text-amber-800 dark:text-amber-300"
      )}
    >
      <span className="min-w-0 flex-1">
        {failed
          ? message.transportError || "This message could not be sent."
          : "Submission was not confirmed. Sending again may deliver a duplicate."}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={onResend}
      >
        <RotateCw className={cn(pending && "animate-spin")} />
        {failed ? "Retry" : "Send again"}
      </Button>
    </div>
  );
}

function QuotedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="bg-muted text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2"
      >
        <Ellipsis className="size-3.5" />
        {open ? "Hide quoted text" : "Show quoted text"}
      </button>
      {open && (
        <blockquote className="border-border text-muted-foreground mt-2 max-h-80 max-w-[72ch] overflow-auto border-l-2 pl-3 text-[13px] leading-[1.6] whitespace-pre-wrap">
          {text}
        </blockquote>
      )}
    </div>
  );
}
