import { useQuery } from "@tanstack/react-query";

import { sanitizedHtmlQuery } from "./mail-queries";
import type { MessageDetail } from "./types";

export function useSanitizedEmailHtml(
  mailboxId: string,
  message: MessageDetail
) {
  return useQuery({
    ...sanitizedHtmlQuery(mailboxId, message),
    // A new remote token re-sanitizes the same message: keep showing the
    // document it replaces rather than a skeleton.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === mailboxId &&
      previousQuery.queryKey[2] === message.id
        ? previous
        : undefined,
  });
}
