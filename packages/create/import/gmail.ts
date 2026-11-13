import { decodeWords } from "./headers.ts";
import type { Placement } from "./protocol.ts";

/**
 * Gmail labels (Takeout's X-Gmail-Labels header, IMAP's X-GM-LABELS) mapped
 * onto OpenWorkspace, where a conversation has one place and at most one
 * custom folder, and read state is per message.
 */

/** Splits Takeout's X-Gmail-Labels value: comma-separated, quoted when a label has a comma. */
export function parseGmailLabelsHeader(value: string) {
  const labels: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);

    if (char === "\\" && quoted && index + 1 < value.length) {
      current += value[index + 1];
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      labels.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  labels.push(current);

  return labels.flatMap((label) => {
    const decoded = decodeWords(label.trim());

    return decoded ? [decoded] : [];
  });
}

/** Labels that are Gmail's own state, not folders the person made. */
const SYSTEM_LABELS = new Set([
  "inbox",
  "sent",
  "spam",
  "trash",
  "draft",
  "drafts",
  "unread",
  "opened",
  "starred",
  "important",
  "archived",
  "chat",
  "chats",
  "all mail",
  "muted",
  "scheduled",
  "snoozed",
]);

function systemName(label: string) {
  // IMAP spells system labels \Inbox, \Sent, \Important, ...
  return label.replace(/^\\/u, "").toLowerCase();
}

function isUserLabel(label: string) {
  const name = systemName(label);

  return (
    !label.startsWith("\\") &&
    !SYSTEM_LABELS.has(name) &&
    !name.startsWith("category ") &&
    !name.startsWith("[imap]") &&
    !name.startsWith("[gmail]")
  );
}

export type GmailMessage = {
  /** Drafts and chats have no place in a mailbox; they are skipped. */
  skip: "draft" | "chat" | null;
  placement: Placement;
  /** Whether the message was read; null when the labels do not say. */
  seen: boolean | null;
  /**
   * Whether it is mail the account sent. Mail sent to oneself is both Sent
   * and in the Inbox; it is imported as received, so it shows in the Inbox.
   */
  sent: boolean;
  /** The person's own labels, as folder candidates. */
  userLabels: string[];
};

export type GmailOptions = {
  /**
   * What a message with the person's labels but not in the Inbox becomes:
   * Archive (the labels are lost), or the Inbox in the label's folder.
   * Custom folders here are views of the Inbox, so "folder" brings such
   * mail back to the Inbox.
   */
  archivedLabels: "archive" | "folder";
};

/**
 * A message's place from its labels: Trash, then Spam, then the Inbox, then
 * (for labelled mail outside the Inbox) Archive or its folder, then Sent
 * alone (no say over the conversation), then Archive.
 */
export function gmailMessage(
  labels: string[],
  options: GmailOptions
): GmailMessage {
  const names = new Set(labels.map(systemName));

  const userLabels = [
    ...new Set(
      labels.flatMap((label) => (isUserLabel(label) ? [label.trim()] : []))
    ),
  ];

  const skip =
    names.has("draft") || names.has("drafts")
      ? "draft"
      : names.has("chat") || names.has("chats")
        ? "chat"
        : null;

  const sent = names.has("sent") && !names.has("inbox");

  const placement: Placement = names.has("trash")
    ? "trash"
    : names.has("spam")
      ? "spam"
      : names.has("inbox")
        ? "inbox"
        : userLabels.length && options.archivedLabels === "folder"
          ? "inbox"
          : sent
            ? "sent"
            : "archive";

  const seen = names.has("unread") ? false : names.has("opened") ? true : null;

  return { skip, placement, seen, sent, userLabels };
}

/** OpenWorkspace folder names are at most 80 characters; nested labels keep their slashes. */
export function folderName(label: string) {
  return label.trim().slice(0, 80);
}

/**
 * Tallies the person's labels over each thread's messages, so every message
 * of a thread names the same folder.
 */
export class ThreadFolders {
  private readonly counts = new Map<string, Map<string, number>>();

  constructor(private readonly priority: string[] = []) {}

  add(thread: string, labels: string[]) {
    let tally = this.counts.get(thread);

    if (!tally) this.counts.set(thread, (tally = new Map()));

    for (const label of labels) tally.set(label, (tally.get(label) ?? 0) + 1);
  }

  /**
   * The thread's folder: the first of `priority` it carries, else the label
   * on most of its messages, else (ties) the first alphabetically.
   */
  folder(thread: string, fallback: string[] = []): string | null {
    const tally =
      this.counts.get(thread) ?? new Map(fallback.map((label) => [label, 1]));

    if (!tally.size) return null;

    const lower = new Map(
      [...tally.keys()].map((label) => [label.toLowerCase(), label])
    );

    for (const preferred of this.priority) {
      const found = lower.get(preferred.toLowerCase());

      if (found) return folderName(found);
    }

    const [best] = [...tally.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );

    return best ? folderName(best[0]) : null;
  }
}
