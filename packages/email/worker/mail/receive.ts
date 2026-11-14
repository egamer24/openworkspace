import { normalizeMailboxAddress } from "@open-workspace/core/module";

import { mailboxStub } from "../mailbox";
import { inboundDeliveryId } from "./inbound-delivery";
import { deliverToList } from "./mailing-list";
import { forwardInbound, resolveInboundRoute } from "./routing";

/**
 * Stores incoming mail for a workspace address, fans a list's mail out, or
 * forwards it. An alias, a plus address or the catch-all delivers into its
 * mailbox with the envelope recipient kept as the address it was sent to.
 */
export async function receiveEmail(message: ForwardableEmailMessage, env: Env) {
  const receivedAt = Date.now();
  const recipient = normalizeMailboxAddress(message.to);
  const route = await resolveInboundRoute(env.DB, recipient);

  if (!route) {
    message.setReject(`Mailbox ${recipient} does not exist`);

    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();

  if (route.kind === "forward") {
    await forwardInbound({ env, message, raw, forwardTo: route.forwardTo });

    return;
  }

  const { mailbox } = route;

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
