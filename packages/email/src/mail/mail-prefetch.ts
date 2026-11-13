import type { QueryClient } from "@tanstack/react-query";

import { parseMailPath } from "../../shared/mail-path";
import {
  conversationQuery,
  conversationsQuery,
  foldersQuery,
  mailboxesQuery,
} from "./mail-queries";

/**
 * Starts what the mail screen at this URL loads first, while its code is
 * still on the way: the mailbox list and, for a /mail/:id/:folder?/:conversationId? path, that mailbox's
 * folders, the first page of the folder's list and the open conversation;
 * for "/", the first mailbox's once the list names it. The screen's own
 * queries pick these up by key.
 */
export function prefetchMail({
  queryClient,
  pathname,
}: {
  queryClient: QueryClient;
  pathname: string;
}) {
  const route = parseMailPath(pathname);

  if (pathname !== "/" && !route) return;
  const folder = route?.folder ?? "inbox";

  const start = (mailboxId: string, conversationId: string | null) => {
    void queryClient.prefetchQuery(foldersQuery(mailboxId));
    void queryClient.prefetchInfiniteQuery(
      conversationsQuery(mailboxId, folder, "", false)
    );

    if (conversationId) {
      void queryClient.prefetchInfiniteQuery(
        conversationQuery(mailboxId, conversationId)
      );
    }
  };

  const mailboxes = queryClient.fetchQuery(mailboxesQuery());

  if (route) {
    start(route.mailboxId, route.conversationId);

    return;
  }

  void mailboxes.then(
    (data) => {
      const first = data.mailboxes[0];

      if (first) start(first.id, null);
    },
    () => undefined
  );
}
