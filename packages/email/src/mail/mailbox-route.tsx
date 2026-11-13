import { useParams } from "react-router";

import { MailShell } from "./mail-shell";
import { useMailboxes } from "./use-mail-data";

/** The mail app at "/" (the default mailbox) and at `MAIL_ROUTE`. */
export function MailboxRoute() {
  const { mailboxId, folder, conversationId } = useParams();
  const mailboxes = useMailboxes();
  // "/" is keyed by the mailbox it shows, so its redirect to /mail/:id keeps
  // the screen (and its requests in flight) instead of starting over.
  const key = mailboxId ?? mailboxes.data?.mailboxes[0]?.id ?? "default";

  return <MailShell key={key} route={{ mailboxId, folder, conversationId }} />;
}
