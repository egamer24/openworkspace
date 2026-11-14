import { responseJson } from "@open-workspace/core/ui";
import type { TeamAddress } from "@open-workspace/core/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import { mailApi } from "../lib/mail-api";
import { mailboxesQuery } from "../mail/mail-queries";
import { SignatureEditor } from "../settings/signature-editor";
import type { SignatureBody } from "../settings/signature-editor";

/**
 * A shared inbox's signature, in its address editor under Administration →
 * Teams. It follows the delivery chosen in the form: switched to a mailing
 * list, it hides and is no longer saved with "Save address".
 */
export function TeamSignature({ address }: { address: TeamAddress }) {
  // Mailing lists copy mail to members; only shared inboxes send replies.
  return address.delivery === "inbox" ? (
    <TeamSignatureSection address={address} />
  ) : null;
}

function TeamSignatureSection({ address }: { address: TeamAddress }) {
  const client = useQueryClient();
  const mailboxes = useQuery(mailboxesQuery());
  const param = { mailboxId: address.mailboxId };

  // Read once per opening: the editor keeps its own state after loading it.
  const saved = useQuery({
    queryKey: ["team-signature", address.mailboxId],
    queryFn: async () =>
      responseJson(
        await mailApi.api.mail["team-signatures"][":mailboxId"].$get({ param })
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  // Images upload through a mailbox the administrator can send from.
  const sendable = mailboxes.data?.mailboxes.filter(
    (mailbox) => mailbox.canSend
  );

  const uploadMailbox =
    sendable?.find((mailbox) => mailbox.id === address.mailboxId) ??
    sendable?.[0];

  async function save(body: SignatureBody) {
    await responseJson(
      await mailApi.api.mail["team-signatures"][":mailboxId"].$put({
        param,
        json: body,
      })
    );
    await client.invalidateQueries({ queryKey: mailboxesQuery().queryKey });
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm leading-none font-medium">Signature</h3>
      <p className="text-muted-foreground text-xs">
        Added to messages sent from {address.address}. {"{name}"} becomes the
        sender's name. Without one, messages from here get no signature.
      </p>
      {saved.isPending || mailboxes.isPending ? (
        <div className="text-muted-foreground flex items-center gap-2 py-3 text-sm">
          <LoaderCircle className="size-4 animate-spin" /> Loading signature…
        </div>
      ) : saved.isError ? (
        <p className="text-destructive text-sm">
          The signature couldn't be loaded.
        </p>
      ) : (
        <SignatureEditor
          saved={saved.data.signature}
          uploadMailboxId={uploadMailbox?.id}
          label={`Signature for ${address.address}`}
          placeholder={`{name}, ${address.displayName}…`}
          section
          onSave={save}
        />
      )}
    </div>
  );
}
