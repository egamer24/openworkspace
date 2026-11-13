import { useDebouncedValue } from "@open-workspace/core/ui";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { mailPath, parseMailPath } from "../../shared/mail-path";
import { folderDisplayName } from "./mail-folders";
import {
  mailboxForRoute,
  resolveMailLocation,
  routePath,
} from "./mail-location";
import type { MailRoute } from "./mail-location";
import type { Folder, MessageDetail } from "./types";
import { useConversationSelection } from "./use-conversation-selection";
import {
  useBulkConversationAction,
  useConversation,
  useConversations,
  useFolders,
  useMailboxes,
  usePrefetchConversation,
} from "./use-mail-data";

export type MailController = ReturnType<typeof useMailController>;

/**
 * Mail state and actions shared by every mail frontend: the route-derived
 * location, list and conversation queries, selection, composer, and
 * conversation mutations. Frontends only decide how to present them.
 */
export function useMailController(
  route: MailRoute,
  options: { listWithConversation?: boolean } = {}
) {
  const { mailboxId } = route;
  const navigateRoute = useNavigate();

  const [composerMailboxId, setComposerMailboxId] = useState<string | null>(
    null
  );

  const [forwardedMessage, setForwardedMessage] = useState<
    MessageDetail | undefined
  >();

  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const mailboxQuery = useMailboxes();
  const mailboxes = mailboxQuery.data?.mailboxes ?? [];

  // A /mail/:id URL loads its folders, list and conversation at once; "/"
  // needs the mailbox list to know which mailbox it means.
  const dataMailboxId = mailboxQuery.data
    ? mailboxForRoute(mailboxId, mailboxes)?.id
    : mailboxId;

  const foldersQuery = useFolders(dataMailboxId);
  const folders = foldersQuery.data?.folders;

  const location = resolveMailLocation(
    route,
    mailboxQuery.data?.mailboxes,
    folders
  );

  const {
    mailbox,
    folder,
    conversationId,
    ready: locationReady,
    canonicalPath,
  } = location;

  const activeMailboxId = mailbox?.id;
  const composeOpen = composerMailboxId === activeMailboxId;
  const currentPath = routePath(route);

  // Moving to another mailbox (e.g. back in history) discards its draft
  // window: adjusted while rendering, so the old composer never shows.
  if (
    composerMailboxId &&
    activeMailboxId &&
    composerMailboxId !== activeMailboxId
  ) {
    setComposerMailboxId(null);
    setForwardedMessage(undefined);
  }

  useEffect(() => {
    if (locationReady && canonicalPath && currentPath !== canonicalPath) {
      navigateRoute(canonicalPath, { replace: true });
    }
  }, [canonicalPath, currentPath, locationReady, navigateRoute]);
  const debouncedSearch = useDebouncedValue(search.trim(), 250);

  const conversationsQuery = useConversations(
    location.mailboxId,
    folder,
    debouncedSearch,
    unreadOnly,
    // Layouts that keep the list beside an open conversation load it too.
    !conversationId || Boolean(options.listWithConversation)
  );

  const conversationQuery = useConversation(location.mailboxId, conversationId);
  const sharedConversationAction = useBulkConversationAction();

  const conversations = useMemo(
    () =>
      conversationsQuery.data?.pages.flatMap((page) => page.conversations) ??
      [],
    [conversationsQuery.data?.pages]
  );

  // Until the mailbox and folder are confirmed, a failed request may only
  // mean the URL is stale, which the canonical redirect fixes.
  const listError =
    mailboxQuery.error?.message ??
    (mailbox ? foldersQuery.error?.message : undefined) ??
    (locationReady ? conversationsQuery.error?.message : undefined);

  const conversationPages = conversationQuery.data?.pages;

  const conversationMessages = useMemo(
    () =>
      conversationPages
        ? [...conversationPages].reverse().flatMap((page) => page.messages)
        : [],
    [conversationPages]
  );

  const conversation = conversationPages?.[0];
  const prefetchConversation = usePrefetchConversation();

  // With a conversation open, the previous and next one load in the
  // background, so stepping through the list does not wait.
  const openIndex =
    conversationId && conversation
      ? conversations.findIndex(
          (item) => item.conversationId === conversationId
        )
      : -1;

  const neighbourIds =
    openIndex >= 0
      ? [conversations[openIndex + 1], conversations[openIndex - 1]].flatMap(
          (item) => (item ? [item.conversationId] : [])
        )
      : [];

  const neighbourKey = neighbourIds.join("\0");
  useEffect(() => {
    if (!neighbourKey) return;

    const timer = setTimeout(() => {
      for (const id of neighbourKey.split("\0")) {
        prefetchConversation(location.mailboxId, id);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [location.mailboxId, neighbourKey, prefetchConversation]);
  const folderName = folderDisplayName(folder, folders);
  const activeFolder = folders?.find((item) => item.id === folder);

  const selection = useConversationSelection({
    scope: `${activeMailboxId ?? ""}\0${folder}\0${debouncedSearch}\0${unreadOnly}`,
    mailboxId: activeMailboxId,
    folderId: folder,
    conversations,
  });

  const moreConversationsExist = Boolean(
    conversationsQuery.data?.pages.at(-1)?.nextCursor
  );

  const displayedConversationCount =
    debouncedSearch || unreadOnly
      ? `${conversations.length}${moreConversationsExist ? "+" : ""}`
      : String(activeFolder?.totalCount ?? conversations.length);

  /** `replace` swaps the current history entry, e.g. the one an open mailbox sheet added. */
  function navigate(
    next: {
      folder?: Folder;
      mailbox?: string;
      conversation?: string | null;
    },
    replace = false
  ) {
    const targetMailboxId = next.mailbox ?? mailbox?.id;

    if (!targetMailboxId) return;

    const targetConversation =
      next.conversation === null ? null : (next.conversation ?? conversationId);

    navigateRoute(
      mailPath(targetMailboxId, next.folder ?? folder, targetConversation),
      { replace }
    );
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
    const current = parseMailPath(window.location.pathname);

    if (!current?.conversationId) return;
    navigateRoute(mailPath(current.mailboxId, current.folder));
  }

  function mutateConversation(
    input: {
      mailboxState?: "active" | "archive" | "trash";
      folderId?: string | null;
    },
    returnToList = false,
    successMessage?: string
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
            toast.warning(
              "Conversation was not changed because its folder changed."
            );

            return;
          }

          if (successMessage) toast.success(successMessage);

          if (returnToList) closeConversation();
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  function deleteConversationPermanently() {
    if (!conversationId || !mailbox) return;
    sharedConversationAction.mutate(
      {
        mailboxId: mailbox.id,
        sourceFolderId: folder,
        conversationIds: [conversationId],
        action: { type: "delete_permanently" },
      },
      {
        onSuccess: ({ updatedCount }) => {
          if (!updatedCount) {
            toast.warning(
              "Conversation was not deleted because its folder changed."
            );

            return;
          }

          toast.success("Conversation deleted permanently");
          closeConversation();
        },
        onError: (error) => toast.error(error.message),
      }
    );
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
      toast.error(
        error instanceof Error ? error.message : "Could not update read state"
      );
    }
  }

  return {
    mailboxQuery,
    foldersQuery,
    conversationsQuery,
    conversationQuery,
    mailboxes,
    mailbox,
    folders,
    folder,
    folderName,
    activeFolder,
    conversationId,
    conversations,
    conversation,
    conversationMessages,
    displayedConversationCount,
    selection,
    search,
    debouncedSearch,
    unreadOnly,
    composeOpen,
    forwardedMessage,
    sharedActionPending: sharedConversationAction.isPending,
    listLoading: !listError && conversationsQuery.isPending,
    listError,
    retryList() {
      void (mailboxQuery.isError
        ? mailboxQuery.refetch()
        : foldersQuery.isError
          ? foldersQuery.refetch()
          : conversationsQuery.refetch());
    },
    setSearch(value: string) {
      setSearch(value);
      selection.exit();
    },
    toggleUnreadOnly() {
      selection.exit();
      setUnreadOnly((current) => !current);
    },
    selectFolder(next: Folder) {
      selection.exit();
      navigate({ folder: next, conversation: null });
    },
    selectMailbox(id: string) {
      closeComposer();
      selection.exit();
      navigate({ mailbox: id, folder: "inbox", conversation: null });
    },
    /**
     * A folder of any mailbox, e.g. from an expanded mailbox in the sidebar;
     * `replace` swaps the current history entry instead of adding one.
     */
    openFolder(nextMailboxId: string, next: Folder, replace = false) {
      if (nextMailboxId !== mailbox?.id) closeComposer();
      selection.exit();
      navigate(
        { mailbox: nextMailboxId, folder: next, conversation: null },
        replace
      );
    },
    /** Starts loading a conversation the person is likely to open next. */
    prefetchConversation(id: string) {
      prefetchConversation(location.mailboxId, id);
    },
    openConversation(id: string, folderOverride?: Folder) {
      // An absent folder keeps the current one.
      navigate({ conversation: id, folder: folderOverride });
    },
    closeConversation() {
      navigate({ conversation: null });
    },
    openAdministration() {
      navigateRoute("/admin");
    },
    openSettings() {
      navigateRoute("/settings");
    },
    openCompose,
    openForward,
    closeComposer,
    archive: () => mutateConversation({ mailboxState: "archive" }, true),
    restore: () => mutateConversation({ mailboxState: "active" }, true),
    trash: () => mutateConversation({ mailboxState: "trash" }, true),
    /** Moves the open conversation to a custom folder, or back to Inbox with null. */
    moveToFolder: (target: { id: string | null; name: string }) =>
      mutateConversation(
        { mailboxState: "active", folderId: target.id },
        true,
        `Moved to ${target.name}`
      ),
    /** Reporting spam fits active and archived mail people received. */
    canReport:
      (conversation?.mailboxState === "active" ||
        conversation?.mailboxState === "archive") &&
      activeFolder?.systemType !== "sent",
    /** Only from Trash, and only for people who can send from the mailbox. */
    deletePermanently:
      conversation?.mailboxState === "trash" && mailbox?.canSend
        ? deleteConversationPermanently
        : undefined,
    markRead:
      (conversation?.unreadCount ?? 0) > 0
        ? () => void changeConversationRead(true)
        : undefined,
    markUnread: conversation?.hasIncoming
      ? () => void changeConversationRead(false, true)
      : undefined,
  };
}
