import {
  Button,
  Checkbox,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
  TooltipProvider,
  cn,
} from "@open-workspace/core/ui";
import { format, isThisYear, isToday, isYesterday } from "date-fns";
import {
  CircleAlert,
  ListChecks,
  LoaderCircle,
  MailOpen,
  RotateCw,
  SearchX,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { ConversationSelectionToolbar } from "./conversation-selection-toolbar";
import { FolderCleanupBar } from "./folder-cleanup-bar";
import { SearchField } from "./mail-app-bar";
import { folderShowsUnreadCount } from "./mail-folders";
import { MailboxCaption } from "./mail-mailbox-sheet";
import { ToolbarTooltip } from "./toolbar-tooltip";
import type { ConversationSummary } from "./types";
import type { MailController } from "./use-mail-controller";

function listDate(value: string) {
  const date = new Date(value);

  if (isToday(date)) return format(date, "HH:mm");

  if (isYesterday(date)) return "Yesterday";

  if (isThisYear(date)) return format(date, "MMM d");

  return format(date, "dd.MM.yy");
}

function SegmentedFilter({
  unreadOnly,
  onToggle,
}: {
  unreadOnly: boolean;
  onToggle: () => void;
}) {
  return (
    <ToggleGroup
      aria-label="Filter conversations"
      variant="segmented"
      required
      value={[unreadOnly ? "unread" : "all"]}
      onValueChange={([value]) => {
        if ((value === "unread") !== unreadOnly) onToggle();
      }}
    >
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="unread">Unread</ToggleGroupItem>
    </ToggleGroup>
  );
}

function StatePanel({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid place-items-center px-6 py-20 text-center">
      <div className="animate-fade-in">
        <span className="border-border bg-surface-sunken text-muted-foreground mx-auto grid size-10 place-items-center rounded-lg border [&_svg]:size-5">
          {icon}
        </span>
        <p className="mt-3.5 text-[14px] font-semibold">{title}</p>
        {description && (
          <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-[13px] leading-5">
            {description}
          </p>
        )}
        {children && <div className="mt-4">{children}</div>}
      </div>
    </div>
  );
}

/** How long the pointer rests on a row before its conversation starts loading. */
const CONVERSATION_INTENT_MS = 80;

function ConversationRow({
  conversation,
  active,
  selected,
  selecting,
  disabled,
  onOpen,
  onToggle,
  onIntent,
}: {
  conversation: ConversationSummary;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  disabled: boolean;
  onOpen: () => void;
  onToggle: () => void;
  /** The person is likely to open this row: `soon` after a short rest, at once on press; null when they moved on. */
  onIntent: (when: "soon" | "now" | null) => void;
}) {
  const unread = conversation.isUnread;

  return (
    <li
      className={cn(
        "mail-row group relative border-b border-(--rule) transition-colors duration-100",
        "before:bg-primary before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:opacity-0",
        unread && "before:opacity-100",
        selected
          ? "bg-(--row-selected)"
          : active
            ? "bg-(--row-active)"
            : "hover:bg-(--row-hover)",
        active && "before:opacity-100"
      )}
    >
      <button
        type="button"
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        aria-label={
          selecting
            ? `${selected ? "Deselect" : "Select"} ${conversation.subject}`
            : `Open ${conversation.subject} from ${conversation.conversationLabel}`
        }
        onClick={selecting ? onToggle : onOpen}
        onPointerEnter={selecting ? undefined : () => onIntent("soon")}
        onPointerLeave={() => onIntent(null)}
        onPointerDown={selecting ? undefined : () => onIntent("now")}
        onFocus={selecting ? undefined : () => onIntent("soon")}
        onBlur={() => onIntent(null)}
        className="focus-visible:ring-ring absolute inset-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset"
      />

      <span className="relative z-10 grid h-full place-items-center [grid-area:check]">
        <Checkbox
          aria-label={`Select ${conversation.subject}`}
          checked={selected}
          disabled={disabled}
          onCheckedChange={onToggle}
          className={cn(
            "size-4 rounded-[4px] transition-opacity",
            selecting || selected
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          )}
        />
        {unread && !selecting && !selected && (
          <span
            role="img"
            aria-label={`${conversation.unreadCount} unread messages`}
            className="bg-primary pointer-events-none absolute size-[7px] rounded-full group-hover:opacity-0 group-has-[:focus-visible]:opacity-0"
          />
        )}
      </span>

      <span className="pointer-events-none flex min-w-0 items-center gap-1.5 [grid-area:from]">
        {conversation.senderLogoUrl && (
          <img
            src={conversation.senderLogoUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
            className="ring-border size-4 shrink-0 rounded-full object-cover ring-1"
          />
        )}
        <span
          className={cn(
            "truncate text-[13px] leading-5",
            unread
              ? "text-foreground font-semibold"
              : "text-foreground/85 font-medium"
          )}
        >
          {conversation.conversationLabel}
        </span>
        {conversation.messageCount > 1 && (
          <span className="bg-foreground/[0.06] text-muted-foreground shrink-0 rounded-[4px] px-1 py-px text-[10.5px] font-semibold tabular-nums">
            {conversation.messageCount}
          </span>
        )}
      </span>

      <span className="mail-subject pointer-events-none min-w-0 truncate text-[13px] leading-5 [grid-area:subject]">
        <span
          className={
            unread ? "text-foreground font-semibold" : "text-foreground/90"
          }
        >
          {conversation.subject || "(no subject)"}
        </span>
        <span className="mail-preview text-muted-foreground">
          <span aria-hidden="true" className="mail-dash text-border px-1.5">
            —
          </span>
          {conversation.preview || "No text preview"}
        </span>
      </span>

      <time
        dateTime={conversation.timelineAt}
        className={cn(
          "pointer-events-none text-right text-xs tabular-nums [grid-area:date]",
          unread ? "text-primary font-semibold" : "text-muted-foreground"
        )}
      >
        {listDate(conversation.timelineAt)}
      </time>
    </li>
  );
}

/** What an empty folder is for, so it reads as a place rather than a dead end. */
function emptyFolderHint(systemType: string | null | undefined) {
  switch (systemType) {
    case "sent": {
      return "Messages you send from this mailbox appear here.";
    }

    case "archive": {
      return "Archive conversations to clear them from the Inbox without deleting them.";
    }

    case "spam": {
      return "Mail that looks like spam lands here instead of the Inbox.";
    }

    case "trash": {
      return "Deleted conversations wait here until you delete them permanently.";
    }

    default: {
      return "New conversations will appear here as soon as they arrive.";
    }
  }
}

export function ConversationList({ mail }: { mail: MailController }) {
  const {
    mailbox,
    folder,
    folders,
    folderName,
    activeFolder,
    conversations,
    conversationsQuery,
    conversationId,
    selection,
    debouncedSearch,
    unreadOnly,
    displayedConversationCount,
  } = mail;

  const unreadInFolder =
    !debouncedSearch && folderShowsUnreadCount(activeFolder)
      ? (activeFolder?.unreadCount ?? 0)
      : 0;

  const hasConversations = conversations.length > 0;

  // Resting on a row (pointer or keyboard focus) starts loading it, so a
  // click usually finds the conversation already there.
  const intentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  useEffect(() => () => clearTimeout(intentTimer.current), []);

  function intent(targetId: string, when: "soon" | "now" | null) {
    clearTimeout(intentTimer.current);

    if (when === "now") mail.prefetchConversation(targetId);
    else if (when === "soon") {
      intentTimer.current = setTimeout(
        () => mail.prefetchConversation(targetId),
        CONVERSATION_INTENT_MS
      );
    }
  }

  const loadMore = conversationsQuery.hasNextPage ? (
    <Button
      variant="outline"
      size="sm"
      disabled={conversationsQuery.isFetchingNextPage}
      onClick={() => void conversationsQuery.fetchNextPage()}
    >
      {conversationsQuery.isFetchingNextPage && (
        <LoaderCircle className="animate-spin" />
      )}
      Load older conversations
    </Button>
  ) : null;

  let body: ReactNode;

  if (mail.listLoading) {
    body = (
      <ul aria-busy="true" aria-label="Loading conversations">
        {Array.from({ length: 12 }, (_, index) => (
          <li key={index} className="mail-row border-b border-(--rule)">
            <span className="[grid-area:check]" />
            <Skeleton className="h-3 w-28 [grid-area:from]" />
            <Skeleton
              className="h-3 [grid-area:subject]"
              style={{ width: `${55 + ((index * 37) % 40)}%` }}
            />
            <Skeleton className="h-3 w-9 justify-self-end [grid-area:date]" />
          </li>
        ))}
      </ul>
    );
  } else if (mail.listError) {
    body = (
      <StatePanel
        icon={<CircleAlert />}
        title="Could not load conversations"
        description={mail.listError}
      >
        <Button variant="outline" size="sm" onClick={mail.retryList}>
          <RotateCw /> Retry
        </Button>
      </StatePanel>
    );
  } else if (hasConversations) {
    body = (
      <>
        <ul aria-label={`${folderName} conversations`}>
          {conversations.map((item) => (
            <ConversationRow
              key={item.id}
              conversation={item}
              active={item.conversationId === conversationId}
              selected={selection.selectedIds.has(item.conversationId)}
              selecting={selection.active}
              disabled={selection.pending}
              onOpen={() => mail.openConversation(item.conversationId)}
              onToggle={() => selection.toggle(item.conversationId)}
              onIntent={(when) => intent(item.conversationId, when)}
            />
          ))}
        </ul>
        {loadMore && (
          <div className="flex justify-center px-4 pt-4">{loadMore}</div>
        )}
      </>
    );
  } else {
    body = (
      <StatePanel
        icon={debouncedSearch ? <SearchX /> : <MailOpen />}
        title={
          debouncedSearch
            ? `No${unreadOnly ? " unread" : ""} matches in ${folderName}`
            : unreadOnly
              ? `No unread conversations in ${folderName}`
              : `${folderName} is empty`
        }
        description={
          debouncedSearch
            ? "Try a different name, address, subject, or phrase."
            : unreadOnly
              ? "Everything here has been read."
              : emptyFolderHint(activeFolder?.systemType)
        }
      >
        {loadMore}
      </StatePanel>
    );
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape anywhere in the list leaves selection mode
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (selection.active && !selection.pending && event.key === "Escape") {
          selection.exit();
        }
      }}
    >
      <div className="border-border @container/list-head shrink-0 border-b px-3.5 sm:px-4">
        {/* Phones title the list with where you are, the mailbox over its folder; desktops name the folder in the row below. */}
        <div className="min-w-0 pt-3 lg:hidden">
          <MailboxCaption mail={mail} />
          <h1 className="truncate text-[20px] leading-6 font-semibold tracking-[-0.02em]">
            {folderName}
          </h1>
        </div>
        <div className="flex h-12 items-center justify-between gap-3">
          {selection.active && mailbox ? (
            <TooltipProvider delay={300}>
              <div className="-ml-1.5 min-w-0 flex-1 [&_[data-slot=button]]:shrink-0 lg:[&>div:first-child]:h-8 lg:[&>div:first-child]:border-0 lg:[&>div:first-child]:bg-transparent lg:[&>div:first-child]:px-0">
                <ConversationSelectionToolbar
                  sharedMailboxName={
                    mailbox.kind === "shared" ? mailbox.displayName : undefined
                  }
                  canDeletePermanently={mailbox.canSend}
                  folder={folder}
                  folders={folders ?? []}
                  selectedCount={selection.selectedConversations.length}
                  allLoadedSelected={selection.allLoadedSelected}
                  someLoadedSelected={
                    selection.selectedConversations.length > 0
                  }
                  anySelectedUnread={selection.anySelectedUnread}
                  hasSelectedIncoming={selection.hasSelectedIncoming}
                  allSelectedHaveIncoming={selection.allSelectedHaveIncoming}
                  busy={selection.pending}
                  onToggleAll={selection.toggleAllLoaded}
                  onAction={selection.run}
                  onReport={selection.report}
                  onExit={selection.exit}
                />
              </div>
            </TooltipProvider>
          ) : (
            <>
              <div className="flex min-w-0 items-baseline gap-2">
                <h1 className="shrink-0 text-[15px] leading-6 font-semibold tracking-[-0.012em] max-lg:hidden">
                  {folderName}
                </h1>
                <p className="text-muted-foreground min-w-0 truncate text-xs tabular-nums">
                  {mail.listLoading ? (
                    "Loading…"
                  ) : (
                    <>
                      {/* A narrow header keeps the unread count and drops the total. */}
                      <span
                        className={
                          unreadInFolder > 0
                            ? "hidden @[24rem]/list-head:inline"
                            : undefined
                        }
                      >
                        {displayedConversationCount}
                        {/* Phones have room for the word: the folder name sits above the row. */}
                        <span className="hidden max-lg:inline @[26rem]/list-head:inline">
                          {" "}
                          {displayedConversationCount === "1"
                            ? "conversation"
                            : "conversations"}
                        </span>
                        {unreadInFolder > 0 && " · "}
                      </span>
                      {unreadInFolder > 0 && (
                        <span className="text-primary font-medium">
                          {unreadInFolder} unread
                        </span>
                      )}
                      {debouncedSearch && <> · matching “{debouncedSearch}”</>}
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <SegmentedFilter
                  unreadOnly={unreadOnly}
                  onToggle={mail.toggleUnreadOnly}
                />
                <ToolbarTooltip label="Refresh">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7"
                    aria-label="Refresh"
                    disabled={conversationsQuery.isFetching}
                    onClick={() => void conversationsQuery.refetch()}
                  >
                    <RotateCw
                      className={cn(
                        conversationsQuery.isRefetching &&
                          !conversationsQuery.isFetchingNextPage &&
                          "animate-spin"
                      )}
                    />
                  </Button>
                </ToolbarTooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={selection.pending || !hasConversations}
                  onClick={selection.start}
                >
                  <ListChecks /> Select
                </Button>
              </div>
            </>
          )}
        </div>
        <SearchField mail={mail} className="mb-2.5 h-9 md:hidden" />
      </div>

      {mailbox &&
        (activeFolder?.systemType === "trash" ||
          activeFolder?.systemType === "spam") &&
        activeFolder.totalCount > 0 && (
          <FolderCleanupBar
            mailboxId={mailbox.id}
            folder={activeFolder.systemType}
            folderName={folderName}
            conversationCount={activeFolder.totalCount}
            retentionDays={activeFolder.retentionDays}
            canEmpty={mailbox.canSend}
          />
        )}

      <div className="@container/mail-list min-h-0 flex-1 overflow-y-auto pb-24">
        {hasConversations && !mail.listLoading && !mail.listError && (
          <div className="mail-columns border-border bg-surface-sunken text-muted-foreground sticky top-0 z-20 h-8 border-b text-[11px] font-semibold tracking-[0.04em] uppercase">
            <span className="grid place-items-center [grid-area:check]">
              <Checkbox
                aria-label={
                  selection.allLoadedSelected
                    ? "Deselect all loaded conversations"
                    : "Select all loaded conversations"
                }
                checked={selection.allLoadedSelected}
                indeterminate={
                  !selection.allLoadedSelected &&
                  selection.selectedConversations.length > 0
                }
                disabled={selection.pending}
                onCheckedChange={selection.toggleAllLoaded}
                className="size-4 rounded-[4px]"
              />
            </span>
            <span data-col="from-wide" className="[grid-area:from]">
              From
            </span>
            <span data-col="from-narrow" className="[grid-area:from]">
              From · Subject
            </span>
            <span data-col="subject" className="[grid-area:subject]">
              Subject
            </span>
            <span className="text-right [grid-area:date]">Received</span>
          </div>
        )}
        {body}
      </div>
    </div>
  );
}
