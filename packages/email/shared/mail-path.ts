/**
 * The mail screen's URLs: /mail/:mailboxId is its Inbox,
 * /mail/:mailboxId/:folder another folder, and
 * /mail/:mailboxId/:folder/:conversationId a conversation in one.
 * Each segment is URL-encoded, since folder ids may hold spaces.
 */
export const MAIL_ROUTE = "/mail/:mailboxId/:folder?/:conversationId?";

export function mailPath(
  mailboxId: string,
  folder = "inbox",
  conversationId?: string | null
) {
  const segments = [mailboxId];

  if (conversationId) segments.push(folder, conversationId);
  else if (folder !== "inbox") segments.push(folder);

  return `/mail/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * The mailbox, folder and conversation a mail URL's path names, or null for
 * other paths and malformed encoding. A path without a folder means Inbox.
 */
export function parseMailPath(pathname: string) {
  const match = /^\/mail\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/u.exec(
    pathname
  );

  if (!match) return null;

  try {
    return {
      mailboxId: decodeURIComponent(match[1]),
      folder: match[2] ? decodeURIComponent(match[2]) : "inbox",
      conversationId: match[3] ? decodeURIComponent(match[3]) : null,
    };
  } catch {
    return null;
  }
}
