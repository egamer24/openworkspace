type ActiveMailboxSessionRow = {
  id: string;
  token_hash: string;
  user_id: string;
};

export type ActiveMailboxSession = {
  id: string;
  tokenHash: string;
  userId: string;
};

type MailboxUserRow = {
  id: string;
  name: string;
};

function idList(ids: string[]) {
  return JSON.stringify([...new Set(ids)]);
}

export async function listActiveMailboxSessions(
  db: D1Database,
  mailboxId: string,
  sessionIds: string[],
  now: number
): Promise<ActiveMailboxSession[]> {
  if (!sessionIds.length) return [];

  // D1 allows only 100 bound parameters, so the complete ID set is bound as
  // one JSON value and expanded by SQLite instead of generating a large IN.
  const result = await db
    .prepare(`
    with requested_sessions(id) as (
      select cast(value as text) from json_each(?)
    )
    select
      session.id,
      session.token_hash,
      session.user_id
    from requested_sessions requested
    inner join sessions session on session.id = requested.id
    inner join users user on user.id = session.user_id
    inner join mailbox_access member
      on member.user_id = session.user_id
      and member.mailbox_id = ?
    where session.expires_at > ?
      and user.status = 'active'
  `)
    .bind(idList(sessionIds), mailboxId, now)
    .all<ActiveMailboxSessionRow>();

  return result.results.map((session) => ({
    id: session.id,
    tokenHash: session.token_hash,
    userId: session.user_id,
  }));
}

export async function listMailboxUsersByIds(
  db: D1Database,
  mailboxId: string,
  userIds: string[]
) {
  if (!userIds.length) return [];

  const result = await db
    .prepare(`
    with requested_users(id) as (
      select cast(value as text) from json_each(?)
    )
    select user.id, user.name
    from requested_users requested
    inner join mailbox_access member
      on member.user_id = requested.id
      and member.mailbox_id = ?
    inner join users user on user.id = member.user_id
  `)
    .bind(idList(userIds), mailboxId)
    .all<MailboxUserRow>();

  return result.results;
}
