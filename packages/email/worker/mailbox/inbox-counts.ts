import { systemFolderPredicate } from "./folder-model";

/**
 * A mailbox's inbox counts as D1 keeps them (see `mailboxCounts` in
 * worker/db/schema.ts): incoming inbox messages, and how many of them each
 * person has read. A person's unread count is the difference.
 */
export type InboxCounts = {
  incomingCount: number;
  readCounts: Map<string, number>;
};

const INBOX = systemFolderPredicate("inbox", "c");

/** The inbox counts from the mailbox's own SQLite. */
export function readInboxCounts(sql: SqlStorage): InboxCounts {
  const incoming = sql
    .exec<{ incoming_count: number }>(`
    select count(*) as incoming_count
    from emails message
    join conversations c on c.id = message.conversation_id
    where message.direction = 'incoming' and ${INBOX}
  `)
    .one();

  const reads = sql
    .exec<{ user_id: string; read_count: number }>(`
    select read_state.user_id, count(*) as read_count
    from email_read_states read_state
    join emails message on message.id = read_state.email_id
    join conversations c on c.id = message.conversation_id
    where message.direction = 'incoming' and ${INBOX}
    group by read_state.user_id
  `)
    .toArray();

  return {
    incomingCount: Number(incoming.incoming_count),
    readCounts: new Map(
      reads.map((row) => [row.user_id, Number(row.read_count)])
    ),
  };
}

/**
 * Writes the counts to D1 in one batch on the primary and returns the
 * session bookmark after it (null where D1 has none, e.g. locally). A
 * mailbox that is not (or no longer) in D1 has nothing to write.
 * With `previous` (what the last successful write stored), only people
 * whose read count changed are written; without it, the mailbox's rows are
 * replaced.
 */
export async function writeInboxCounts(
  binding: D1Database,
  input: {
    mailboxId: string;
    version: number;
    counts: InboxCounts;
    previous: InboxCounts | null;
  }
) {
  const { mailboxId, version, counts, previous } = input;
  const session = binding.withSession("first-primary");

  const statements = [
    session
      .prepare(`
      insert into mailbox_counts (mailbox_id, incoming_count, version, updated_at)
      select id, ?, ?, ? from mailboxes where id = ?
      on conflict (mailbox_id) do update set
        incoming_count = excluded.incoming_count,
        version = excluded.version,
        updated_at = excluded.updated_at
    `)
      .bind(counts.incomingCount, version, Date.now(), mailboxId),
  ];

  if (!previous) {
    statements.push(
      session
        .prepare("delete from mailbox_read_counts where mailbox_id = ?")
        .bind(mailboxId)
    );
  }

  const upsert = `
    insert into mailbox_read_counts (mailbox_id, user_id, read_count)
    select id, ?, ? from mailboxes where id = ?
    on conflict (mailbox_id, user_id) do update set read_count = excluded.read_count
  `;

  for (const [userId, readCount] of counts.readCounts) {
    if (previous && previous.readCounts.get(userId) === readCount) continue;
    statements.push(session.prepare(upsert).bind(userId, readCount, mailboxId));
  }

  for (const userId of previous?.readCounts.keys() ?? []) {
    if (!counts.readCounts.has(userId)) {
      statements.push(session.prepare(upsert).bind(userId, 0, mailboxId));
    }
  }

  await session.batch(statements);

  return session.getBookmark();
}
