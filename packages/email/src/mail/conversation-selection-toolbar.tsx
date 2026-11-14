import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@open-workspace/core/ui";
import {
  Archive,
  FolderInput,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  OctagonAlert,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { orderedFolders } from "./mail-folders";
import { ToolbarTooltip } from "./toolbar-tooltip";
import type { MailFolder } from "./types";
import type { BulkConversationAction } from "./use-mail-data";

function ActionButton({
  label,
  disabled,
  destructive = false,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <ToolbarTooltip label={label}>
      <Button
        type="button"
        variant={destructive ? "destructive" : "ghost"}
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

export function ConversationSelectionToolbar({
  onDiscardDrafts,
  sharedMailboxName,
  canDeletePermanently,
  folder,
  folders,
  selectedCount,
  allLoadedSelected,
  someLoadedSelected,
  anySelectedUnread,
  hasSelectedIncoming,
  allSelectedHaveIncoming,
  busy,
  onToggleAll,
  onAction,
  onReport,
  onExit,
}: {
  /** In Drafts, discarding is the only action. */
  onDiscardDrafts?: () => void;
  sharedMailboxName?: string;
  canDeletePermanently: boolean;
  folder: string;
  folders: MailFolder[];
  selectedCount: number;
  allLoadedSelected: boolean;
  someLoadedSelected: boolean;
  anySelectedUnread: boolean;
  hasSelectedIncoming: boolean;
  allSelectedHaveIncoming: boolean;
  busy: boolean;
  onToggleAll: () => void;
  onAction: (action: BulkConversationAction, verb: string) => void;
  onReport: () => void;
  onExit: () => void;
}) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const activeFolder = folders.find((item) => item.id === folder);
  const systemType = activeFolder?.systemType;

  const customFolders = orderedFolders(folders).filter(
    (item) => item.kind === "custom"
  );

  const isInboxDistribution =
    systemType === "inbox" || activeFolder?.kind === "custom";

  const nothingSelected = selectedCount === 0;
  const disabled = busy || nothingSelected;
  const moveDisabled = disabled || !allSelectedHaveIncoming;

  const conversationLabel =
    selectedCount === 1 ? "conversation" : "conversations";

  const sharedSuffix = sharedMailboxName
    ? ` for everyone in ${sharedMailboxName}`
    : "";

  return (
    <>
      <div className="border-border bg-surface lg:bg-surface-sunken/70 fixed inset-x-0 bottom-0 z-40 flex h-[calc(3.75rem+env(safe-area-inset-bottom))] items-center gap-1 border-t px-3 pb-[env(safe-area-inset-bottom)] lg:static lg:h-10 lg:w-auto lg:rounded-lg lg:border lg:px-1.5 lg:pb-0">
        <label className="mr-auto flex min-w-0 items-center gap-2 pr-2 lg:mr-1">
          <Checkbox
            checked={allLoadedSelected}
            indeterminate={someLoadedSelected && !allLoadedSelected}
            disabled={busy}
            aria-label={
              allLoadedSelected
                ? "Deselect loaded conversations"
                : "Select loaded conversations"
            }
            onCheckedChange={onToggleAll}
          />
          <span className="truncate text-xs font-semibold tabular-nums">
            {selectedCount} selected
          </span>
        </label>

        {onDiscardDrafts ? (
          <ActionButton
            label="Discard selected drafts"
            destructive
            disabled={disabled}
            onClick={onDiscardDrafts}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          </ActionButton>
        ) : (
          <>
            <ActionButton
              label={
                anySelectedUnread
                  ? "Mark selected as read"
                  : "Mark selected as unread"
              }
              disabled={disabled || !hasSelectedIncoming}
              onClick={() =>
                onAction(
                  { type: "read", isRead: anySelectedUnread },
                  anySelectedUnread ? "marked as read" : "marked as unread"
                )
              }
            >
              {busy ? (
                <LoaderCircle className="animate-spin" />
              ) : anySelectedUnread ? (
                <MailOpen />
              ) : (
                <Mail />
              )}
            </ActionButton>

            {isInboxDistribution ? (
              <ActionButton
                label={`Archive selected${sharedSuffix}`}
                disabled={disabled}
                onClick={() =>
                  onAction(
                    { type: "update", update: { mailboxState: "archive" } },
                    "archived"
                  )
                }
              >
                <Archive />
              </ActionButton>
            ) : null}
            {["archive", "spam", "trash"].includes(systemType ?? "") ? (
              <ActionButton
                label={
                  systemType === "spam"
                    ? `Mark selected as not spam${sharedSuffix}`
                    : `Restore selected${sharedSuffix}`
                }
                disabled={disabled}
                onClick={() =>
                  onAction(
                    { type: "update", update: { mailboxState: "active" } },
                    systemType === "spam" ? "marked as not spam" : "restored"
                  )
                }
              >
                <Inbox />
              </ActionButton>
            ) : null}

            <DropdownMenu>
              <ToolbarTooltip label={`Move selected${sharedSuffix}`}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={moveDisabled}
                    />
                  }
                >
                  <FolderInput />
                  <span className="sr-only">Move selected</span>
                </DropdownMenuTrigger>
              </ToolbarTooltip>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Move to</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={systemType === "inbox"}
                    onClick={() =>
                      onAction(
                        {
                          type: "update",
                          update: { mailboxState: "active", folderId: null },
                        },
                        "moved to Inbox"
                      )
                    }
                  >
                    <Inbox /> Inbox
                  </DropdownMenuItem>
                  {customFolders.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      disabled={item.id === folder}
                      onClick={() =>
                        onAction(
                          {
                            type: "update",
                            update: {
                              mailboxState: "active",
                              folderId: item.id,
                            },
                          },
                          `moved to ${item.name}`
                        )
                      }
                    >
                      <FolderInput /> {item.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {systemType === "trash" ? (
              canDeletePermanently ? (
                <ActionButton
                  label="Delete selected permanently"
                  destructive
                  disabled={disabled}
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 />
                </ActionButton>
              ) : null
            ) : (
              <ActionButton
                label={`Move selected to Trash${sharedSuffix}`}
                disabled={disabled}
                onClick={() =>
                  onAction(
                    { type: "update", update: { mailboxState: "trash" } },
                    "moved to Trash"
                  )
                }
              >
                <Trash2 />
              </ActionButton>
            )}

            {["sent", "spam", "trash"].includes(systemType ?? "") ? null : (
              <ActionButton
                label="Report spam"
                disabled={disabled || !hasSelectedIncoming}
                onClick={onReport}
              >
                <OctagonAlert />
              </ActionButton>
            )}
          </>
        )}

        <span className="bg-border mx-0.5 hidden h-5 w-px lg:block" />
        <ActionButton label="Exit selection" disabled={busy} onClick={onExit}>
          <X />
        </ActionButton>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete permanently?</DialogTitle>
            <DialogDescription>
              {selectedCount} selected {conversationLabel} and all attachments
              will be deleted for everyone. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setDeleteDialogOpen(false);
                onAction({ type: "delete_permanently" }, "deleted permanently");
              }}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
