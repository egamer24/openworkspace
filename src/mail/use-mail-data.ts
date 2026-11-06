import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, responseJson } from "@/lib/api";
import { MAX_BULK_CONVERSATION_COUNT } from "../../shared/mail";
import { scheduleMailboxRefresh } from "./mail-query-cache";
import type { Folder } from "./types";

const CONVERSATION_PAGE_SIZE = 25;
const MESSAGE_PAGE_SIZE = 25;

export function useMailboxes() {
  return useQuery({
    queryKey: ["mailboxes"],
    queryFn: async ({ signal }) =>
      responseJson(await api.api.mail.mailboxes.$get(undefined, {
        init: { signal },
      })),
  });
}

export function useFolders(mailboxId: string | undefined) {
  return useQuery({
    queryKey: ["folders", mailboxId],
    queryFn: async ({ signal }) =>
      responseJson(
        await api.api.mail.mailboxes[":id"].folders.$get({
          param: { id: mailboxId! },
        }, { init: { signal } }),
      ),
    enabled: Boolean(mailboxId),
  });
}

export function useRecipientSuggestions(
  mailboxId: string | undefined,
  query: string,
  active: boolean,
) {
  return useQuery({
    queryKey: ["recipient-suggestions", mailboxId, query],
    queryFn: async ({ signal }) =>
      responseJson(
        await api.api.mail.mailboxes[":id"]["recipient-suggestions"].$get({
          param: { id: mailboxId! },
          query: { q: query, limit: "8" },
        }, { init: { signal } }),
      ),
    enabled: Boolean(mailboxId) && active,
    staleTime: 30_000,
  });
}

export function useConversations(
  mailboxId: string | undefined,
  folder: Folder,
  search: string,
  unreadOnly: boolean,
  active = true,
) {
  return useInfiniteQuery({
    queryKey: ["conversations", mailboxId, folder, search, unreadOnly],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      responseJson(
        await api.api.mail.conversations.$get({
          query: {
            mailboxId: mailboxId!,
            folder,
            limit: String(CONVERSATION_PAGE_SIZE),
            cursor: pageParam,
            search: search || undefined,
            unreadOnly: unreadOnly ? "true" : undefined,
          },
        }, { init: { signal } }),
      ),
    getNextPageParam: (page, pages) => {
      const loadedCount = pages.reduce(
        (count, loadedPage) => count + loadedPage.conversations.length,
        0,
      );
      return loadedCount < MAX_BULK_CONVERSATION_COUNT
        ? page.nextCursor ?? undefined
        : undefined;
    },
    enabled: Boolean(mailboxId) && active,
  });
}

export function useConversation(
  mailboxId: string | undefined,
  conversationId: string | undefined,
) {
  return useInfiniteQuery({
    queryKey: ["conversation", mailboxId, conversationId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      responseJson(
        await api.api.mail.conversations[":id"].$get({
          param: { id: conversationId! },
          query: {
            mailboxId: mailboxId!,
            limit: String(MESSAGE_PAGE_SIZE),
            cursor: pageParam,
          },
        }, { init: { signal } }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(mailboxId && conversationId),
  });
}

export function useResendMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, mailboxId }: { id: string; mailboxId: string }) =>
      responseJson(
        await api.api.mail.messages[":id"]["send-again"].$post({
          param: { id },
          query: { mailboxId },
        }),
      ),
    onSuccess: (_result, { mailboxId }) => scheduleMailboxRefresh(client, mailboxId),
  });
}

export function useSetSpamSender() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      mailboxId,
      entry,
      list,
    }: {
      mailboxId: string;
      entry: string;
      list: "allow" | "block";
    }) => responseJson(
      await api.api.mail.mailboxes[":id"].spam.senders[":entry"].$put({
        // The RPC client does not encode path parameters.
        param: { id: mailboxId, entry: encodeURIComponent(entry) },
        json: { list },
      }),
    ),
    onSuccess: (result, { mailboxId }) => {
      client.setQueryData(["mailbox-spam", mailboxId], result);
    },
  });
}

export function useSetMessageRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      mailboxId,
      isRead,
    }: {
      id: string;
      mailboxId: string;
      isRead: boolean;
    }) =>
      responseJson(
        await api.api.mail.messages[":id"].read.$patch({
          param: { id },
          query: { mailboxId },
          json: { isRead },
        }),
      ),
    onSuccess: (_result, { mailboxId }) => scheduleMailboxRefresh(client, mailboxId),
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
        return responseJson(await api.api.mail.conversations.bulk.$patch({
          query: { mailboxId },
          json: {
            type: action.type,
            conversationIds,
            sourceFolderId,
            update: action.update,
          },
        }));
      }
      return responseJson(await api.api.mail.conversations.bulk.$patch({
        query: { mailboxId },
        json: { conversationIds, ...action },
      }));
    },
    onSuccess: (_result, { mailboxId }) => scheduleMailboxRefresh(client, mailboxId),
  });
}
