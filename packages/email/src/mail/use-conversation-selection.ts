import { useMemo, useState } from "react";
import { toast } from "sonner";

import type { ConversationSummary } from "./types";
import { useDiscardDrafts } from "./use-drafts";
import { useBulkConversationAction } from "./use-mail-data";
import type { BulkConversationAction } from "./use-mail-data";
import { useBulkReport } from "./use-mail-safety";

const EMPTY_SELECTION = new Set<string>();

type SelectionState = {
  scope: string;
  active: boolean;
  ids: Set<string>;
};

export function useConversationSelection({
  scope,
  mailboxId,
  folderId,
  conversations,
}: {
  scope: string;
  mailboxId?: string;
  folderId: string;
  conversations: ConversationSummary[];
}) {
  const [state, setState] = useState<SelectionState>({
    scope,
    active: false,
    ids: new Set(),
  });

  if (state.scope !== scope) {
    // Scope owns selection. Reset it before rendering the new list so browser
    // Back/Forward cannot revive IDs from an earlier visit to the same scope.
    setState({ scope, active: false, ids: new Set() });
  }

  const mutation = useBulkConversationAction();
  const reportMutation = useBulkReport();
  const discardMutation = useDiscardDrafts();
  const active = state.scope === scope && state.active;
  const selectedIds = active ? state.ids : EMPTY_SELECTION;

  const selectedConversations = useMemo(
    () =>
      conversations.filter((conversation) =>
        selectedIds.has(conversation.conversationId)
      ),
    [conversations, selectedIds]
  );

  function start() {
    if (mutation.isPending) return;
    setState({ scope, active: true, ids: new Set() });
  }

  function exit() {
    setState({ scope, active: false, ids: new Set() });
  }

  function toggle(conversationId: string) {
    if (mutation.isPending) return;
    setState((current) => {
      const ids = new Set(current.scope === scope ? current.ids : []);

      if (ids.has(conversationId)) ids.delete(conversationId);
      else ids.add(conversationId);

      return { scope, active: true, ids };
    });
  }

  function toggleAllLoaded() {
    if (mutation.isPending) return;
    setState((current) => {
      const ids = current.scope === scope ? current.ids : EMPTY_SELECTION;

      const allLoadedSelected =
        conversations.length > 0 &&
        conversations.every((conversation) =>
          ids.has(conversation.conversationId)
        );

      return {
        scope,
        active: true,
        ids: allLoadedSelected
          ? new Set()
          : new Set(
              conversations.map((conversation) => conversation.conversationId)
            ),
      };
    });
  }

  function run(action: BulkConversationAction, verb: string) {
    if (!mailboxId || !selectedConversations.length) return;

    const applicableConversations =
      action.type === "read"
        ? selectedConversations.filter(
            (conversation) => conversation.hasIncoming
          )
        : selectedConversations;

    const conversationIds = applicableConversations.map(
      (conversation) => conversation.conversationId
    );

    if (!conversationIds.length) return;
    const requestedCount = conversationIds.length;
    mutation.mutate(
      {
        mailboxId,
        sourceFolderId: folderId,
        conversationIds,
        action,
      },
      {
        onSuccess: ({ updatedCount }) => {
          const conversationLabel =
            requestedCount === 1 ? "conversation" : "conversations";

          if (updatedCount === requestedCount) {
            toast.success(`${updatedCount} ${conversationLabel} ${verb}`);
          } else {
            toast.warning(
              `${updatedCount} of ${requestedCount} ${conversationLabel} ${verb}. The rest no longer matched this action.`
            );
          }

          exit();
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  /** Reports the newest incoming message of each selected conversation. */
  function report() {
    if (!mailboxId) return;

    const conversationIds = selectedConversations
      .filter((conversation) => conversation.hasIncoming)
      .map((conversation) => conversation.conversationId);

    if (!conversationIds.length) return;
    reportMutation.mutate(
      { mailboxId, conversationIds },
      {
        onSuccess: ({ reportedCount }) => {
          const label = reportedCount === 1 ? "conversation" : "conversations";
          toast.success(`${reportedCount} ${label} reported as spam`);
          exit();
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  /** Deletes the selected Drafts rows' drafts. */
  function discardDrafts() {
    const draftIds = selectedConversations.flatMap((conversation) =>
      conversation.draftId ? [conversation.draftId] : []
    );

    if (!mailboxId || !draftIds.length) return;
    discardMutation.mutate(
      { mailboxId, draftIds },
      {
        onSuccess: () => {
          toast.success(
            `${draftIds.length} ${draftIds.length === 1 ? "draft" : "drafts"} discarded`
          );
          exit();
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  return {
    active,
    selectedIds,
    selectedConversations,
    allLoadedSelected:
      conversations.length > 0 &&
      selectedConversations.length === conversations.length,
    anySelectedUnread: selectedConversations.some(
      (conversation) => conversation.isUnread
    ),
    hasSelectedIncoming: selectedConversations.some(
      (conversation) => conversation.hasIncoming
    ),
    allSelectedHaveIncoming:
      selectedConversations.length > 0 &&
      selectedConversations.every((conversation) => conversation.hasIncoming),
    pending:
      mutation.isPending ||
      reportMutation.isPending ||
      discardMutation.isPending,
    report,
    discardDrafts,
    start,
    exit,
    toggle,
    toggleAllLoaded,
    run,
  };
}
