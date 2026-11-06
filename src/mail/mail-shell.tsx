import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ListChecks, Mail, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ConversationView } from "./conversation-view";
import { ConversationSelectionToolbar } from "./conversation-selection-toolbar";
import { MailHeader } from "./mail-header";
import {
  FolderTabBar,
  folderDisplayName,
  folderShowsUnreadCount,
} from "./mail-navigation";
import { MessageList } from "./message-list";
import { FolderRetentionControls } from "./folder-retention-controls";
import type {
  ConversationSummary,
  Folder,
  MessageDetail,
} from "./types";
import { mailboxForRoute, resolveMailLocation } from "./mail-location";
import {
  useBulkConversationAction,
  useConversations,
  useMailboxes,
  useConversation,
  useFolders,
} from "./use-mail-data";
import { useConversationSelection } from "./use-conversation-selection";

const ComposeWindow = lazy(async () => {
  const module = await import("./compose-window");
  return { default: module.ComposeWindow };
});

export function MailShell({ mailboxId }: { mailboxId?: string }) {
  const navigateRoute = useNavigate();
  const [params] = useSearchParams();
  const [composerMailboxId, setComposerMailboxId] = useState<string | null>(null);
  const [forwardedMessage, setForwardedMessage] = useState<MessageDetail | undefined>();
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const mailboxQuery = useMailboxes();
  const mailboxes = mailboxQuery.data?.mailboxes ?? [];
  const requestedMailbox = mailboxForRoute(mailboxId, mailboxes);
  const foldersQuery = useFolders(requestedMailbox?.id);
  const folders = foldersQuery.data?.folders;
  const location = resolveMailLocation(
    mailboxId,
    params,
    mailboxes,
    folders,
  );
  const {
    mailbox,
    folder,
    conversationId,
    ready: locationReady,
    canonicalParams,
  } = location;
  const activeMailboxId = mailbox?.id;
  const composeOpen = composerMailboxId === activeMailboxId;
  const currentSearch = params.toString();
  const canonicalSearch = canonicalParams.toString();
  useEffect(() => {
    if (
      composerMailboxId
      && activeMailboxId
      && composerMailboxId !== activeMailboxId
    ) {
      setComposerMailboxId(null);
      setForwardedMessage(undefined);
    }
  }, [activeMailboxId, composerMailboxId]);
  useEffect(() => {
    if (
      locationReady
      && mailbox
      && (mailboxId !== mailbox.id || currentSearch !== canonicalSearch)
    ) {
      navigateRoute({
        pathname: `/mail/${encodeURIComponent(mailbox.id)}`,
        search: canonicalSearch ? `?${canonicalSearch}` : "",
      }, { replace: true });
    }
  }, [
    canonicalSearch,
    currentSearch,
    locationReady,
    mailbox,
    mailboxId,
    navigateRoute,
  ]);
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const conversationsQuery = useConversations(
    mailbox?.id,
    folder,
    debouncedSearch,
    unreadOnly,
    locationReady && !conversationId,
  );
  const conversationQuery = useConversation(
    mailbox?.id,
    locationReady ? conversationId : undefined,
  );
  const sharedConversationAction = useBulkConversationAction();
  const conversations = useMemo(
    () => conversationsQuery.data?.pages.flatMap((page) => page.conversations) ?? [],
    [conversationsQuery.data?.pages],
  );
  const conversationPages = conversationQuery.data?.pages;
  const conversationMessages = useMemo(
    () => conversationPages
      ? [...conversationPages].reverse().flatMap((page) => page.messages)
      : [],
    [conversationPages],
  );
  const conversation = conversationPages?.[0];
  const folderName = folderDisplayName(folder, folders);
  const activeFolder = folders?.find((item) => item.id === folder);
  const selection = useConversationSelection({
    scope: `${activeMailboxId ?? ""}\0${folder}\0${debouncedSearch}\0${unreadOnly}`,
    mailboxId: activeMailboxId,
    folderId: folder,
    conversations,
  });
  const moreConversationsExist = Boolean(
    conversationsQuery.data?.pages.at(-1)?.nextCursor,
  );
  const displayedConversationCount = debouncedSearch || unreadOnly
    ? `${conversations.length}${moreConversationsExist ? "+" : ""}`
    : String(activeFolder?.totalCount ?? conversations.length);

  function navigate(next: {
    folder?: Folder;
    mailbox?: string;
    conversation?: string | null;
  }) {
    const value = new URLSearchParams();
    const targetMailboxId = next.mailbox ?? mailbox?.id;
    if (!targetMailboxId) return;
    value.set("folder", next.folder ?? folder);
    if (next.conversation === null) value.delete("conversation");
    else if (next.conversation) value.set("conversation", next.conversation);
    else if (conversationId) value.set("conversation", conversationId);
    navigateRoute({
      pathname: `/mail/${encodeURIComponent(targetMailboxId)}`,
      search: `?${value.toString()}`,
    });
  }

  function openCompose() {
    if (!mailbox?.canSend) return;
    setForwardedMessage(undefined);
    setComposerMailboxId(mailbox.id);
  }

  function openForward(message: MessageDetail) {
    if (!mailbox?.canSend) return;
    setForwardedMessage(message);
    setComposerMailboxId(mailbox.id);
  }

  function closeComposer() {
    setComposerMailboxId(null);
    setForwardedMessage(undefined);
  }

  // Reads the live URL: a mutation can settle after the user already moved to
  // another folder, and the captured `folder` would drag them back.
  function closeConversation() {
    const search = new URLSearchParams(window.location.search);
    if (!search.has("conversation")) return;
    search.delete("conversation");
    navigateRoute({
      pathname: window.location.pathname,
      search: search.size ? `?${search.toString()}` : "",
    });
  }

  function mutateConversation(
    input: {
      mailboxState?: "active" | "archive" | "spam" | "trash";
      folderId?: string | null;
    },
    returnToList = false,
  ) {
    if (!conversationId || !mailbox) return;
    sharedConversationAction.mutate(
      {
        mailboxId: mailbox.id,
        sourceFolderId: folder,
        conversationIds: [conversationId],
        action: { type: "update", update: input },
      },
      {
        onSuccess: ({ updatedCount }) => {
          if (!updatedCount) {
            toast.warning("Conversation was not changed because its folder changed.");
            return;
          }
          if (returnToList) closeConversation();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function selectFolder(next: Folder) {
    selection.exit();
    navigate({ folder: next, conversation: null });
  }

  async function changeConversationRead(isRead: boolean, returnToList = false) {
    if (!conversationId || !mailbox) return;
    try {
      const { updatedCount } = await sharedConversationAction.mutateAsync({
        mailboxId: mailbox.id,
        sourceFolderId: folder,
        conversationIds: [conversationId],
        action: { type: "read", isRead },
      });
      if (!updatedCount) {
        toast.warning("Conversation no longer contains incoming messages.");
        return;
      }
      if (returnToList) closeConversation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update read state");
    }
  }

  return (
    <main
      className="paper-grain flex h-dvh min-h-0 flex-col overflow-hidden bg-background"
      onKeyDown={(event) => {
        if (selection.active && !selection.pending && event.key === "Escape") {
          selection.exit();
        }
      }}
    >
      <MailHeader
        mailbox={mailbox}
        mailboxes={mailboxQuery.data?.mailboxes ?? []}
        search={search}
        searchPlaceholder={`Search in ${folderName}`}
        showSearch={!conversationId}
        onSearchChange={(value) => {
          setSearch(value);
          selection.exit();
        }}
        onMailboxChange={(id) => {
          closeComposer();
          selection.exit();
          navigate({ mailbox: id, folder: "inbox", conversation: null });
        }}
        onCompose={openCompose}
        onAdministration={() => navigateRoute("/admin")}
      />
      <FolderTabBar
        folder={folder}
        folders={folders}
        hideMobile={selection.active}
        mailboxId={mailbox?.id}
        onSelect={selectFolder}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversationId ? (
          <ConversationView
            messages={conversationMessages}
            messageCount={conversation?.messageCount ?? conversationMessages.length}
            hasOlderMessages={Boolean(
              conversationPages?.at(-1)?.nextCursor,
            )}
            loadingOlder={conversationQuery.isFetchingNextPage}
            olderMessagesError={conversationQuery.isFetchNextPageError}
            loading={conversationQuery.isLoading}
            error={conversationPages?.length ? undefined : conversationQuery.error?.message}
            mailbox={mailbox}
            mailboxState={conversation?.mailboxState ?? "active"}
            folderName={folderName}
            sharedActionPending={sharedConversationAction.isPending}
            onRetry={() => void conversationQuery.refetch()}
            onLoadOlder={() => void conversationQuery.fetchNextPage()}
            onBack={() => navigate({ conversation: null })}
            onArchive={() => mutateConversation({ mailboxState: "archive" }, true)}
            onRestore={() => mutateConversation({ mailboxState: "active" }, true)}
            onTrash={() => mutateConversation({ mailboxState: "trash" }, true)}
            onMarkRead={(conversation?.unreadCount ?? 0) > 0
              ? () => void changeConversationRead(true)
              : undefined}
            onMarkUnread={conversation?.hasIncoming
              ? () => void changeConversationRead(false, true)
              : undefined}
            onForward={openForward}
            onOpenConversation={(id) => navigate({ folder: "sent", conversation: id })}
          />
        ) : (
          <section className="w-full px-3 pb-24 sm:px-6 lg:px-8 lg:pb-10">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-6 pb-4 sm:pt-8 sm:pb-5">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                  {mailbox?.address}
                </p>
                <h1 className="mt-1 text-[1.625rem] leading-tight font-semibold tracking-[-0.025em] sm:text-[1.875rem]">
                  {folderName}
                </h1>
              </div>
              {selection.active && mailbox ? (
                <TooltipProvider delay={300}>
                  <ConversationSelectionToolbar
                    sharedMailboxName={mailbox.kind === "shared"
                      ? mailbox.displayName
                      : undefined}
                    canDeletePermanently={mailbox.canSend}
                    folder={folder}
                    folders={folders ?? []}
                    selectedCount={selection.selectedConversations.length}
                    allLoadedSelected={selection.allLoadedSelected}
                    someLoadedSelected={selection.selectedConversations.length > 0}
                    anySelectedUnread={selection.anySelectedUnread}
                    hasSelectedIncoming={selection.hasSelectedIncoming}
                    allSelectedHaveIncoming={selection.allSelectedHaveIncoming}
                    busy={selection.pending}
                    onToggleAll={selection.toggleAllLoaded}
                    onAction={selection.run}
                    onExit={selection.exit}
                  />
                </TooltipProvider>
              ) : (
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {mailbox?.canSend
                    && (activeFolder?.systemType === "trash" || activeFolder?.systemType === "spam") ? (
                      <FolderRetentionControls
                        mailboxId={mailbox.id}
                        folder={activeFolder.systemType}
                        folderName={folderName}
                        conversationCount={activeFolder.totalCount}
                      />
                    ) : null}
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {displayedConversationCount}{" "}
                    {displayedConversationCount === "1" ? "conversation" : "conversations"}
                    {!debouncedSearch
                      && folderShowsUnreadCount(activeFolder)
                      && activeFolder?.unreadCount
                      ? ` · ${activeFolder.unreadCount} unread`
                      : ""}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-pressed={unreadOnly}
                    className={unreadOnly
                      ? "border-primary/35 bg-primary/12 text-foreground shadow-inner hover:bg-primary/16"
                      : undefined}
                    onClick={() => {
                      selection.exit();
                      setUnreadOnly((current) => !current);
                    }}
                  >
                    <Mail /> Unread
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={selection.pending || !conversations.length}
                    onClick={selection.start}
                  >
                    <ListChecks /> Select
                  </Button>
                </div>
              )}
            </div>

            <label className="relative mb-4 block xl:hidden">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-11 rounded-full pl-10"
                placeholder={`Search in ${folderName}`}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  selection.exit();
                }}
              />
            </label>

            <MessageList
              folderName={folderName}
              messages={conversations}
              loading={mailboxQuery.isLoading || foldersQuery.isLoading || conversationsQuery.isLoading}
              loadingMore={conversationsQuery.isFetchingNextPage}
              hasMore={Boolean(conversationsQuery.hasNextPage)}
              search={debouncedSearch}
              unreadOnly={unreadOnly}
              error={mailboxQuery.error?.message
                ?? foldersQuery.error?.message
                ?? conversationsQuery.error?.message}
              onLoadMore={() => void conversationsQuery.fetchNextPage()}
              onRetry={() => void (mailboxQuery.isError
                ? mailboxQuery.refetch()
                : foldersQuery.isError
                  ? foldersQuery.refetch()
                  : conversationsQuery.refetch())}
              onSelect={(message: ConversationSummary) => navigate({ conversation: message.conversationId })}
              selection={selection.active ? {
                disabled: selection.pending,
                selectedIds: selection.selectedIds,
                onToggle: selection.toggle,
              } : undefined}
            />
          </section>
        )}
      </div>

      {composeOpen && mailbox && (
        <Suspense fallback={null}>
          <ComposeWindow
            key={`${mailbox.id}:${forwardedMessage?.id ?? "compose"}`}
            mailbox={mailbox}
            forwardedMessage={forwardedMessage}
            onClose={closeComposer}
          />
        </Suspense>
      )}
    </main>
  );
}
