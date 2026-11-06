import { buildEmailSearchQuery } from "../mail/search";
import type { MailboxState } from "../mailbox/folder-model";

/**
 * A JMAP Mailbox inside one OpenWorkspace mailbox: a system view, a custom
 * folder (`f:<id>`), or `none` for ids that live elsewhere (always false).
 */
export type LocalBox =
  | "inbox"
  | "sent"
  | "archive"
  | "spam"
  | "trash"
  | `f:${string}`
  | "none";

export type Placement = {
  direction: "incoming" | "outgoing";
  mailboxState: MailboxState;
  folderId: string | null;
  hasIncoming: boolean;
};

/**
 * Folder state belongs to the conversation; Sent is per message direction.
 * Keep this in sync with `boxPredicate` below and with folder-model.ts.
 */
export function emailBoxes(email: Placement): LocalBox[] {
  const boxes: LocalBox[] = [];
  if (email.mailboxState === "active") {
    if (email.hasIncoming) {
      boxes.push("inbox");
      if (email.folderId) boxes.push(`f:${email.folderId}`);
    }
  } else {
    boxes.push(email.mailboxState);
  }
  if (email.direction === "outgoing" && email.mailboxState !== "trash") {
    boxes.push("sent");
  }
  return boxes;
}

export type EmailFilter =
  | { operator: "AND" | "OR" | "NOT"; conditions: EmailFilter[] }
  | { inMailbox: LocalBox }
  | { inMailboxOtherThan: LocalBox[] }
  | { before: number }
  | { after: number }
  | { seen: boolean }
  | { hasAttachment: boolean }
  | { text: string }
  | { body: string }
  | { from: string }
  | { to: string }
  | { cc: string }
  | { bcc: string }
  | { subject: string }
  | { none: true };

export function boxPredicate(box: LocalBox, bindings: Array<string | number>) {
  if (box === "none") return "0";
  if (box === "inbox") return "(c.mailbox_state = 'active' and c.has_incoming = 1)";
  if (box === "sent") return "(e.direction = 'outgoing' and c.mailbox_state <> 'trash')";
  if (box.startsWith("f:")) {
    bindings.push(box.slice(2));
    return "(c.mailbox_state = 'active' and c.has_incoming = 1 and c.folder_id = ?)";
  }
  bindings.push(box);
  return "(c.mailbox_state = ?)";
}

function likePattern(value: string) {
  return `%${value.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
}

function searchPredicate(
  value: string,
  column: "body" | null,
  bindings: Array<string | number>,
) {
  const query = buildEmailSearchQuery(value);
  if (!query) return "0";
  bindings.push(column ? `${column} : (${query})` : query);
  return "e.id in (select email_id from email_search where email_search match ?)";
}

/**
 * Compiles a validated filter into SQL over `emails e join conversations c`.
 * User text only ever reaches SQL as bound parameters.
 */
export function compileEmailFilter(
  filter: EmailFilter,
  userId: string,
  bindings: Array<string | number>,
): string {
  if ("operator" in filter) {
    if (!filter.conditions.length) return filter.operator === "NOT" ? "1" : filter.operator === "AND" ? "1" : "0";
    const parts = filter.conditions.map((item) => compileEmailFilter(item, userId, bindings));
    if (filter.operator === "NOT") return `not (${parts.join(" or ")})`;
    return `(${parts.join(` ${filter.operator.toLowerCase()} `)})`;
  }
  if ("inMailbox" in filter) return boxPredicate(filter.inMailbox, bindings);
  if ("inMailboxOtherThan" in filter) {
    const boxes: LocalBox[] = ["inbox", "sent", "archive", "spam", "trash"];
    // "In any mailbox other than X" for derived views: the email is in at
    // least one view not listed. Custom folders always imply Inbox.
    const remaining = boxes.filter((box) => !filter.inMailboxOtherThan.includes(box));
    const listedFolders = filter.inMailboxOtherThan.flatMap((box) =>
      box.startsWith("f:") ? [box.slice(2)] : []
    );
    const parts: string[] = remaining.map((box) => boxPredicate(box, bindings));
    if (filter.inMailboxOtherThan.includes("inbox")) {
      bindings.push(JSON.stringify(listedFolders));
      parts.push(`(c.mailbox_state = 'active' and c.has_incoming = 1 and c.folder_id is not null
        and c.folder_id not in (select cast(value as text) from json_each(?)))`);
    }
    return parts.length ? `(${parts.join(" or ")})` : "0";
  }
  if ("before" in filter) {
    bindings.push(filter.before);
    return "e.timeline_at < ?";
  }
  if ("after" in filter) {
    bindings.push(filter.after);
    return "e.timeline_at >= ?";
  }
  if ("seen" in filter) {
    bindings.push(userId);
    const seen = `(e.direction = 'outgoing' or exists (
      select 1 from email_read_states r where r.user_id = ? and r.email_id = e.id
    ))`;
    return filter.seen ? seen : `not ${seen}`;
  }
  if ("hasAttachment" in filter) {
    const has = `exists (
      select 1 from json_each(e.attachments_json) a
      where json_extract(a.value, '$.disposition') = 'attachment'
    )`;
    return filter.hasAttachment ? has : `not ${has}`;
  }
  if ("text" in filter) return searchPredicate(filter.text, null, bindings);
  if ("body" in filter) return searchPredicate(filter.body, "body", bindings);
  if ("subject" in filter) {
    bindings.push(likePattern(filter.subject));
    return "e.subject like ? escape '\\'";
  }
  if ("none" in filter) return "0";
  const [field, value] = Object.entries(filter)[0] as ["from" | "to" | "cc" | "bcc", string];
  bindings.push(likePattern(value));
  return `e.${field}_json like ? escape '\\'`;
}
