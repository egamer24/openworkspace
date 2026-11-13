import type { QueryClient } from "@tanstack/react-query";
import type { JSONParsed, JSONValue } from "hono/utils/types";

import type { MailBootstrap } from "../../worker/mail/bootstrap";
import {
  conversationsQuery,
  foldersQuery,
  mailboxesQuery,
} from "./mail-queries";

/**
 * Puts mail's part of the app's startup data (worker/mail/bootstrap.ts)
 * where the mail screen's queries read it: the mailbox list and, for the
 * mailbox in the URL, its folders and the first page of its folder.
 */
export function seedMail({
  queryClient,
  data,
}: {
  queryClient: QueryClient;
  data: JSONValue;
}) {
  // SAFETY: core hands each module the JSON of what its own server module's
  // `bootstrap` returned for this request, and mail's is `mailBootstrap`
  // (worker/mail/bootstrap.ts), built from this same source.
  const slice = data as JSONParsed<MailBootstrap>;
  queryClient.setQueryData(mailboxesQuery().queryKey, {
    ok: true as const,
    mailboxes: slice.mailboxes,
  });
  const { mailbox } = slice;

  if (!mailbox) return;
  queryClient.setQueryData(foldersQuery(mailbox.id).queryKey, {
    ok: true as const,
    ...mailbox.folders,
  });

  if (!mailbox.conversations) return;
  queryClient.setQueryData(
    conversationsQuery(mailbox.id, mailbox.folder, "", false).queryKey,
    {
      pages: [{ ok: true as const, ...mailbox.conversations }],
      pageParams: [undefined],
    }
  );
}
