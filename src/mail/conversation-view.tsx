import { format } from "date-fns";
import {
  Archive,
  ArrowLeft,
  CircleAlert,
  ChevronDown,
  ChevronUp,
  FileText,
  Forward,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/auth-context";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
} from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { baseSubject } from "../../shared/mail";
import {
  ConversationReply,
  ReplyActionIcon,
  type SentReply,
} from "./conversation-reply";
import { ConversationLoadingSkeleton } from "./conversation-loading-skeleton";
import { DeliveryIndicator } from "./delivery-indicator";
import { InvitationCard } from "./invitation-card";
import { MessageAttachments } from "./message-attachments";
import { notifyOutboundResult } from "./outbound-notification";
import { MessageTranslation } from "./message-translation";
import { ToolbarTooltip } from "./toolbar-tooltip";
import { useResendMessage, useSetMessageRead } from "./use-mail-data";
import { useVisibleMessageRead } from "./use-visible-message-read";
import type {
  Mailbox,
  MessageDetail,
  ReplyAction,
  ReplyActionMode,
} from "./types";

type ReplySelection = {
  parentId: string;
  mode: ReplyActionMode;
};

export function ConversationView({
  messages,
  messageCount,
  hasOlderMessages,
  loadingOlder,
  olderMessagesError,
  loading,
  error,
  mailbox,
  mailboxState,
  folderName,
  sharedActionPending,
  onRetry,
  onLoadOlder,
  onBack,
  onArchive,
  onRestore,
  onTrash,
  onMarkRead,
  onMarkUnread,
  onForward,
  onOpenConversation,
}: {
  messages: MessageDetail[];
  messageCount: number;
  hasOlderMessages: boolean;
  loadingOlder: boolean;
  olderMessagesError: boolean;
  loading: boolean;
  error?: string;
  mailbox?: Mailbox;
  mailboxState: "active" | "archive" | "spam" | "trash";
  folderName: string;
  sharedActionPending: boolean;
  onRetry: () => void;
  onLoadOlder: () => void;
  onBack: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onTrash: () => void;
  onMarkRead?: () => void;
  onMarkUnread?: () => void;
  onForward: (message: MessageDetail) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [replySelection, setReplySelection] = useState<ReplySelection | null>(null);
  const resendMessage = useResendMessage();
  const setMessageRead = useSetMessageRead();

  if (loading) {
    return <ConversationLoadingSkeleton />;
  }
  if (error) {
    return (
      <section className="w-full px-3 sm:px-6">
        <div className="flex h-14 items-center border-b border-border/70">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft /> Back</Button>
        </div>
        <div className="grid min-h-72 place-items-center py-16 text-center">
          <div>
            <span className="mx-auto grid size-12 place-items-center rounded-lg bg-destructive/10 text-destructive">
              <CircleAlert className="size-6" strokeWidth={1.75} />
            </span>
            <p className="mt-4 text-base font-semibold">Could not load this conversation</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">{error}</p>
            <Button className="mt-5" variant="outline" size="sm" onClick={onRetry}>
              <RotateCw /> Retry
            </Button>
          </div>
        </div>
      </section>
    );
  }
  const latest = messages.at(-1);
  if (!latest) return null;
  const conversationSubject = baseSubject(latest.subject);
  const explicitlySelected = messages.find(
    (message) => message.id === replySelection?.parentId && message.replyPlan.actions.length > 0,
  );
  const selectedParent = explicitlySelected ?? null;
  const selectedMode = selectedParent && replySelection
    ? replySelection.mode
    : null;

  function handleSent(result: SentReply) {
    setReplySelection(null);
    if (result.detached) onOpenConversation(result.conversationId);
  }

  function resend(message: MessageDetail) {
    if (!mailbox) return;
    if (
      message.transportState === "unconfirmed"
      && !window.confirm(
        "The original submission was not confirmed. Sending again can deliver a duplicate. Send again?",
      )
    ) {
      return;
    }
    resendMessage.mutate(
      { id: message.id, mailboxId: mailbox.id },
      {
        onSuccess: (result) => notifyOutboundResult(result, "message"),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  async function markViewed(messageId: string) {
    if (!mailbox) return;
    await setMessageRead.mutateAsync({
      id: messageId,
      mailboxId: mailbox.id,
      isRead: true,
    });
  }

  return (
    <article className="w-full px-3 pb-24 sm:px-6 lg:pb-10">
      <TooltipProvider delay={300}>
        <header className="sticky top-0 z-30 -mx-3 flex h-12 items-center gap-1 border-b border-border bg-surface px-3 sm:-mx-6 sm:px-6">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
          <Separator orientation="vertical" className="mx-2.5 h-5" />
          {mailboxState === "active" ? (
            <ConversationToolbarButton
              label="Archive conversation"
              disabled={sharedActionPending}
              onClick={onArchive}
            >
              <Archive />
            </ConversationToolbarButton>
          ) : (
            <ConversationToolbarButton
              label={mailboxState === "spam" ? "Mark as not spam" : "Restore conversation"}
              disabled={sharedActionPending}
              onClick={onRestore}
            >
              <Inbox />
            </ConversationToolbarButton>
          )}
          {mailboxState !== "trash" && (
            <ConversationToolbarButton
              label="Move conversation to trash"
              disabled={sharedActionPending}
              onClick={onTrash}
            >
              <Trash2 />
            </ConversationToolbarButton>
          )}
          {onMarkRead ? (
            <ConversationToolbarButton
              label="Mark conversation as read"
              disabled={sharedActionPending}
              onClick={onMarkRead}
            >
              <MailOpen />
            </ConversationToolbarButton>
          ) : onMarkUnread ? (
            <ConversationToolbarButton
              label="Mark conversation as unread"
              disabled={sharedActionPending}
              onClick={onMarkUnread}
            >
              <Mail />
            </ConversationToolbarButton>
          ) : null}
          <span className="ml-auto hidden truncate pl-4 text-xs text-muted-foreground sm:block">
            {folderName} · {messageCount}{" "}
            {messageCount === 1 ? "message" : "messages"}
          </span>
        </header>
      </TooltipProvider>

      <div className="mx-auto max-w-4xl py-7 sm:py-10">
        <div className="mb-8 border-b border-border/70 pb-6">
          <p className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            {messageCount} {messageCount === 1 ? "message" : "messages"}
          </p>
          <h1 className="mt-2 text-[1.5rem] leading-[1.2] font-semibold tracking-[-0.025em] text-balance sm:text-[1.875rem]">
            {conversationSubject}
          </h1>
        </div>

        {hasOlderMessages ? (
          <div className="mb-6 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadingOlder}
              onClick={onLoadOlder}
            >
              {loadingOlder
                ? <LoaderCircle className="animate-spin" />
                : <ChevronUp />}
              {olderMessagesError ? "Retry earlier messages" : "Load earlier messages"}
            </Button>
          </div>
        ) : null}

        <BubbleGroup className="gap-1 pb-3">
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const audience = previous ? audienceChange(previous, message) : null;
            return (
              <div key={message.id} className="contents">
                {audience && <AudienceChange text={audience} />}
                <MessageBubble
                  message={message}
                  mailboxId={mailbox?.id}
                  showAvatar={shouldShowAvatar(previous, message)}
                  canForward={Boolean(mailbox?.canSend)}
                  showViewedBy={mailbox?.kind === "shared"}
                  onViewed={() => markViewed(message.id)}
                  onReply={(action) => setReplySelection({
                    parentId: message.id,
                    mode: action.mode,
                  })}
                  onRetry={() => resend(message)}
                  onForward={() => onForward(message)}
                  retryPending={resendMessage.isPending && resendMessage.variables?.id === message.id}
                />
              </div>
            );
          })}
        </BubbleGroup>

        {selectedParent && selectedMode && (
          <ConversationReply
            key={selectedParent.id}
            mailbox={mailbox}
            parent={selectedParent}
            mode={selectedMode}
            onModeChange={(mode) => setReplySelection({
              parentId: selectedParent.id,
              mode,
            })}
            onSent={handleSent}
          />
        )}
      </div>
    </article>
  );
}

function MessageBubble({
  message,
  mailboxId,
  showAvatar,
  canForward,
  showViewedBy,
  onViewed,
  onReply,
  onRetry,
  onForward,
  retryPending,
}: {
  message: MessageDetail;
  mailboxId?: string;
  showAvatar: boolean;
  canForward: boolean;
  showViewedBy: boolean;
  onViewed: () => Promise<void>;
  onReply: (action: ReplyAction) => void;
  onRetry: () => void;
  onForward: () => void;
  retryPending: boolean;
}) {
  const outgoing = message.direction === "outgoing";
  const sender = message.fromName || message.fromAddress;
  const [rendersHtml, setRendersHtml] = useState(false);
  const calendarEnabled = useAuth().modules.calendar;
  const visibilityRef = useVisibleMessageRead({
    enabled: !message.isRead && (!outgoing || showViewedBy),
    messageId: message.id,
    onVisible: onViewed,
  });
  const hasActions = message.replyPlan.actions.length > 0
    || canRetry(message)
    || canForward;
  const hasViewedBy = showViewedBy && message.viewedBy.length > 0;

  return (
    <section
      ref={visibilityRef}
      className={cn(
        "group/message flex items-start gap-2.5 pt-1 pb-6",
        outgoing && "justify-end",
      )}
      data-message-id={message.id}
    >
      {!outgoing && (
        showAvatar
          ? (
              <Avatar className="mt-6 size-9 shrink-0">
                <AvatarFallback className="text-[11px]">{initials(sender)}</AvatarFallback>
              </Avatar>
            )
          : <span className="w-9 shrink-0" aria-hidden="true" />
      )}

      <Bubble
        align={outgoing ? "end" : "start"}
        variant={outgoing ? "tinted" : "outline"}
        className={cn(
          "max-w-[calc(100%-2.75rem)] sm:max-w-[82%]",
          rendersHtml && "w-full",
          hasViewedBy && hasActions && "pb-6",
        )}
      >
        <MessageMetadata
          message={message}
          mailboxId={mailboxId}
          sender={sender}
          outgoing={outgoing}
        />
        <BubbleContent className="w-full min-w-36 px-4 py-3">
          {mailboxId && (message.bodyText || message.bodyHtml) ? (
            <MessageTranslation
              message={message}
              mailboxId={mailboxId}
              onRenderModeChange={setRendersHtml}
            />
          ) : (
            <div className="whitespace-pre-wrap text-[0.9375rem] leading-[1.65]">
              {message.bodyText || (message.quotedText ? "No new text" : message.preview || "No text body")}
            </div>
          )}

          {message.quotedText && (
            <Collapsible className="mt-3 border-t border-current/10 pt-2">
              <CollapsibleTrigger className="group/quote flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:underline">
                <ChevronDown className="size-3.5 transition-transform group-data-[panel-open]/quote:rotate-180" />
                Show quoted text
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border-l-2 border-primary/30 pl-3 text-xs leading-5 text-muted-foreground">
                {message.quotedText}
              </CollapsibleContent>
            </Collapsible>
          )}

          {calendarEnabled && mailboxId && message.invitation && !outgoing && (
            <InvitationCard mailboxId={mailboxId} messageId={message.id} invitation={message.invitation} />
          )}

          <MessageAttachments
            messageId={message.id}
            mailboxId={mailboxId}
            attachments={message.attachments}
          />

          <DeliveryIndicator message={message} />
        </BubbleContent>

        {hasViewedBy ? (
          <p className={cn(
            "px-1 text-[10px] font-medium text-muted-foreground",
            outgoing && "text-right",
          )}>
            Viewed by {viewedByNames(message.viewedBy.map((viewer) => viewer.name))}
          </p>
        ) : null}

        {hasActions && (
          <BubbleReactions
            align={outgoing ? "end" : "start"}
            className="opacity-100 transition-opacity md:opacity-0 md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100"
          >
            {message.replyPlan.actions.map((action) => (
              <Button
                key={action.mode}
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 rounded-full px-2 text-xs"
                aria-label={actionAriaLabel(action)}
                onClick={() => onReply(action)}
              >
                <ReplyActionIcon mode={action.mode} />
                <span className="hidden sm:inline">{actionButtonLabel(action)}</span>
              </Button>
            ))}
            {canForward && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 rounded-full px-2 text-xs"
                aria-label="Forward this message"
                onClick={onForward}
              >
                <Forward />
                <span className="hidden sm:inline">Forward</span>
              </Button>
            )}
            {canRetry(message) && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 rounded-full px-2 text-xs"
                disabled={retryPending}
                onClick={onRetry}
              >
                <RotateCw className={cn(retryPending && "animate-spin")} />
                <span className="hidden sm:inline">
                  {message.transportState === "failed" ? "Retry" : "Send again"}
                </span>
              </Button>
            )}
          </BubbleReactions>
        )}
      </Bubble>
    </section>
  );
}

