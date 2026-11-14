import type { TeamAddress, UserAddress } from "@open-workspace/core/ui";
import { useQuery } from "@tanstack/react-query";

import { mailboxesQuery } from "../mail/mail-queries";
import { MailboxAutoReply } from "../settings/auto-reply-editor";

/**
 * An address's auto-reply, in its editor under Administration → Teams or
 * People, saved with "Save address". Only an address with its own mailbox
 * has one: an alias is answered by its target's, and a mailing list's mail
 * goes straight to its members. It follows the delivery chosen in the form.
 */
export function AddressAutoReply({
  address,
}: {
  address: TeamAddress | UserAddress;
}) {
  return address.delivery === "inbox" ? (
    <AddressAutoReplySection address={address} />
  ) : null;
}

function AddressAutoReplySection({
  address,
}: {
  address: TeamAddress | UserAddress;
}) {
  const mailboxes = useQuery(mailboxesQuery());

  // Images upload through a mailbox the administrator can send from.
  const sendable = mailboxes.data?.mailboxes.filter(
    (mailbox) => mailbox.canSend
  );

  const uploadMailbox =
    sendable?.find((mailbox) => mailbox.id === address.mailboxId) ??
    sendable?.[0];

  return (
    <div className="space-y-2">
      <h3 className="text-sm leading-none font-medium">Auto-reply</h3>
      <MailboxAutoReply
        mailbox={{ id: address.mailboxId, address: address.address }}
        uploadMailboxId={uploadMailbox?.id}
        section
      />
    </div>
  );
}
