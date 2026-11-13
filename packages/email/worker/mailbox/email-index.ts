/**
 * Keeps the conversation projection and the search index in step with one
 * stored message. Call it inside the transaction that inserted the row, right
 * after the insert: it reads the row as stored (column defaults included), so
 * the conversation and the `email_search` row commit or roll back with it.
 */
export function indexInsertedEmail(sql: SqlStorage, emailId: string) {
  // A new message moves its conversation's latest message and timeline forward,
  // brings it back from Archive or Trash (and from Spam when it is a reply sent
  // from here), and marks which directions it has seen.
  sql.exec(
    `insert into conversations (
       id, latest_email_id, timeline_at, mailbox_state, folder_id, has_incoming, has_outgoing
     )
     select conversation_id, id, timeline_at, 'active', null,
       direction = 'incoming', direction = 'outgoing'
     from emails
     where id = ?
     on conflict (id) do update set
       latest_email_id = case
         when excluded.timeline_at > conversations.timeline_at
           or (
             excluded.timeline_at = conversations.timeline_at
             and excluded.latest_email_id > conversations.latest_email_id
           )
         then excluded.latest_email_id
         else conversations.latest_email_id
       end,
       timeline_at = max(conversations.timeline_at, excluded.timeline_at),
       mailbox_state = case
         when conversations.mailbox_state in ('archive', 'trash')
           or (conversations.mailbox_state = 'spam' and excluded.has_outgoing)
         then 'active'
         else conversations.mailbox_state
       end,
       has_incoming = conversations.has_incoming or excluded.has_incoming,
       has_outgoing = conversations.has_outgoing or excluded.has_outgoing`,
    emailId
  );
  sql.exec(
    `insert into email_search (email_id, conversation_id, subject, addresses, body)
     select id, conversation_id, subject,
       coalesce(from_json, '') || ' '
         || coalesce(reply_to_json, '') || ' '
         || coalesce(to_json, '') || ' '
         || coalesce(cc_json, '') || ' '
         || coalesce(bcc_json, ''),
       coalesce(body_text, '') || ' ' || coalesce(preview, '')
     from emails
     where id = ?`,
    emailId
  );
}

/**
 * Moves every message of conversation `fromId` into `intoId`, inside the
 * caller's transaction: the messages, their search rows, and `intoId`'s
 * latest message, timeline and directions, which are recomputed from its
 * messages. `intoId` keeps its place (state and folder); `fromId` is removed.
 * Read states belong to messages and move with them.
 */
export function mergeConversation(
  sql: SqlStorage,
  fromId: string,
  intoId: string
) {
  sql.exec(
    "update emails set conversation_id = ? where conversation_id = ?",
    intoId,
    fromId
  );
  sql.exec(
    "update email_search set conversation_id = ? where conversation_id = ?",
    intoId,
    fromId
  );
  sql.exec(
    `update conversations set
       latest_email_id = (
         select message.id from emails message
         where message.conversation_id = conversations.id
         order by message.timeline_at desc, message.id desc limit 1
       ),
       timeline_at = (
         select max(message.timeline_at) from emails message
         where message.conversation_id = conversations.id
       ),
       has_incoming = exists (
         select 1 from emails message
         where message.conversation_id = conversations.id
           and message.direction = 'incoming'
       ),
       has_outgoing = exists (
         select 1 from emails message
         where message.conversation_id = conversations.id
           and message.direction = 'outgoing'
       )
     where id = ?`,
    intoId
  );
  sql.exec("delete from conversations where id = ?", fromId);
}
