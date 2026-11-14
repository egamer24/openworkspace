/**
 * One order for every folder of a mailbox. Inbox is pinned first; the system
 * folders after it can be placed anywhere among the person's own folders.
 */

/** System folders that take part in the order; Inbox is always first. */
export const MOVABLE_SYSTEM_FOLDER_IDS = [
  "sent",
  "archive",
  "spam",
  "trash",
] as const;

export type SystemFolderId =
  | "inbox"
  | (typeof MOVABLE_SYSTEM_FOLDER_IDS)[number];

/** Where the system folders sit until someone moves them: before any custom folder. */
export const DEFAULT_SYSTEM_FOLDER_ORDER = {
  inbox: 0,
  sent: 10,
  archive: 20,
  spam: 30,
  trash: 40,
} satisfies Record<SystemFolderId, number>;

function isSystemFolderId(id: string): id is SystemFolderId {
  return Object.hasOwn(DEFAULT_SYSTEM_FOLDER_ORDER, id);
}

/** The default position of a system folder by id; undefined for custom folders. */
export function defaultSystemFolderOrder(id: string) {
  return isSystemFolderId(id) ? DEFAULT_SYSTEM_FOLDER_ORDER[id] : undefined;
}

/**
 * Drafts: a system folder of the person's own drafts, always right after
 * Sent. It lists the `drafts` table, not conversations, so it takes no part
 * in the order and no folder predicate covers it.
 */
export const DRAFTS_FOLDER_ID = "drafts";

/** The gap between neighbours, so a folder created later can go after the last. */
export const FOLDER_ORDER_STEP = 10;

/**
 * Whether `folderIds` is a complete order of the movable folders: every
 * movable system folder and custom folder exactly once, and never Inbox.
 */
export function isCompleteFolderOrder(
  folderIds: readonly string[],
  customFolderIds: readonly string[]
) {
  const expected = new Set<string>([
    ...MOVABLE_SYSTEM_FOLDER_IDS,
    ...customFolderIds,
  ]);

  return (
    folderIds.length === expected.size &&
    new Set(folderIds).size === folderIds.length &&
    folderIds.every((id) => expected.has(id))
  );
}

/** The stored position of each folder in a complete order, after Inbox's 0. */
export function folderOrderPositions(folderIds: readonly string[]) {
  return folderIds.map((id, index) => ({
    id,
    sortOrder: (index + 1) * FOLDER_ORDER_STEP,
  }));
}

type Orderable = { id: string; name: string; sortOrder: number };

/** Folders in display order: Inbox first, then by position, ties by name. */
export function sortFolders<T extends Orderable>(folders: readonly T[]): T[] {
  return [...folders].sort(
    (left, right) =>
      Number(right.id === "inbox") - Number(left.id === "inbox") ||
      left.sortOrder - right.sortOrder ||
      left.name.localeCompare(right.name)
  );
}

/**
 * The order after moving one folder a step up (-1) or down (+1), as the ids
 * the reorder API takes (every folder but Inbox); null when it can't move.
 */
export function moveFolderInOrder<T extends Orderable>(
  folders: readonly T[],
  folderId: string,
  direction: -1 | 1
) {
  const ids = sortFolders(folders)
    .map((folder) => folder.id)
    .filter((id) => id !== "inbox" && id !== DRAFTS_FOLDER_ID);

  const index = ids.indexOf(folderId);
  const target = index + direction;

  const moving = ids[index];
  const neighbour = ids[target];

  if (index === -1 || moving === undefined || neighbour === undefined) {
    return null;
  }

  ids[index] = neighbour;
  ids[target] = moving;

  return ids;
}
