import { ApiError, responseJson } from "@open-workspace/core/ui";
import {
  infiniteQueryOptions,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import {
  CONVERSATION_PAGE_SIZE,
  MAX_BULK_CONVERSATION_COUNT,
} from "../../shared/mail";
import { mailApi } from "../lib/mail-api";
import type { MessageDetail } from "./types";

/**
 * Query definitions shared by the mail screen's hooks and by the prefetch
 * that starts them before the screen's code has loaded (see client.tsx).
 * Kept free of UI imports so the app's entry stays small.
 */

const MESSAGE_PAGE_SIZE = 25;

/**
 * Realtime updates (with versions) say when mail data changed, so cached
 * conversations stay fresh for a while: reopening one shows it at once.
 */
const CONVERSATION_STALE_MS = 5 * 60_000;

/** A 4xx (no access, unknown folder) will not change by asking again. */
function retryServerErrors(failureCount: number, error: Error) {
  if (error instanceof ApiError && error.status < 500) return false;

  return failureCount < 1;
}

export function mailboxesQuery() {
  return queryOptions({
    queryKey: ["mailboxes"],
    queryFn: async ({ signal }) =>
      responseJson(
        await mailApi.api.mail.mailboxes.$get(undefined, {
          init: { signal },
        })
      ),
  });
}

/** A list's first page has no cursor; later pages pass the one before's. */
const FIRST_PAGE: string | undefined = undefined;

export function foldersQuery(mailboxId: string | undefined) {
  return queryOptions({
    queryKey: ["folders", mailboxId],
    queryFn: mailboxId
      ? async ({ signal }) =>
          responseJson(
            await mailApi.api.mail.mailboxes[":id"].folders.$get(
              { param: { id: mailboxId } },
              { init: { signal } }
            )
          )
      : skipToken,
    retry: retryServerErrors,
  });
}

export function conversationsQuery(
  mailboxId: string | undefined,
  folder: string,
  search: string,
  unreadOnly: boolean
) {
  return infiniteQueryOptions({
    queryKey: ["conversations", mailboxId, folder, search, unreadOnly],
    initialPageParam: FIRST_PAGE,
    queryFn: mailboxId
      ? async ({ pageParam, signal }) =>
          responseJson(
            await mailApi.api.mail.conversations.$get(
              {
                query: {
                  mailboxId,
                  folder,
                  limit: String(CONVERSATION_PAGE_SIZE),
                  cursor: pageParam,
                  search: search || undefined,
                  unreadOnly: unreadOnly ? "true" : undefined,
                },
              },
              { init: { signal } }
            )
          )
      : skipToken,
    getNextPageParam: (page, pages) => {
      const loadedCount = pages.reduce(
        (count, loadedPage) => count + loadedPage.conversations.length,
        0
      );

      return loadedCount < MAX_BULK_CONVERSATION_COUNT
        ? (page.nextCursor ?? undefined)
        : undefined;
    },
    retry: retryServerErrors,
  });
}

let sanitizer: Promise<typeof import("./sanitize-email-html")> | undefined;

/**
 * The HTML sanitizer and DOMPurify, one chunk off the app's entry. The mail
 * screen's preload starts it, so the first message body need not wait.
 */
export function loadSanitizer() {
  sanitizer ??= import("./sanitize-email-html").catch((cause: unknown) => {
    sanitizer = undefined;
    throw cause;
  });

  return sanitizer;
}

/**
 * A message's sanitized HTML. Stored bodies never change, so it stays; the
 * remote token is in the key because the document's image URLs carry it,
 * and a conversation fetched in a later token window sanitizes again.
 */
export function sanitizedHtmlQuery(mailboxId: string, message: MessageDetail) {
  return queryOptions({
    queryKey: [
      "sanitized-message-html",
      mailboxId,
      message.id,
      message.remoteTokens,
    ],
    queryFn: async () =>
      (await loadSanitizer()).sanitizeEmailHtml({
        html: message.bodyHtml ?? "",
        mailboxId,
        messageId: message.id,
        attachments: message.attachments,
        remoteTokens: message.remoteTokens,
      }),
    enabled: Boolean(message.bodyHtml),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Sanitizes the bodies a newly fetched conversation page shows expanded (the
 * latest message and unread ones), so opening the conversation, prefetched
 * or not, finds them ready instead of a skeleton.
 */
function sanitizeAhead(
  client: QueryClient,
  mailboxId: string,
  messages: MessageDetail[],
  firstPage: boolean
) {
  messages.forEach((message, index) => {
    const expanded =
      !message.isRead || (firstPage && index === messages.length - 1);

    if (expanded && message.bodyHtml) {
      void client.prefetchQuery(sanitizedHtmlQuery(mailboxId, message));
    }
  });
}

export function conversationQuery(
  mailboxId: string | undefined,
  conversationId: string | undefined
) {
  return infiniteQueryOptions({
    queryKey: ["conversation", mailboxId, conversationId],
    initialPageParam: FIRST_PAGE,
    queryFn:
      mailboxId && conversationId
        ? async ({ client, pageParam, signal }) => {
            const page = await responseJson(
              await mailApi.api.mail.conversations[":id"].$get(
                {
                  param: { id: conversationId },
                  query: {
                    mailboxId,
                    limit: String(MESSAGE_PAGE_SIZE),
                    cursor: pageParam,
                  },
                },
                { init: { signal } }
              )
            );

            sanitizeAhead(
              client,
              mailboxId,
              page.messages,
              pageParam === undefined
            );

            return page;
          }
        : skipToken,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: CONVERSATION_STALE_MS,
    retry: retryServerErrors,
  });
}
