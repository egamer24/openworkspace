import { responseJson, useAuth } from "@open-workspace/core/ui";
import {
  queryOptions,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useEffect } from "react";

import { mailApi } from "../lib/mail-api";
import {
  conversationQuery,
  conversationsQuery,
  foldersQuery,
  mailboxesQuery,
} from "./mail-queries";
import { applyOwnReadChange, scheduleMailboxRefresh } from "./mail-query-cache";
import type { Folder, MessageDetail } from "./types";

export function useMailboxes() {
  return useQuery(mailboxesQuery());
}

export function useFolders(mailboxId: string | undefined) {
  return useQuery(foldersQuery(mailboxId));
}

export function useRecipientSuggestions(
  mailboxId: string | undefined,
  query: string,
  active: boolean
) {
  return useQuery({
    queryKey: ["recipient-suggestions", mailboxId, query],
    queryFn: mailboxId
      ? async ({ signal }) =>
          responseJson(
            await mailApi.api.mail.mailboxes[":id"][
              "recipient-suggestions"
            ].$get(
              { param: { id: mailboxId }, query: { q: query, limit: "8" } },
              { init: { signal } }
            )
          )
      : skipToken,
    enabled: active,
    staleTime: 30_000,
  });
}

export function useConversations(
  mailboxId: string | undefined,
  folder: Folder,
  search: string,
  unreadOnly: boolean,
  active = true
) {
  return useInfiniteQuery({
    ...conversationsQuery(mailboxId, folder, search, unreadOnly),
    enabled: Boolean(mailboxId) && active,
  });
}

export function useConversation(
  mailboxId: string | undefined,
  conversationId: string | undefined
) {
  return useInfiniteQuery(conversationQuery(mailboxId, conversationId));
}

/**
 * Starts loading a conversation the person is about to open (pointer
 * resting on its row, keyboard focus, or the next and previous one), so the
 * reader can show it at once.
 */
export function usePrefetchConversation() {
  const client = useQueryClient();

  return (
    mailboxId: string | undefined,
    conversationId: string | undefined
  ) => {
    if (!mailboxId || !conversationId) return;
    void client.prefetchInfiniteQuery(
      conversationQuery(mailboxId, conversationId)
    );
  };
}

type ConversationPage = { messages: MessageDetail[] };

function senderIntelQuery(mailboxId: string, messageId: string) {
  return queryOptions({
    queryKey: ["sender-intel", mailboxId, messageId],
    queryFn: async ({ signal }) =>
      responseJson(
        await mailApi.api.mail.messages[":id"]["sender-intel"].$get(
          {
            param: { id: messageId },
            query: { mailboxId },
          },
          { init: { signal } }
        )
      ),
    staleTime: 5 * 60_000,
  });
}

/**
 * The reader gets a conversation before the sender lookups (DNS, blocklists)
 * of messages that had none finish; this fetches each one's result and puts
 * it into the cached conversation, which shows a pending state meanwhile.
 */
export function useSenderIntelFill(
  mailboxId: string | undefined,
  conversationId: string | undefined,
  messages: MessageDetail[]
) {
  const client = useQueryClient();

  const pending =
    mailboxId && conversationId
      ? messages.filter((message) => message.senderIntelPending)
      : [];

  const results = useQueries({
    queries: mailboxId
      ? pending.map((message) => senderIntelQuery(mailboxId, message.id))
      : [],
  });

  const readyKey = pending
    .flatMap((message, index) => (results[index]?.data ? [message.id] : []))
    .join(",");

  useEffect(() => {
    if (!mailboxId || !readyKey) return;

    const ready = readyKey.split(",").flatMap((id) => {
      const data = client.getQueryData(
        senderIntelQuery(mailboxId, id).queryKey
      );

      return data ? [{ id, data }] : [];
    });

    client.setQueryData<InfiniteData<ConversationPage>>(
      ["conversation", mailboxId, conversationId],
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            messages: page.messages.map((message) => {
              const filled = ready.find((item) => item.id === message.id);

              if (!filled || !message.senderIntelPending) return message;
              const { ok: _ok, ...intel } = filled.data;

              return { ...message, ...intel };
            }),
          })),
        }
    );
  }, [client, conversationId, mailboxId, readyKey]);
}

export function useResendMessage() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, mailboxId }: { id: string; mailboxId: string }) =>
      responseJson(
        await mailApi.api.mail.messages[":id"]["send-again"].$post({
          param: { id },
          query: { mailboxId },
        })
      ),
    onSuccess: (_result, { mailboxId }) =>
      scheduleMailboxRefresh(client, mailboxId),
  });
}

export function useSetMessageRead() {
  const client = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      id,
      mailboxId,
      isRead,
    }: {
      id: string;
      mailboxId: string;
      conversationId: string;
      isRead: boolean;
    }) =>
      responseJson(
        await mailApi.api.mail.messages[":id"].read.$patch({
          param: { id },
          query: { mailboxId },
          json: { isRead },
        })
      ),
    // The change is applied to the cached conversation, lists and counts;
    // a refetch is needed only when the cache was not exactly one change behind.
    onSuccess: ({ version }, { id, mailboxId, conversationId, isRead }) => {
      const applied =
        user &&
        applyOwnReadChange(client, {
          mailboxId,
          conversationId,
          messageId: id,
          isRead,
          version,
          reader: { userId: user.id, name: user.name },
        });

      if (!applied) scheduleMailboxRefresh(client, mailboxId);
    },
  });
}

export type BulkConversationAction =
  | { type: "read"; isRead: boolean }
  | {
      type: "update";
      update: {
        mailboxState?: "active" | "archive" | "spam" | "trash";
        folderId?: string | null;
      };
    }
  | { type: "delete_permanently" };

export function useBulkConversationAction() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({
      mailboxId,
      sourceFolderId,
      conversationIds,
      action,
    }: {
      mailboxId: string;
      sourceFolderId: string;
      conversationIds: string[];
      action: BulkConversationAction;
    }) => {
      if (action.type === "update") {
        return responseJson(
          await mailApi.api.mail.conversations.bulk.$patch({
            query: { mailboxId },
            json: {
              type: action.type,
              conversationIds,
              sourceFolderId,
              update: action.update,
            },
          })
        );
      }

      return responseJson(
        await mailApi.api.mail.conversations.bulk.$patch({
          query: { mailboxId },
          json: { conversationIds, ...action },
        })
      );
    },
    onSuccess: (_result, { mailboxId }) =>
      scheduleMailboxRefresh(client, mailboxId),
  });
}
