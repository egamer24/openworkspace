import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TooltipProvider,
  cn,
} from "@open-workspace/core/ui";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  FolderInput,
  Inbox,
  Mail,
  MailOpen,
  OctagonAlert,
  ShieldBan,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ConversationView } from "./conversation-view";
import { folderShowsUnreadCount, orderedFolders } from "./mail-folders";
import { useSenderActions } from "./sender-actions";
import type { SenderActions } from "./sender-actions";
import { ToolbarTooltip } from "./toolbar-tooltip";
import type { MailController } from "./use-mail-controller";
import { useSenderIntelFill } from "./use-mail-data";

function CommandButton({
  label,
  shortLabel,
  icon,
  disabled,
  destructive = false,
  onClick,
}: {
  label: string;
  shortLabel: string;
  icon: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <ToolbarTooltip label={label} side="bottom">
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "text-foreground/80 h-8 gap-1.5 px-2 text-[13px] font-medium",
          destructive && "hover:bg-destructive/10 hover:text-destructive"
        )}
      >
        {icon}
        <span className="hidden @lg/reader:inline">{shortLabel}</span>
      </Button>
    </ToolbarTooltip>
  );
}

function MoveMenu({ mail }: { mail: MailController }) {
  const { folder, folders, conversation } = mail;

  // Where the conversation can move: Inbox (id null) and custom folders.
  const targets: { id: string | null; name: string }[] = [
    ...(folder === "inbox" ? [] : [{ id: null, name: "Inbox" }]),
    ...orderedFolders(folders ?? []).flatMap((item) =>
      item.kind === "custom" && item.id !== folder
        ? [{ id: item.id, name: item.name }]
        : []
    ),
  ];

  const disabled =
    !conversation?.hasIncoming || mail.sharedActionPending || !targets.length;

  return (
    <DropdownMenu>
      <ToolbarTooltip label="Move to folder" side="bottom">
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Move to folder"
              disabled={disabled}
              className="text-foreground/80 h-8 gap-1.5 px-2 text-[13px] font-medium"
            />
          }
        >
          <FolderInput />
          <span className="hidden @lg/reader:inline">Move</span>
          <ChevronDown className="size-3 opacity-60" />
        </DropdownMenuTrigger>
      </ToolbarTooltip>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          {targets.map((target) => (
            <DropdownMenuItem
              key={target.id ?? "inbox"}
              onClick={() => mail.moveToFolder(target)}
            >
              {target.id ? <FolderInput /> : <Inbox />}
              {target.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function latestIncoming(mail: MailController) {
  return [...mail.conversationMessages]
    .reverse()
    .find((message) => message.direction === "incoming");
}

/** Less frequent actions, mirroring what the list's selection toolbar offers. */
function MoreMenu({
  mail,
  actions,
}: {
  mail: MailController;
  actions: SenderActions;
}) {
  const message = latestIncoming(mail);
  const reportable = mail.canReport;

  if (!message || (!reportable && message.sender?.block?.workspace)) {
    return null;
  }

  const block = message.sender?.block;

  return (
    <DropdownMenu>
      <ToolbarTooltip label="More actions" side="bottom">
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="More conversation actions"
              disabled={mail.sharedActionPending}
              className="text-foreground/80"
            />
          }
        >
          <Ellipsis />
        </DropdownMenuTrigger>
      </ToolbarTooltip>
      <DropdownMenuContent align="start" className="w-60">
        {reportable && (
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => actions.reportSpam(message)}>
              <OctagonAlert /> Report spam
            </DropdownMenuItem>
          </DropdownMenuGroup>
        )}
        {reportable && !block?.workspace && <DropdownMenuSeparator />}
        {block && !block.workspace ? (
          <DropdownMenuItem onClick={() => actions.unblockSender(message)}>
            <ShieldCheck />{" "}
            <span className="truncate">Unblock “{block.pattern}”</span>
          </DropdownMenuItem>
        ) : block ? null : (
          <DropdownMenuItem onClick={() => actions.open("block", message)}>
            <ShieldBan />{" "}
            <span className="truncate">
              Block “{message.fromName || message.fromAddress}”
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteForeverButton({
  mail,
  onDelete,
}: {
  mail: MailController;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <CommandButton
        label="Delete conversation permanently"
        shortLabel="Delete forever"
        icon={<Trash2 />}
        destructive
        disabled={mail.sharedActionPending}
        onClick={() => setOpen(true)}
      />
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This conversation and all its attachments will be deleted for
              everyone. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CommandBar({
  mail,
  actions,
}: {
  mail: MailController;
  actions: SenderActions;
}) {
  const {
    conversation,
    conversations,
    conversationId,
    sharedActionPending: pending,
  } = mail;

  const state = conversation?.mailboxState ?? "active";

  const index = conversations.findIndex(
    (item) => item.conversationId === conversationId
  );

  const previous = index > 0 ? conversations[index - 1] : undefined;
  const next = index === -1 ? undefined : conversations[index + 1];

  return (
    <TooltipProvider delay={300}>
      <div
        role="toolbar"
        aria-label="Conversation actions"
        className="border-border bg-surface flex h-12 shrink-0 items-center gap-0.5 border-b px-1.5 sm:px-2.5"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="mr-1 lg:hidden"
          aria-label="Back to list"
          onClick={mail.closeConversation}
        >
          <ArrowLeft />
        </Button>
        {state === "active" ? (
          <CommandButton
            label="Archive conversation"
            shortLabel="Archive"
            icon={<Archive />}
            disabled={pending}
            onClick={mail.archive}
          />
        ) : (
          <CommandButton
            label={
              state === "spam" ? "Mark as not spam" : "Restore conversation"
            }
            shortLabel={state === "spam" ? "Not spam" : "Restore"}
            icon={<Inbox />}
            disabled={pending || actions.pending}
            onClick={() => {
              const message =
                state === "spam" ? latestIncoming(mail) : undefined;

              // "Not spam" also trusts the sender and teaches the classifier.
              if (message) actions.markNotSpam(message);
              else mail.restore();
            }}
          />
        )}
        {state === "trash" ? (
          mail.deletePermanently ? (
            <DeleteForeverButton
              mail={mail}
              onDelete={mail.deletePermanently}
            />
          ) : null
        ) : (
          <CommandButton
            label="Move conversation to trash"
            shortLabel="Delete"
            icon={<Trash2 />}
            destructive
            disabled={pending}
            onClick={mail.trash}
          />
        )}
        <span aria-hidden="true" className="bg-border mx-1 h-4.5 w-px" />
        {mail.markRead ? (
          <CommandButton
            label="Mark conversation as read"
            shortLabel="Mark read"
            icon={<MailOpen />}
            disabled={pending}
            onClick={mail.markRead}
          />
        ) : mail.markUnread ? (
          <CommandButton
            label="Mark conversation as unread"
            shortLabel="Mark unread"
            icon={<Mail />}
            disabled={pending}
            onClick={mail.markUnread}
          />
        ) : null}
        <MoveMenu mail={mail} />
        <MoreMenu mail={mail} actions={actions} />

        <div className="ml-auto flex items-center gap-0.5 pl-2">
          {index !== -1 && (
            <span className="text-muted-foreground mr-1.5 hidden text-xs whitespace-nowrap tabular-nums @2xl/reader:inline">
              {index + 1} of {mail.displayedConversationCount}
            </span>
          )}
          <ToolbarTooltip label="Previous conversation" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Previous conversation"
              disabled={!previous}
              onClick={() =>
                previous && mail.openConversation(previous.conversationId)
              }
            >
              <ChevronUp />
            </Button>
          </ToolbarTooltip>
          <ToolbarTooltip label="Next conversation" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Next conversation"
              disabled={!next}
              onClick={() => next && mail.openConversation(next.conversationId)}
            >
              <ChevronDown />
            </Button>
          </ToolbarTooltip>
          <span
            aria-hidden="true"
            className="bg-border mx-1 hidden h-4.5 w-px lg:block"
          />
          <ToolbarTooltip label="Close reading pane" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden size-7 lg:inline-flex"
              aria-label="Close reading pane"
              onClick={mail.closeConversation}
            >
              <X />
            </Button>
          </ToolbarTooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}

function ReaderPlaceholder({ mail }: { mail: MailController }) {
  const unread = folderShowsUnreadCount(mail.activeFolder)
    ? (mail.activeFolder?.unreadCount ?? 0)
    : 0;

  return (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div className="max-w-xs">
        <svg
          aria-hidden="true"
          viewBox="0 0 120 84"
          className="text-border mx-auto h-20"
          fill="none"
        >
          <rect
            x="8"
            y="10"
            width="104"
            height="66"
            rx="8"
            fill="var(--surface-sunken)"
            stroke="currentColor"
          />
          <path d="M8 26h104" stroke="currentColor" />
          <rect
            x="18"
            y="35"
            width="30"
            height="5"
            rx="2.5"
            fill="var(--primary)"
            opacity="0.55"
          />
          <rect
            x="18"
            y="46"
            width="78"
            height="4"
            rx="2"
            fill="currentColor"
          />
          <rect
            x="18"
            y="55"
            width="62"
            height="4"
            rx="2"
            fill="currentColor"
          />
          <rect
            x="18"
            y="64"
            width="40"
            height="4"
            rx="2"
            fill="currentColor"
          />
          <circle cx="18" cy="18" r="2.5" fill="currentColor" />
          <circle cx="26" cy="18" r="2.5" fill="currentColor" />
          <circle cx="34" cy="18" r="2.5" fill="currentColor" />
        </svg>
        <p className="mt-4 text-[14px] font-semibold">
          Select a conversation to read
        </p>
        <p className="text-muted-foreground mt-1 text-[13px] leading-5">
          {unread > 0
            ? `${unread} unread in ${mail.folderName}. Pick one from the list to open it here.`
            : "Messages open here, beside the list, so you can triage without losing your place."}
        </p>
      </div>
    </div>
  );
}

export function ReaderPane({ mail }: { mail: MailController }) {
  const {
    conversationId,
    conversationQuery,
    conversation,
    conversationMessages,
    mailbox,
  } = mail;

  const senderActions = useSenderActions({
    mailbox,
    onLeaveConversation: mail.closeConversation,
  });

  useSenderIntelFill(mailbox?.id, conversationId, conversationMessages);

  if (!conversationId) return <ReaderPlaceholder mail={mail} />;
  const pages = conversationQuery.data?.pages;

  return (
    <div className="@container/reader flex min-h-0 flex-1 flex-col">
      <CommandBar mail={mail} actions={senderActions} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ConversationView
          messages={conversationMessages}
          messageCount={
            conversation?.messageCount ?? conversationMessages.length
          }
          hasOlderMessages={Boolean(pages?.at(-1)?.nextCursor)}
          loadingOlder={conversationQuery.isFetchingNextPage}
          olderMessagesError={conversationQuery.isFetchNextPageError}
          // The mailbox list confirms the URL's mailbox; until then a failed
          // request may just be a stale link about to be redirected.
          loading={!mailbox || (!pages?.length && conversationQuery.isPending)}
          error={
            pages?.length || !mailbox
              ? undefined
              : conversationQuery.error?.message
          }
          summary={mail.conversations.find(
            (item) => item.conversationId === conversationId
          )}
          mailbox={mailbox}
          folderName={mail.folderName}
          onRetry={() => void conversationQuery.refetch()}
          onLoadOlder={() => void conversationQuery.fetchNextPage()}
          onForward={mail.openForward}
          onOpenConversation={(id) => mail.openConversation(id, "sent")}
          senderActions={senderActions}
          reportable={mail.canReport}
        />
      </div>
      {senderActions.dialogs}
    </div>
  );
}
