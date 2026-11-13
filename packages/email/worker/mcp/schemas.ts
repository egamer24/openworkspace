import { entityIdSchema } from "@open-workspace/core/module";
import { z } from "zod";

import {
  MAX_BULK_CONVERSATION_COUNT,
  mailboxStates,
  replyActionModes,
} from "../../shared/mail";
import {
  outboundMessageContentFields,
  outboundRecipientFields,
} from "../mail/schemas";

export { entityIdSchema };

export const mailboxIdSchema = z.string().trim().min(1).max(255);

export const mailboxInputSchema = z.object({ mailboxId: mailboxIdSchema });

export const conversationIdsSchema = z
  .array(entityIdSchema)
  .min(1)
  .max(MAX_BULK_CONVERSATION_COUNT)
  .transform((ids) => [...new Set(ids)]);

export const messageContentFields = {
  ...outboundMessageContentFields,
  requestId: z
    .uuid()
    .optional()
    .describe(
      "Stable idempotency key. Reuse it when retrying the same send operation."
    ),
};

export const recipientFields = outboundRecipientFields;

export const mailboxStateSchema = z.enum(mailboxStates);
export const replyModeSchema = z.enum(replyActionModes);

export function requestId(value: string | undefined) {
  return value ?? crypto.randomUUID();
}
