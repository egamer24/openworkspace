import { mailPath } from "../../shared/mail-path";
import type { Folder, Mailbox, MailFolder } from "./types";

export function mailboxForRoute(
  mailboxId: string | undefined,
  mailboxes: Mailbox[]
) {
  return mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? mailboxes[0];
}

/** The mailbox, folder and conversation segments of a mail URL, decoded. */
export type MailRoute = {
  mailboxId?: string;
  folder?: string;
  conversationId?: string;
};

/** The path a route's segments spell, exactly as given (see `mailPath` for the canonical one). */
export function routePath(route: MailRoute) {
  if (!route.mailboxId) return "/";

  return `/mail/${[route.mailboxId, route.folder, route.conversationId]
    .flatMap((segment) => (segment ? [encodeURIComponent(segment)] : []))
    .join("/")}`;
}

/**
 * Where the mail screen is, from the URL and whatever has loaded so far.
 * Before the mailbox list and folders arrive, the URL's mailbox, folder and
 * conversation are used as they are, so their data can load in parallel
 * (the server checks access). Once both are known, an unknown mailbox falls
 * back to the first one and an unknown folder to Inbox, both dropping the
 * conversation, and `canonicalPath` is what the URL should then say.
 */
export function resolveMailLocation(
  route: MailRoute,
  mailboxes: Mailbox[] | undefined,
  folders: MailFolder[] | undefined
) {
  const { mailboxId } = route;

  const requestedMailbox = mailboxes?.find(
    (mailbox) => mailbox.id === mailboxId
  );

  const mailbox = mailboxes ? mailboxForRoute(mailboxId, mailboxes) : undefined;
  const requestedFolder: Folder = route.folder ?? "inbox";
  const ready = Boolean(mailbox && folders);

  const folderExists =
    folders?.some((folder) => folder.id === requestedFolder) ?? false;

  const folderStale = Boolean(folders) && !folderExists;
  const mailboxStale = Boolean(mailboxes) && !requestedMailbox;
  const folder = folderStale ? "inbox" : requestedFolder;

  const conversationId =
    mailboxId && !mailboxStale && !folderStale
      ? route.conversationId
      : undefined;

  return {
    mailbox,
    /** The mailbox to load data for: the URL's until the list says otherwise. */
    mailboxId: mailboxes ? mailbox?.id : mailboxId,
    folder,
    conversationId,
    ready,
    canonicalPath: mailbox
      ? mailPath(mailbox.id, folder, conversationId)
      : undefined,
  };
}
