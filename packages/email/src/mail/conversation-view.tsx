import { Button, useConfirm } from "@open-workspace/core/ui";
import {
  ChevronUp,
  CircleAlert,
  Forward,
  LoaderCircle,
  RotateCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { baseSubject } from "../../shared/mail";
import { ConversationLoadingSkeleton } from "./conversation-loading-skeleton";
import { ConversationMessage } from "./conversation-message";
import { ConversationReply, ReplyActionIcon } from "./conversation-reply";
import type { SentReply } from "./conversation-reply";
import { actionButtonLabel } from "./message-actions";
import type { SenderHandlers } from "./message-actions";
import {
  OriginalMessageSheet,
  originalSourceUrl,
} from "./original-message-sheet";
import { notifyOutboundResult } from "./outbound-notification";
import { canUnsubscribe } from "./sender-actions";
import type { SenderActions } from "./sender-actions";
import type {
  ConversationSummary,
  Mailbox,
  MessageDetail,
  ReplyActionMode,
} from "./types";
import { useResendMessage, useSetMessageRead } from "./use-mail-data";

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
  onRetry,
  onLoadOlder,
  onForward,
  onOpenConversation,
  senderActions,
  reportable = false,
  summary,
}: {
  messages: MessageDetail[];
  messageCount: number;
  hasOlderMessages: boolean;
  loadingOlder: boolean;
  olderMessagesError: boolean;
  loading: boolean;
  error?: string;
  mailbox?: Mailbox;
  folderName: string;
  onRetry: () => void;
  onLoadOlder: () => void;
  onForward: (message: MessageDetail) => void;
  onOpenConversation: (conversationId: string) => void;
  /** Unsubscribe, block, report and filter actions with their dialogs. */
  senderActions?: SenderActions;
  /** Reporting moves the conversation to Spam, so it fits received mail outside Spam and Trash. */
  reportable?: boolean;
  /** The list's row for this conversation, shown while it loads. */
  summary?: ConversationSummary;
}) {
  const [replySelection, setReplySelection] = useState<ReplySelection | null>(
    null
  );

  const [originalMessageId, setOriginalMessageId] = useState<string | null>(
    null
  );

  const replyRegion = useRef<HTMLDivElement>(null);

  const canShowOriginal = (message: MessageDetail) =>
    Boolean(mailbox && message.hasOriginal);

  // ⌥⌘U (Ctrl+Alt+U elsewhere) opens the latest original in the thread.
  const shortcutTarget = [...messages].reverse().find(canShowOriginal);
  const shortcutTargetId = shortcutTarget?.id;
  const resendMessage = useResendMessage();
  const setMessageRead = useSetMessageRead();

  // Bring the composer into view and focus it whenever a reply target is picked.
  useEffect(() => {
    if (!replySelection) return;
    const region = replyRegion.current;
    region?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    region?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [replySelection]);

  useEffect(() => {
    if (!shortcutTargetId) return;

    const targetId = shortcutTargetId;

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyU" ||
        !event.altKey ||
        !(event.metaKey || event.ctrlKey)
      ) {
        return;
      }

      event.preventDefault();
      setOriginalMessageId(targetId);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutTargetId]);
  const { confirm, dialog: confirmDialog } = useConfirm();

  if (loading) {
    return <ConversationLoadingSkeleton summary={summary} />;
  }

  if (error) {
    return (
      <section className="grid min-h-80 place-items-center px-6 py-16 text-center">
        <div className="animate-fade-in">
          <span className="bg-destructive/10 text-destructive mx-auto grid size-10 place-items-center rounded-lg">
            <CircleAlert className="size-5" strokeWidth={1.75} />
          </span>
          <p className="mt-3.5 text-[14px] font-semibold">
            Could not load this conversation
          </p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-[13px] leading-5">
            {error}
          </p>
          <Button
            className="mt-4"
            variant="outline"
            size="sm"
            onClick={onRetry}
          >
            <RotateCw /> Retry
          </Button>
        </div>
      </section>
    );
  }

  const latest = messages.at(-1);

  if (!latest) return null;
  const { conversationId } = latest;
  const conversationSubject = baseSubject(latest.subject) || "(no subject)";

  const selectedParent =
    messages.find(
      (message) =>
        message.id === replySelection?.parentId &&
        message.replyPlan.actions.length > 0
    ) ?? null;

  const selectedMode =
    selectedParent && replySelection ? replySelection.mode : null;

  // Reply from the end of the thread answers the latest incoming message when there is one.
  const replyCandidates = [...messages]
    .reverse()
    .filter((message) => message.replyPlan.actions.length > 0);

  const replyTarget =
    replyCandidates.find((message) => message.direction === "incoming") ??
    replyCandidates[0];

  function handleSent(result: SentReply) {
    setReplySelection(null);

    // A detached reply starts its own conversation, and a reply from mail kept
    // out of its conversation as spam takes it back there: either way the
    // open one is not where the reply is (it may be gone).
    if (result.detached || result.conversationId !== conversationId) {
      onOpenConversation(result.conversationId);
    }
  }

  async function resend(message: MessageDetail) {
    if (!mailbox) return;

    if (
      message.transportState === "unconfirmed" &&
      !(await confirm({
        title: "Send this message again?",
        description:
          "The first attempt was never confirmed, so it may already have been delivered. Sending again can deliver a duplicate.",
        action: "Send again",
      }))
    ) {
      return;
    }

    resendMessage.mutate(
      { id: message.id, mailboxId: mailbox.id },
      {
        onSuccess: (result) => notifyOutboundResult(result, "message"),
        onError: (failure) => toast.error(failure.message),
      }
    );
  }

  async function markUnread(messageId: string) {
    if (!mailbox) return;

    try {
      await setMessageRead.mutateAsync({
        id: messageId,
        mailboxId: mailbox.id,
        conversationId,
        isRead: false,
      });
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "Could not mark as unread"
      );
    }
  }

  async function markViewed(messageId: string) {
    if (!mailbox) return;
    await setMessageRead.mutateAsync({
      id: messageId,
      mailboxId: mailbox.id,
      conversationId,
      isRead: true,
    });
  }

  return (
    <article className="mx-auto w-full max-w-[60rem] pb-10">
      {confirmDialog}
      <header className="px-4 pt-5 pb-4 sm:px-6 sm:pt-6">
        <h1 className="text-[1.3125rem] leading-[1.3] font-semibold tracking-[-0.018em] text-balance [overflow-wrap:anywhere]">
          {conversationSubject}
        </h1>
        {messageCount > 1 && (
          <p className="text-muted-foreground mt-1 text-xs">
            {messageCount} messages
          </p>
        )}
      </header>

      <div className="border-border border-y">
        {hasOlderMessages ? (
          <div className="border-border flex justify-center border-b py-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              disabled={loadingOlder}
              onClick={onLoadOlder}
            >
              {loadingOlder ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ChevronUp />
              )}
              {olderMessagesError
                ? "Retry earlier messages"
                : "Load earlier messages"}
            </Button>
          </div>
        ) : null}

        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const audience = previous ? audienceChange(previous, message) : null;

          return (
            <div key={message.id} className="contents">
              {audience && <AudienceChange text={audience} />}
              <ConversationMessage
                message={message}
                mailbox={mailbox}
                defaultExpanded={message === latest || !message.isRead}
                collapsible={messages.length > 1}
                showViewedBy={mailbox?.kind === "shared"}
                resendPending={
                  resendMessage.isPending &&
                  resendMessage.variables?.id === message.id
                }
                handlers={{
                  onViewed: () => markViewed(message.id),
                  onReply: (action) =>
                    setReplySelection({
                      parentId: message.id,
                      mode: action.mode,
                    }),
                  onForward: () => onForward(message),
                  onResend: () => resend(message),
                  onShowOriginal: canShowOriginal(message)
                    ? () => setOriginalMessageId(message.id)
                    : undefined,
                  originalUrl:
                    mailbox && message.hasOriginal
                      ? originalSourceUrl(mailbox.id, message.id)
                      : undefined,
                  onMarkUnread:
                    mailbox &&
                    message.direction === "incoming" &&
                    message.isRead
                      ? () => void markUnread(message.id)
                      : undefined,
                  sender:
                    message.direction === "incoming" && senderActions && mailbox
                      ? senderHandlers(message, senderActions, reportable)
                      : undefined,
                }}
              />
            </div>
          );
        })}
      </div>

      <div ref={replyRegion} className="scroll-mb-4 px-4 pt-4 sm:px-6">
        {selectedParent && selectedMode ? (
          <ConversationReply
            key={selectedParent.id}
            mailbox={mailbox}
            parent={selectedParent}
            mode={selectedMode}
            onModeChange={(mode) =>
              setReplySelection({
                parentId: selectedParent.id,
                mode,
              })
            }
            onCancel={() => setReplySelection(null)}
            onSent={handleSent}
          />
        ) : mailbox?.canSend ? (
          <div className="flex flex-wrap items-center gap-2">
            {replyTarget?.replyPlan.actions.map((action) => (
              <Button
                key={action.mode}
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setReplySelection({
                    parentId: replyTarget.id,
                    mode: action.mode,
                  })
                }
              >
                <ReplyActionIcon mode={action.mode} />
                {actionButtonLabel(action)}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onForward(latest)}
            >
              <Forward /> Forward
            </Button>
          </div>
        ) : null}
      </div>
      {mailbox && (
        <OriginalMessageSheet
          mailboxId={mailbox.id}
          message={
            messages.find((message) => message.id === originalMessageId) ?? null
          }
          onClose={() => setOriginalMessageId(null)}
        />
      )}
    </article>
  );
}

