import { responseJson } from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { mailApi } from "../lib/mail-api";
import { scheduleMailboxRefresh } from "./mail-query-cache";

const blockedKey = (mailboxId: string) =>
  ["blocked-senders", mailboxId] as const;

function useMailboxRefresh() {
  const client = useQueryClient();

  return (mailboxId: string) => {
    scheduleMailboxRefresh(client, mailboxId);
    void client.invalidateQueries({ queryKey: blockedKey(mailboxId) });
    void client.invalidateQueries({
      queryKey: ["recipient-suggestions", mailboxId],
    });
  };
}

export function useUnsubscribe() {
  const refresh = useMailboxRefresh();

  return useMutation({
    mutationFn: async (input: {
      mailboxId: string;
      messageId: string;
      method: "auto" | "link";
    }) =>
      responseJson(
        await mailApi.api.mail.messages[":id"].unsubscribe.$post({
          param: { id: input.messageId },
          query: { mailboxId: input.mailboxId },
          json: { method: input.method },
        })
      ),
    onSuccess: (_result, { mailboxId }) => refresh(mailboxId),
  });
}

export function useReportMessage() {
  const refresh = useMailboxRefresh();

  return useMutation({
    mutationFn: async (input: { mailboxId: string; messageId: string }) =>
      responseJson(
        await mailApi.api.mail.messages[":id"].report.$post({
          param: { id: input.messageId },
          query: { mailboxId: input.mailboxId },
        })
      ),
    onSuccess: (_result, { mailboxId }) => refresh(mailboxId),
  });
}

export function useBulkReport() {
  const refresh = useMailboxRefresh();

  return useMutation({
    mutationFn: async (input: {
      mailboxId: string;
      conversationIds: string[];
    }) =>
      responseJson(
        await mailApi.api.mail.conversations.report.$post({
          query: { mailboxId: input.mailboxId },
          json: { conversationIds: input.conversationIds },
        })
      ),
    onSuccess: (_result, { mailboxId }) => refresh(mailboxId),
  });
}

export function useNotSpam() {
  const refresh = useMailboxRefresh();

  return useMutation({
    mutationFn: async (input: { mailboxId: string; messageId: string }) =>
      responseJson(
        await mailApi.api.mail.messages[":id"]["not-spam"].$post({
          param: { id: input.messageId },
          query: { mailboxId: input.mailboxId },
        })
      ),
    onSuccess: (_result, { mailboxId }) => refresh(mailboxId),
  });
}

export function useBlockedSenders(mailboxId: string, enabled: boolean) {
  return useQuery({
    queryKey: blockedKey(mailboxId),
    queryFn: async ({ signal }) =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"]["blocked-senders"].$get(
          { param: { id: mailboxId } },
          { init: { signal } }
        )
      ),
    enabled,
  });
}

export function useBlockSender() {
  const refresh = useMailboxRefresh();

  return useMutation({
    mutationFn: async (input: {
      mailboxId: string;
      pattern: string;
      moveExisting: boolean;
    }) =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"]["blocked-senders"].$post({
          param: { id: input.mailboxId },
          json: { pattern: input.pattern, moveExisting: input.moveExisting },
        })
      ),
    onSuccess: (_result, { mailboxId }) => refresh(mailboxId),
  });
}

export function useUnblockSender() {
  const refresh = useMailboxRefresh();

  return useMutation({
    mutationFn: async (input: { mailboxId: string; pattern: string }) =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"]["blocked-senders"].$delete({
          param: { id: input.mailboxId },
          query: { pattern: input.pattern },
        })
      ),
    onSuccess: (_result, { mailboxId }) => refresh(mailboxId),
  });
}

export function useTrustSender() {
  const refresh = useMailboxRefresh();

  return useMutation({
    mutationFn: async (input: {
      mailboxId: string;
      address: string;
      trusted: boolean;
    }) =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"]["trusted-senders"].$put({
          param: { id: input.mailboxId },
          json: { address: input.address, trusted: input.trusted },
        })
      ),
    onSuccess: (_result, { mailboxId }) => refresh(mailboxId),
  });
}
