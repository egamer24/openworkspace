import type {
  ScopedToolRegistrar,
  AccountApiClient,
} from "@open-workspace/core/module";
import { emailSchema, apiPath, runTool } from "@open-workspace/core/module";
import { z } from "zod";

import {
  MAX_COMPOSER_ATTACHMENT_BYTES,
  MAX_MAIL_RECIPIENTS,
} from "../../shared/mail";
import { MAIL_SEND_SCOPE } from "../../shared/permissions";
import { dedupeRecipientFields, recipientCount } from "../mail/recipients";
import {
  entityIdSchema,
  mailboxIdSchema,
  messageContentFields,
  recipientFields,
  replyModeSchema,
  requestId,
} from "./schemas";

const sendAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const composeInputSchema = z
  .object({
    mailboxId: mailboxIdSchema,
    ...recipientFields,
    replyTo: emailSchema.optional(),
    subject: z.string().trim().max(998).default(""),
    ...messageContentFields,
  })
  .refine(
    (value) => recipientCount(dedupeRecipientFields(value)) > 0,
    "Add at least one recipient"
  )
  .refine(
    (value) =>
      recipientCount(dedupeRecipientFields(value)) <= MAX_MAIL_RECIPIENTS,
    `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients`
  );

const forwardInputSchema = z
  .object({
    mailboxId: mailboxIdSchema,
    sourceMessageId: entityIdSchema,
    ...recipientFields,
    replyTo: emailSchema.optional(),
    ...messageContentFields,
  })
  .refine(
    (value) => recipientCount(dedupeRecipientFields(value)) > 0,
    "Add at least one recipient"
  )
  .refine(
    (value) =>
      recipientCount(dedupeRecipientFields(value)) <= MAX_MAIL_RECIPIENTS,
    `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients`
  );

export function registerMailComposeTools(
  tool: ScopedToolRegistrar,
  api: AccountApiClient
) {
  tool(MAIL_SEND_SCOPE)(
    "create_attachment_upload",
    {
      title: "Create attachment upload",
      description:
        "Create a 15-minute presigned R2 PUT URL. Upload exactly the declared number of bytes to upload.uploadUrl using upload.headers, then call complete_attachment_upload with upload.id.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        filename: z.string().trim().min(1).max(255),
        contentType: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .default("application/octet-stream"),
        size: z.number().int().positive().max(MAX_COMPOSER_ATTACHMENT_BYTES),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ mailboxId, filename, contentType, size }) =>
      runTool(() =>
        api.json(apiPath("/mail/uploads", { mailboxId }), {
          method: "POST",
          json: { filename, contentType, size },
        })
      )
  );

  tool(MAIL_SEND_SCOPE)(
    "complete_attachment_upload",
    {
      title: "Complete attachment upload",
      description:
        "Verify and seal a file uploaded with create_attachment_upload. Use the returned upload id in send_email, reply_to_email, or forward_email attachments.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        uploadId: entityIdSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ mailboxId, uploadId }) =>
      runTool(() =>
        api.json(
          apiPath(`/mail/uploads/${encodeURIComponent(uploadId)}/complete`, {
            mailboxId,
          }),
          { method: "POST" }
        )
      )
  );

  tool(MAIL_SEND_SCOPE)(
    "discard_attachment_upload",
    {
      title: "Discard attachment upload",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        uploadId: entityIdSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ mailboxId, uploadId }) =>
      runTool(() =>
        api.json(
          apiPath(`/mail/uploads/${encodeURIComponent(uploadId)}`, {
            mailboxId,
          }),
          { method: "DELETE" }
        )
      )
  );

  tool(MAIL_SEND_SCOPE)(
    "send_email",
    {
      title: "Send email",
      description:
        "Compose and send a new email from a mailbox where the current account has send access.",
      inputSchema: composeInputSchema,
      annotations: sendAnnotations,
    },
    (input) =>
      runTool(() =>
        api.json("/mail/messages", {
          method: "POST",
          json: { ...input, requestId: requestId(input.requestId) },
        })
      )
  );

  tool(MAIL_SEND_SCOPE)(
    "reply_to_email",
    {
      title: "Reply to email",
      description:
        "Reply, reply all, continue a draft-like outgoing thread, or reply to a mailing list.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        sourceMessageId: entityIdSchema,
        mode: replyModeSchema.default("reply"),
        cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).optional(),
        bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
        ...messageContentFields,
      }),
      annotations: sendAnnotations,
    },
    ({ sourceMessageId, ...input }) =>
      runTool(() =>
        api.json(
          `/mail/messages/${encodeURIComponent(sourceMessageId)}/replies`,
          {
            method: "POST",
            json: { ...input, requestId: requestId(input.requestId) },
          }
        )
      )
  );

  tool(MAIL_SEND_SCOPE)(
    "forward_email",
    {
      title: "Forward email",
      description:
        "Forward a message, including its original attachments, to new recipients.",
      inputSchema: forwardInputSchema,
      annotations: sendAnnotations,
    },
    ({ sourceMessageId, ...input }) =>
      runTool(() =>
        api.json(
          `/mail/messages/${encodeURIComponent(sourceMessageId)}/forward`,
          {
            method: "POST",
            json: { ...input, requestId: requestId(input.requestId) },
          }
        )
      )
  );

  tool(MAIL_SEND_SCOPE)(
    "send_email_again",
    {
      title: "Retry failed email",
      description:
        "Retry an outgoing message whose delivery is failed or unconfirmed.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        messageId: entityIdSchema,
      }),
      annotations: sendAnnotations,
    },
    ({ mailboxId, messageId }) =>
      runTool(() =>
        api.json(
          apiPath(
            `/mail/messages/${encodeURIComponent(messageId)}/send-again`,
            { mailboxId }
          ),
          { method: "POST" }
        )
      )
  );
}