function senderHandlers(
  message: MessageDetail,
  actions: SenderActions,
  reportable: boolean
): SenderHandlers {
  return {
    onUnsubscribe: canUnsubscribe(message)
      ? () => actions.open("unsubscribe", message)
      : undefined,
    onBlock: () => actions.open("block", message),
    onFilter: () => actions.open("filter", message),
    onUnblock: () => actions.unblockSender(message),
    onReportSpam: reportable ? () => actions.reportSpam(message) : undefined,
    onTrust: message.sender?.trustedAt
      ? undefined
      : () => actions.trustSender(message),
  };
}

function AudienceChange({ text }: { text: string }) {
  return (
    <div className="border-border text-muted-foreground flex items-center gap-3 border-t px-4 py-2 text-[11px] sm:px-6">
      <span className="bg-border h-px flex-1" />
      <span className="font-medium">{text}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

function audienceChange(previous: MessageDetail, current: MessageDetail) {
  const before = new Set(previous.replyPlan.participants);
  const after = new Set(current.replyPlan.participants);

  if (
    before.size === after.size &&
    [...before].every((participant) => after.has(participant))
  ) {
    return null;
  }

  const added = current.replyPlan.participants.filter(
    (value) => !before.has(value)
  );

  const removed = previous.replyPlan.participants.filter(
    (value) => !after.has(value)
  );

  if (added.length && !removed.length) return `${added.join(", ")} joined`;

  if (removed.length && !added.length) return `${removed.join(", ")} left`;

  return "Recipients changed";
}
