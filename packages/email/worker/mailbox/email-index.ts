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
