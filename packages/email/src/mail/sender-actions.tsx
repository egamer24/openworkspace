import { useState } from "react";
import { toast } from "sonner";

import { FilterMessagesDialog } from "./mailbox-rules";
import {
  BlockSenderDialog,
  senderLabel,
  UnsubscribeDialog,
} from "./sender-dialogs";
import type { Mailbox, MessageDetail } from "./types";
import {
  useNotSpam,
  useReportMessage,
  useTrustSender,
  useUnblockSender,
} from "./use-mail-safety";

type SenderDialogKind = "unsubscribe" | "block" | "filter";

/**
 * Sender-level actions (unsubscribe, block, filter, report, trust) and their
 * confirmation dialogs, shared by the message menus and the command bar.
 */
export function useSenderActions({
  mailbox,
  onLeaveConversation,
  onOpenConversation,
}: {
  mailbox?: Mailbox;
  /** Called after an action moved the open conversation out of the current folder. */
  onLeaveConversation: () => void;
  /** Called with the conversation a message rejoined (Not spam) and its folder, to open it instead. */
  onOpenConversation: (conversationId: string, folder: string) => void;
}) {
  const [dialog, setDialog] = useState<{
    kind: SenderDialogKind;
    message: MessageDetail;
    open: boolean;
  } | null>(null);

  const report = useReportMessage();
  const unblock = useUnblockSender();
  const trust = useTrustSender();
  const notSpam = useNotSpam();

  function setOpen(open: boolean) {
    setDialog((current) => current && { ...current, open });
  }

  function reportSpam(message: MessageDetail) {
    if (!mailbox) return;
    report.mutate(
      { mailboxId: mailbox.id, messageId: message.id },
      {
        onSuccess: (result) => {
          toast.success("Reported as spam");

          if (result.moved) onLeaveConversation();
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  function unblockSender(message: MessageDetail) {
    const block = message.sender?.block;

    if (!mailbox || !block || block.workspace) return;
    unblock.mutate(
      { mailboxId: mailbox.id, pattern: block.pattern },
      {
        onSuccess: () => toast.success(`Unblocked ${block.pattern}`),
        onError: (error) => toast.error(error.message),
      }
    );
  }

  function trustSender(message: MessageDetail) {
    if (!mailbox) return;
    trust.mutate(
      { mailboxId: mailbox.id, address: message.fromAddress, trusted: true },
      {
        onSuccess: () =>
          toast.success(`${senderLabel(message)} marked as safe`),
        onError: (error) => toast.error(error.message),
      }
    );
  }

  function markNotSpam(message: MessageDetail) {
    if (!mailbox) return;
    notSpam.mutate(
      { mailboxId: mailbox.id, messageId: message.id },
      {
        onSuccess: (result) => {
          toast.success(
            `${result.rejoined ? "Moved back to its conversation" : "Moved to Inbox"}. Mail from ${message.fromAddress} won't be treated as spam.`
          );

          if (result.rejoined) {
            onOpenConversation(result.conversationId, result.folder);
          } else {
            onLeaveConversation();
          }
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  const dialogs =
    dialog && mailbox ? (
      <>
        {dialog.kind === "unsubscribe" && (
          <UnsubscribeDialog
            message={dialog.message}
            mailbox={mailbox}
            open={dialog.open}
            onOpenChange={setOpen}
          />
        )}
        {dialog.kind === "block" && (
          <BlockSenderDialog
            message={dialog.message}
            mailbox={mailbox}
            open={dialog.open}
            onOpenChange={setOpen}
            onMoved={onLeaveConversation}
          />
        )}
        {dialog.kind === "filter" && (
          <FilterMessagesDialog
            mailboxId={mailbox.id}
            message={dialog.message}
            open={dialog.open}
            onOpenChange={setOpen}
          />
        )}
      </>
    ) : null;

  return {
    open: (kind: SenderDialogKind, message: MessageDetail) =>
      setDialog({ kind, message, open: true }),
    reportSpam,
    unblockSender,
    trustSender,
    markNotSpam,
    pending:
      report.isPending ||
      unblock.isPending ||
      trust.isPending ||
      notSpam.isPending,
    dialogs,
  };
}

export type SenderActions = ReturnType<typeof useSenderActions>;

export function canUnsubscribe(message: MessageDetail) {
  const methods = message.security?.listUnsubscribe;

  return Boolean(
    message.direction === "incoming" && (methods?.httpsUrl || methods?.mailto)
  );
}
