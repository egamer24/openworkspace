import { MailboxRealtimeConnections } from "./mailbox-realtime";
import { UnreadDocumentIndicator } from "./unread-document-indicator";

/** Mounted while someone is signed in: realtime updates and the unread count in the tab. */
export function MailBackground() {
  return (
    <>
      <MailboxRealtimeConnections />
      <UnreadDocumentIndicator />
    </>
  );
}
