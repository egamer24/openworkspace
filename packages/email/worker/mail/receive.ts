import {
  createDb,
  mailboxAddressPredicate,
  mailboxes,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";

import { mailboxStub } from "../mailbox";
import { receiveArchived } from "./archive";
import { inboundDeliveryId } from "./inbound-delivery";
import { deliverToList } from "./mailing-list";

/** Stores incoming mail for a workspace address, or fans a list's mail out. */
export async function receiveEmail(message: ForwardableEmailMessage, env: Env) {
  const receivedAt = Date.now();
  const recipient = normalizeMailboxAddress(message.to);

  const [mailbox] = await createDb(env.DB)
    .select({
      id: mailboxes.id,
      teamId: mailboxes.teamId,
      delivery: mailboxes.delivery,
      listPosting: mailboxes.listPosting,
    })
    .from(mailboxes)
    .where(mailboxAddressPredicate(recipient))
    .limit(1);

  if (!mailbox) {
    message.setReject(`Mailbox ${recipient} does not exist`);

    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();

  if (mailbox.delivery === "list" && mailbox.teamId) {
    await deliverToList({
      env,
      list: {
        id: mailbox.id,
        teamId: mailbox.teamId,
        listPosting: mailbox.listPosting,
      },
      message,
      raw,
      receivedAt,
    });

    return;
  }

  const deliveryId = await inboundDeliveryId({
    mailboxId: mailbox.id,
    envelopeFrom: message.from,
    envelopeTo: message.to,
    raw,
  });

  const objectKey = `mailboxes/${mailbox.id}/raw/${deliveryId}.eml`;

  await receiveArchived(
    env,
    { id: deliveryId, mailboxId: mailbox.id, sourceKey: objectKey, receivedAt },
    raw,
    async () => {
      await mailboxStub(env, mailbox.id).enqueueInbound({
        id: deliveryId,
        mailboxId: mailbox.id,
        rawObjectKey: objectKey,
        envelopeFrom: message.from,
        envelopeTo: message.to,
        receivedAt,
      });
      await env.MAIL_STORAGE.put(objectKey, raw, {
        httpMetadata: { contentType: "message/rfc822" },
      });
    }
  );
}
