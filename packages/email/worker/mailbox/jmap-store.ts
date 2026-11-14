import { DRAFTS_FOLDER_ID } from "../../shared/folder-order";
import { defaultSystemFolderOrder } from "./folder-model";
/**
 * JMAP views over a mailbox's SQLite store (RFC 8621). A JMAP Mailbox is a
 * system folder or a custom folder; an email sits in exactly one, derived
 * from its conversation's state and its own direction.
 */

/** Which JMAP Mailbox an email (alias e) of conversation (alias c) is in. */
export const EMAIL_MAILBOX_SQL = `case
  when c.mailbox_state = 'trash' then 'trash'
  when c.mailbox_state = 'spam' then 'spam'
  when c.mailbox_state = 'archive' then 'archive'
  when e.direction = 'outgoing' then 'sent'
  when c.folder_id is not null then c.folder_id
  else 'inbox'
end`;

const SYSTEM_MAILBOXES = [
  { id: "inbox", name: "Inbox", role: "inbox" },
  { id: "sent", name: "Sent", role: "sent" },
  { id: "archive", name: "Archive", role: "archive" },
  { id: "spam", name: "Spam", role: "junk" },
  { id: "trash", name: "Trash", role: "trash" },
] as const;

export type JmapMailboxRow = {
  id: string;
  name: string;
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
};

export type JmapEmailFilter = {
  inMailbox?: string;
  inMailboxOtherThan?: string[];
  before?: number;
  after?: number;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
};

const STATE_KEY = "jmap:state";

/** A counter bumped on every change; JMAP clients compare it to resync. */
export function jmapState(storage: DurableObjectStorage) {
  return String(storage.kv.get<number>(STATE_KEY) ?? 0);
}

export function bumpJmapState(storage: DurableObjectStorage) {
  storage.kv.put(STATE_KEY, (storage.kv.get<number>(STATE_KEY) ?? 0) + 1);
}

const unread = (userId: string) => ({
  sql: "not exists (select 1 from email_read_states r where r.email_id = e.id and r.user_id = ?)",
  params: [userId],
});

export function mailboxes(sql: SqlStorage, userId: string): JmapMailboxRow[] {
  const isUnread = unread(userId);

  const counts = new Map(
    sql
      .exec<{
        mailbox: string;
        total: number;
        unread: number;
        threads: number;
        unread_threads: number;
      }>(
        `
      select mailbox,
        count(*) as total,
        sum(is_unread) as unread,
        count(distinct conversation_id) as threads,
        count(distinct case when is_unread then conversation_id end) as unread_threads
      from (
        select ${EMAIL_MAILBOX_SQL} as mailbox, e.conversation_id, ${isUnread.sql} as is_unread
        from emails e join conversations c on c.id = e.conversation_id
      )
      group by mailbox`,
        ...isUnread.params
      )
      .toArray()
      .map((row) => [row.mailbox, row])
  );

  const custom = sql
    .exec<{ id: string; name: string; sort_order: number }>(
      "select id, name, sort_order from folders order by sort_order, name"
    )
    .toArray();

  // Mailbox order is the mail app's folder order, system folders where they were moved.
  const systemOrder = new Map(
    sql
      .exec<{ folder_id: string; sort_order: number }>(
        "select folder_id, sort_order from system_folder_order"
      )
      .toArray()
      .map((row) => [row.folder_id, row.sort_order])
  );

  // The person's drafts (the drafts table), right after Sent.
  const drafts = sql
    .exec<{ total: number }>(
      "select count(*) as total from drafts where user_id = ?",
      userId
    )
    .one().total;

  const sentOrder = systemOrder.get("sent") ?? defaultSystemFolderOrder("sent");

  const rows = [
    ...SYSTEM_MAILBOXES.map((mailbox) => ({
      ...mailbox,
      sortOrder:
        mailbox.id === "inbox"
          ? 0
          : (systemOrder.get(mailbox.id) ??
            defaultSystemFolderOrder(mailbox.id)),
    })),
    ...custom.map((folder) => ({
      id: folder.id,
      name: folder.name,
      role: null,
      sortOrder: folder.sort_order,
    })),
  ];

  const draftsMailbox = {
    id: DRAFTS_FOLDER_ID,
    name: "Drafts",
    role: "drafts",
    sortOrder: sentOrder + 1,
    totalEmails: drafts,
    unreadEmails: 0,
    totalThreads: drafts,
    unreadThreads: 0,
  };

  return [
    ...rows.map((mailbox) => {
      const count = counts.get(mailbox.id);

      return {
        ...mailbox,
        totalEmails: count?.total ?? 0,
        unreadEmails: count?.unread ?? 0,
        totalThreads: count?.threads ?? 0,
        unreadThreads: count?.unread_threads ?? 0,
      };
    }),
    draftsMailbox,
  ];
}

function ftsQuery(text: string) {
  // Each word must appear; quoting keeps FTS syntax out of user input.
  return text
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" ");
}