function canRetry(message: MessageDetail) {
  return message.direction === "outgoing"
    && (
      message.transportState === "failed"
      || message.transportState === "unconfirmed"
    );
}

function ConversationToolbarButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <ToolbarTooltip label={label} side="bottom" sideOffset={6}>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
        <span className="sr-only">{label}</span>
      </Button>
    </ToolbarTooltip>
  );
}

function MessageMetadata({
  message,
  mailboxId,
  sender,
  outgoing,
}: {
  message: MessageDetail;
  mailboxId?: string;
  sender: string;
  outgoing: boolean;
}) {
  return (
    <details className={cn("group/meta max-w-full px-1 text-xs", outgoing && "text-right")}>
      <summary className={cn(
        "flex cursor-pointer list-none items-baseline gap-2 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:underline",
        outgoing && "justify-end",
      )}>
        <span className="min-w-0 truncate text-[0.8125rem] font-semibold text-foreground">{outgoing ? "You" : sender}</span>
        <time className="shrink-0 text-[11px] tabular-nums">{format(new Date(message.timelineAt), "MMM d · HH:mm")}</time>
        <ChevronDown className="size-3 shrink-0 transition-transform group-open/meta:rotate-180" />
      </summary>
      <dl className={cn(
        "mt-2 grid max-w-xl grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-surface-sunken px-3 py-2.5 text-left text-[11px] ring-1 ring-border",
        outgoing && "ml-auto",
      )}>
        <dt className="text-muted-foreground">From</dt><dd className="truncate">{message.fromAddress}</dd>
        <dt className="text-muted-foreground">To</dt><dd className="truncate">{message.toAddresses.join(", ")}</dd>
        {message.ccAddresses.length > 0 && <><dt className="text-muted-foreground">Cc</dt><dd className="truncate">{message.ccAddresses.join(", ")}</dd></>}
        {message.bccAddresses.length > 0 && <><dt className="text-muted-foreground">Bcc</dt><dd className="truncate">{message.bccAddresses.join(", ")}</dd></>}
        {message.replyToAddresses.length > 0 && <><dt className="text-muted-foreground">Reply-to</dt><dd className="truncate">{message.replyToAddresses.join(", ")}</dd></>}
        {message.aiClassification && (
          <>
            <dt className="text-muted-foreground">AI check</dt>
            <dd>
              <span className={message.aiClassification.spam ? "text-destructive" : "text-success"}>
                {message.aiClassification.spam ? "Spam" : "Passed"}
              </span>
              <span className="text-muted-foreground">
                {` · Spam score ${Math.round(message.aiClassification.spamConfidence * 100)}% · ${message.aiClassification.reason}`}
              </span>
            </dd>
          </>
        )}
        {message.hasOriginal && mailboxId && (
          <>
            <dt className="text-muted-foreground">Source</dt>
            <dd>
              <a
                className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                href={`/mail/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(message.id)}/original`}
                target="_blank"
                rel="noreferrer"
              >
                <FileText className="size-3" />
                Show original
              </a>
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

function AudienceChange({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-5 text-[11px] text-muted-foreground">
      <Separator className="flex-1 bg-border/70" />
      <span className="rounded-full bg-surface-sunken px-2.5 py-1 font-medium ring-1 ring-border">{text}</span>
      <Separator className="flex-1 bg-border/70" />
    </div>
  );
}

function shouldShowAvatar(previous: MessageDetail | undefined, message: MessageDetail) {
  if (message.direction === "outgoing") return false;
  return !previous
    || previous.direction !== "incoming"
    || previous.fromAddress !== message.fromAddress;
}

function audienceChange(previous: MessageDetail, current: MessageDetail) {
  const before = new Set(previous.replyPlan.participants);
  const after = new Set(current.replyPlan.participants);
  if (
    before.size === after.size
    && [...before].every((participant) => after.has(participant))
  ) return null;
  const added = current.replyPlan.participants.filter((value) => !before.has(value));
  const removed = previous.replyPlan.participants.filter((value) => !after.has(value));
  if (added.length && !removed.length) return `${added.join(", ")} joined`;
  if (removed.length && !added.length) return `${removed.join(", ")} left`;
  return "Recipients changed";
}

function actionButtonLabel(action: ReplyAction) {
  if (action.mode === "reply_all") return "Reply all";
  if (action.mode === "reply_list") return "Reply to list";
  if (action.mode === "continue") return "Continue";
  return "Reply";
}

function actionAriaLabel(action: ReplyAction) {
  return `${actionButtonLabel(action)} to this message`;
}

function initials(value: string) {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function viewedByNames(names: string[]) {
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(names);
}
