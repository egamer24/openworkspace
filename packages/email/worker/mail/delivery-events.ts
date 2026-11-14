import {
  createDb,
  mailboxes,
  mailboxAddressPredicate,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";
import { z } from "zod";

import { mailboxStub } from "../mailbox";
import { deliveryStatuses } from "../mailbox/model";
import type { RecipientDeliveryStatus } from "../mailbox/model";

const deliveryEventSchema = z
  .object({
    type: z.string().startsWith("cf.email.sending.message."),
    source: z
      .object({
        type: z.literal("email.sending"),
      })
      .passthrough(),
    payload: z
      .object({
        eventId: z.string().min(1),
        messageId: z.string().min(1),
        sender: z.string().min(1),
        recipient: z.string().min(1),
        delivery: z
          .object({
            status: z.enum(deliveryStatuses),
            smtpStatusCode: z.string().optional(),
          })
          .passthrough(),
        bounce: z.object({ reason: z.string().optional() }).optional(),
        failure: z.object({ reason: z.string().optional() }).optional(),
        rejection: z
          .object({
            reason: z.string().optional(),
            detail: z.string().optional(),
          })
          .optional(),
        complaint: z.object({ type: z.string().optional() }).optional(),
      })
      .passthrough(),
    metadata: z
      .object({
        eventTimestamp: z.string().datetime(),
      })
      .passthrough(),
  })
  .passthrough();

type DeliveryEvent = z.infer<typeof deliveryEventSchema>;

function deliveryDetail(event: DeliveryEvent) {
  return (
    event.payload.bounce?.reason ??
    event.payload.failure?.reason ??
    event.payload.rejection?.detail ??
    event.payload.rejection?.reason ??
    event.payload.complaint?.type ??
    null
  );
}

function recipientStatus(event: DeliveryEvent): RecipientDeliveryStatus {
  return {
    recipient: normalizeMailboxAddress(event.payload.recipient),
    status: event.payload.delivery.status,
    eventId: event.payload.eventId,
    eventAt: new Date(event.metadata.eventTimestamp).getTime(),
    smtpCode: event.payload.delivery.smtpStatusCode ?? null,
    detail: deliveryDetail(event),
  };
}

async function processDeliveryEvent(env: Env, event: DeliveryEvent) {
  const sender = normalizeMailboxAddress(event.payload.sender);

  const [mailbox] = await createDb(env.DB)
    .select({ id: mailboxes.id, aliasOf: mailboxes.aliasOf })
    .from(mailboxes)
    .where(mailboxAddressPredicate(sender))
    .limit(1);

  if (!mailbox) return "ignored" as const;

  // A reply sent from an alias is kept in the alias's mailbox.
  return mailboxStub(env, mailbox.aliasOf ?? mailbox.id).recordDeliveryStatus(
    event.payload.messageId,
    recipientStatus(event)
  );
}

export async function consumeDeliveryEvents(
  batch: MessageBatch<unknown>,
  env: Env
) {
  await Promise.all(
    batch.messages.map(async (message) => {
      const parsed = deliveryEventSchema.safeParse(message.body);

      if (!parsed.success) {
        console.error("Ignoring invalid Email Service event", parsed.error);
        message.ack();

        return;
      }

      try {
        const result = await processDeliveryEvent(env, parsed.data);

        if (result === "not_found") {
          // Delivery events can beat the write that stores EmailSendResult.messageId.
          message.retry({ delaySeconds: 10 });

          return;
        }

        message.ack();
      } catch (error) {
        console.error("Could not persist Email Service event", error);
        message.retry({ delaySeconds: 10 });
      }
    })
  );
}