export function queryEmails(
  sql: SqlStorage,
  input: {
    userId: string;
    filter: JmapEmailFilter;
    ascending: boolean;
    position: number;
    limit: number;
    collapseThreads: boolean;
  }
) {
  const where: string[] = [];
  const params: unknown[] = [];
  const { filter } = input;

  if (filter.inMailbox) {
    where.push(`${EMAIL_MAILBOX_SQL} = ?`);
    params.push(filter.inMailbox);
  }

  if (filter.inMailboxOtherThan?.length) {
    where.push(
      `${EMAIL_MAILBOX_SQL} not in (${filter.inMailboxOtherThan.map(() => "?").join(", ")})`
    );
    params.push(...filter.inMailboxOtherThan);
  }

  if (filter.before !== undefined) {
    where.push("e.timeline_at < ?");
    params.push(filter.before);
  }

  if (filter.after !== undefined) {
    where.push("e.timeline_at >= ?");
    params.push(filter.after);
  }

  if (filter.text?.trim()) {
    where.push(
      "e.id in (select email_id from email_search where email_search match ?)"
    );
    params.push(ftsQuery(filter.text));
  }

  for (const [field, column] of [
    ["from", "e.from_json"],
    ["subject", "e.subject"],
  ] as const) {
    const value = filter[field];

    if (value) {
      where.push(`lower(${column}) like ?`);
      params.push(`%${value.toLowerCase()}%`);
    }
  }

  if (filter.to) {
    where.push("(lower(e.to_json) like ? or lower(e.cc_json) like ?)");
    params.push(`%${filter.to.toLowerCase()}%`, `%${filter.to.toLowerCase()}%`);
  }

  const isUnread = unread(input.userId);

  if (filter.hasKeyword === "$seen") {
    where.push(`not ${isUnread.sql}`);
    params.push(...isUnread.params);
  }

  if (filter.notKeyword === "$seen") {
    where.push(isUnread.sql);
    params.push(...isUnread.params);
  }

  if (filter.hasAttachment !== undefined) {
    where.push(
      filter.hasAttachment
        ? "json_array_length(e.attachments_json) > 0"
        : "json_array_length(e.attachments_json) = 0"
    );
  }

  const direction = input.ascending ? "asc" : "desc";

  const filtered = `
    select e.id, e.conversation_id, e.timeline_at,
      row_number() over (partition by e.conversation_id order by e.timeline_at desc, e.id desc) as thread_rank
    from emails e join conversations c on c.id = e.conversation_id
    ${where.length ? `where ${where.join(" and ")}` : ""}`;

  const rows = sql
    .exec<{ id: string; total: number }>(
      `
    select id, count(*) over () as total from (${filtered})
    ${input.collapseThreads ? "where thread_rank = 1" : ""}
    order by timeline_at ${direction}, id ${direction}
    limit ? offset ?`,
      ...params,
      input.limit,
      input.position
    )
    .toArray();

  const total =
    rows[0]?.total ??
    sql
      .exec<{ total: number }>(
        `select count(*) as total from (${filtered}) ${input.collapseThreads ? "where thread_rank = 1" : ""}`,
        ...params
      )
      .one().total;

  return { ids: rows.map((row) => row.id), total };
}

/** For each email: its JMAP Mailbox, and whether this user has read it. */
export function emailPlacement(sql: SqlStorage, userId: string, ids: string[]) {
  if (!ids.length) {
    return new Map<string, { mailboxId: string; seen: boolean }>();
  }

  const isUnread = unread(userId);

  return new Map(
    sql
      .exec<{ id: string; mailbox: string; is_unread: number }>(
        `
      select e.id, ${EMAIL_MAILBOX_SQL} as mailbox, ${isUnread.sql} as is_unread
      from emails e join conversations c on c.id = e.conversation_id
      where e.id in (${ids.map(() => "?").join(", ")})`,
        ...isUnread.params,
        ...ids
      )
      .toArray()
      .map((row) => [row.id, { mailboxId: row.mailbox, seen: !row.is_unread }])
  );
}

export function threadEmails(sql: SqlStorage, threadIds: string[]) {
  const threads = new Map<string, string[]>();

  if (!threadIds.length) return threads;

  for (const row of sql.exec<{ id: string; conversation_id: string }>(
    `select id, conversation_id from emails where conversation_id in (${threadIds.map(() => "?").join(", ")})
     order by timeline_at, id`,
    ...threadIds
  )) {
    threads.set(row.conversation_id, [
      ...(threads.get(row.conversation_id) ?? []),
      row.id,
    ]);
  }

  return threads;
}

/**
 * Moves the conversations of `emailIds` into a JMAP Mailbox. Conversations
 * move as a whole, as they do in the app. Returns false for an unknown or
 * read-only target.
 */
export function moveEmails(
  sql: SqlStorage,
  emailIds: string[],
  target: string
) {
  if (!emailIds.length) return true;
  let state: string;
  let folderId: string | null = null;

  if (target === "inbox") state = "active";
  else if (target === "archive" || target === "spam" || target === "trash") {
    state = target;
  } else if (
    sql.exec("select 1 from folders where id = ?", target).toArray().length
  ) {
    state = "active";
    folderId = target;
  } else {
    return false;
  }

  // Retention counts from entering Trash or Spam, so only those moves stamp it.
  sql.exec(
    `update conversations set mailbox_state = ?, folder_id = ?,
       state_changed_at = case
         when ? in ('trash', 'spam') and mailbox_state <> ? then ?
         else state_changed_at
       end
     where id in (select conversation_id from emails where id in (${emailIds.map(() => "?").join(", ")}))`,
    state,
    folderId,
    state,
    state,
    Date.now(),
    ...emailIds
  );

  return true;
}
