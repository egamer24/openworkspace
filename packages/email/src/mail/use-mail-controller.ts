import { useDebouncedValue } from "@open-workspace/core/ui";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
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
import { findDraftSource, newDraftId, useDrafts } from "./use-drafts";
import type { SavedDraft } from "./use-drafts";
import {
  useBulkConversationAction,
  useConversation,
  useConversations,
  useFolders,
  useMailboxes,
  usePrefetchConversation,
} from "./use-mail-data";

export type MailController = ReturnType<typeof useMailController>;

/** The open composer: a new message, a forward, or a reopened draft. */
type Composer = {
  mailboxId: string;
  /** The id its draft is saved under. */
  draftId: string;
  draft?: SavedDraft;
  forwarded?: MessageDetail;
};

/**
 * The open composer lives in the URL, as Gmail's does: `?compose=new` until
 * its draft is first saved, then `?compose=<draft id>`, so reloading reopens
 * it. Moving around the mail screen keeps it.
 */
const COMPOSE_PARAM = "compose";

function withComposeParam(path: string) {
  const compose = new URLSearchParams(window.location.search).get(
    COMPOSE_PARAM
  );

  return compose
    ? `${path}?${new URLSearchParams({ [COMPOSE_PARAM]: compose })}`
    : path;
}

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
  const [searchParams] = useSearchParams();
  const composeParam = searchParams.get(COMPOSE_PARAM);

  // A reload with ?compose=new opens an empty composer again.
  const [composer, setComposer] = useState<Composer | null>(() =>
    composeParam === "new" && mailboxId
      ? { mailboxId, draftId: newDraftId() }
      : null
  );

  // Only a change of the parameter acts here (Back, Forward, a link), not
  // the render in between opening a composer and its parameter arriving.
  const [seenComposeParam, setSeenComposeParam] = useState(composeParam);

  if (composeParam !== seenComposeParam) {
    setSeenComposeParam(composeParam);

    if (!composeParam) setComposer(null);
    else if (composeParam === "new" && !composer && mailboxId) {
      setComposer({ mailboxId, draftId: newDraftId() });
    }
  }

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
  const currentPath = routePath(route);

  const composeOpen = Boolean(
    composer &&
    composer.mailboxId === activeMailboxId &&
    mailbox?.canSend &&
    (composeParam === "new" || composeParam === composer.draftId)
  );

  // Moving to another mailbox (e.g. back in history) closes its composer,
  // whose draft is saved: adjusted while rendering, so it never shows.
  if (composer && activeMailboxId && composer.mailboxId !== activeMailboxId) {
    setComposer(null);
  }

  useEffect(() => {
    if (locationReady && canonicalPath && currentPath !== canonicalPath) {
      navigateRoute(withComposeParam(canonicalPath), { replace: true });
    }
  }, [canonicalPath, currentPath, locationReady, navigateRoute]);

  /** Sets or (with null) removes ?compose= on the current page. */
  function setComposeParam(value: string | null, replace = false) {
    navigateRoute(
      {
        search: value
          ? `?${new URLSearchParams({ [COMPOSE_PARAM]: value })}`
          : "",
      },
      { replace }
    );
  }

  // ?compose=<draft id> of a draft not open here (a reload, a Drafts row,
  // Back) loads it: a new message or forward opens in the composer, a reply
  // in its conversation. Other drafts wait in Drafts.
  const pendingDraftId =
    composeParam &&
    composeParam !== "new" &&
    composer?.draftId !== composeParam &&
    mailbox?.canSend
      ? composeParam
      : null;

  const pendingDrafts = useDrafts(pendingDraftId ? mailbox?.id : undefined);
  const pendingDraftList = pendingDrafts.data;

  useEffect(() => {
    if (!pendingDraftId || !activeMailboxId || !pendingDraftList) return;
    const draft = pendingDraftList.find((item) => item.id === pendingDraftId);
    let cancelled = false;

    const drop = (message: string) => {
      toast.error(message);
      navigateRoute({ search: "" }, { replace: true });
    };

    if (!draft) drop("That draft was sent or discarded");
    else if (draft.kind === "reply") {
      // Its reply box reopens in the conversation.
      navigateRoute(
        mailPath(activeMailboxId, folder, draft.conversationId ?? undefined),
        { replace: true }
      );
    } else {
      void (async () => {
        let forwarded: MessageDetail | undefined;

        if (draft.kind === "forward") {
          try {
            forwarded = await findDraftSource(activeMailboxId, draft);
          } catch {
            forwarded = undefined;
          }

          if (!forwarded) {
            if (!cancelled) {
              drop("The forwarded message is no longer available");
            }

            return;
          }
        }

        if (!cancelled) {
          setComposer({
            mailboxId: activeMailboxId,
            draftId: draft.id,
            draft,
            forwarded,
          });
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [
    activeMailboxId,
    folder,
    navigateRoute,
    pendingDraftId,
    pendingDraftList,
  ]);
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

  // A new message or forward in Drafts is a row of its own, named by its
  // draft: there is no conversation yet, so it opens in the composer.
  const isComposeDraftRow = (id: string) =>
    conversations.some(
      (item) => item.draftId === id && item.conversationId === id
    );

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
          (item) =>
            item && item.draftId !== item.conversationId
              ? [item.conversationId]
              : []
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
      withComposeParam(
        mailPath(targetMailboxId, next.folder ?? folder, targetConversation)
      ),
      { replace }
    );
  }

  function openCompose(forwarded?: MessageDetail) {
    if (!mailbox?.canSend) return;
    setComposer({ mailboxId: mailbox.id, draftId: newDraftId(), forwarded });
    setComposeParam("new");
  }

  function closeComposer() {
    setComposer(null);

    if (new URLSearchParams(window.location.search).has(COMPOSE_PARAM)) {
      setComposeParam(null);
    }
  }

  // Reads the live URL: a mutation can settle after the user already moved to
  // another folder, and the captured `folder` would drag them back.
  function closeConversation() {
    const current = parseMailPath(window.location.pathname);

    if (!current?.conversationId) return;
    navigateRoute(
      withComposeParam(mailPath(current.mailboxId, current.folder))
    );
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
    composer,
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
      if (!isComposeDraftRow(id)) prefetchConversation(location.mailboxId, id);
    },
    openConversation(id: string, folderOverride?: Folder) {
      if (isComposeDraftRow(id)) {
        setComposeParam(id);

        return;
      }

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
    openCompose: () => openCompose(),
    openForward: (message: MessageDetail) => openCompose(message),
    /** The open composer's draft was first saved: the URL now names it. */
    composerSaved(draftId: string) {
      if (composer?.draftId === draftId && composeParam === "new") {
        setComposeParam(draftId, true);
      }
    },
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
