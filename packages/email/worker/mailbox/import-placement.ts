import type { ImportPlacement } from "../../shared/mail-import";
import type { MailboxState } from "./folder-model";

/** A conversation's place: its state, and its custom folder while it is in the Inbox. */
export type ConversationPlacement = {
  mailboxState: MailboxState;
  folderId: string | null;
};

/**
 * How strongly a place holds a conversation when imported messages disagree
 * (Gmail labels each message, a conversation here has one place): Trash,
 * then Spam, then a custom folder, then the Inbox, then Archive. A sent
 * message on its own has no say.
 */
function rank(placement: ConversationPlacement | null) {
  if (!placement) return 0;

  switch (placement.mailboxState) {
    case "trash": {
      return 5;
    }

    case "spam": {
      return 4;
    }

    case "active": {
      return placement.folderId ? 3 : 2;
    }

    case "archive": {
      return 1;
    }

    default: {
      const unexpected: never = placement.mailboxState;
      throw new Error(`Unknown mailbox state ${String(unexpected)}`);
    }
  }
}

/** The place an imported message asks for, or null for none (`sent`). */
export function requestedPlacement(
  placement: ImportPlacement,
  folderId: string | null
): ConversationPlacement | null {
  switch (placement) {
    case "inbox": {
      return { mailboxState: "active", folderId };
    }

    case "archive": {
      return { mailboxState: "archive", folderId: null };
    }

    case "spam": {
      return { mailboxState: "spam", folderId: null };
    }

    case "trash": {
      return { mailboxState: "trash", folderId: null };
    }

    case "sent": {
      return null;
    }

    default: {
      const unexpected: never = placement;
      throw new Error(`Unknown import placement ${String(unexpected)}`);
    }
  }
}

/**
 * Where a conversation goes once an imported message joins it: the stronger
 * of where it was before (null when it is new) and where the message asks
 * for; on a tie, where it was. Null leaves the conversation as indexing put it.
 */
export function mergedPlacement(
  before: ConversationPlacement | null,
  requested: ConversationPlacement | null
): ConversationPlacement | null {
  if (!before) return requested;

  return rank(requested) > rank(before) ? requested : before;
}
