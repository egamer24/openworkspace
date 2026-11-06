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
  now: number,
): Promise<ActiveMailboxSession[]> {
  if (!sessionIds.length) return [];
  // D1 allows only 100 bound parameters, so the complete ID set is bound as
  // one JSON value and expanded by SQLite instead of generating a large IN.
  // Account API tokens hold JMAP push connections; they never expire but are
  // deleted on revocation.
  const result = await db.prepare(`
    with requested_sessions(id) as (
      select cast(value as text) from json_each(?)
    )
    select
      requested.id,
      coalesce(session.token_hash, token.token_hash) as token_hash,
      user.id as user_id
    from requested_sessions requested
    left join sessions session
      on session.id = requested.id
      and session.expires_at > ?
    left join account_api_tokens token on token.id = requested.id
    inner join users user on user.id = coalesce(session.user_id, token.user_id)
    inner join mailbox_members member
      on member.user_id = user.id
      and member.mailbox_id = ?
    where user.status = 'active'
  `).bind(idList(sessionIds), now, mailboxId).all<ActiveMailboxSessionRow>();
  return result.results.map((session) => ({
    id: session.id,
    tokenHash: session.token_hash,
    userId: session.user_id,
  }));
}

export async function listMailboxUsersByIds(
  db: D1Database,
  mailboxId: string,
  userIds: string[],
) {
  if (!userIds.length) return [];
  const result = await db.prepare(`
    with requested_users(id) as (
      select cast(value as text) from json_each(?)
    )
    select user.id, user.name
    from requested_users requested
    inner join mailbox_members member
      on member.user_id = requested.id
      and member.mailbox_id = ?
    inner join users user on user.id = member.user_id
  `).bind(idList(userIds), mailboxId).all<MailboxUserRow>();
  return result.results;
}
