import { sortFolders } from "../../shared/folder-order";
import type { Folder, MailFolder } from "./types";

const systemFolderLabels = new Map([
  ["inbox", "Inbox"],
  ["sent", "Sent"],
  ["drafts", "Drafts"],
  ["archive", "Archive"],
  ["spam", "Spam"],
  ["trash", "Trash"],
]);

export function folderDisplayName(folder: Folder, folders?: MailFolder[]) {
  return (
    folders?.find((item) => item.id === folder)?.name ??
    systemFolderLabels.get(folder) ??
    folder
  );
}

export function folderShowsUnreadCount(folder: MailFolder | undefined) {
  return folder?.kind === "custom" || folder?.systemType === "inbox";
}

/** The count a folder shows: unread in Inbox and custom folders, every draft in Drafts. */
export function unreadOf(folder: MailFolder) {
  if (folder.systemType === "drafts") return folder.totalCount;

  return folderShowsUnreadCount(folder) ? folder.unreadCount : 0;
}

/**
 * Every folder in the mailbox's one order, as the sidebar, rail, dock and
 * folder pickers list them: Inbox first, then system and custom folders
 * wherever they were placed.
 */
export function orderedFolders(folders: readonly MailFolder[]) {
  return sortFolders(folders);
}

/** Where switching to another mailbox lands: the same folder if it has one, otherwise Inbox. */
export function folderAfterMailboxSwitch(
  folder: Folder,
  targetFolders: MailFolder[] | undefined
): Folder {
  return targetFolders?.some((item) => item.id === folder) ? folder : "inbox";
}
