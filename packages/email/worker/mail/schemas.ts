import { emailSchema } from "@open-workspace/core/module";
import { z } from "zod";

import { MOVABLE_SYSTEM_FOLDER_IDS } from "../../shared/folder-order";
import {
  mailboxStates,
  MAX_BULK_CONVERSATION_COUNT,
  MAX_COMPOSER_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_CUSTOM_FOLDER_COUNT,
  MAX_MAIL_RECIPIENTS,
  replyActionModes,
} from "../../shared/mail";
import {
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
} from "../../shared/mail-translation";
import { dedupeRecipientFields, recipientCount } from "./recipients";

export const folderSchema = z.string().trim().min(1).max(80);

const customFolderNameSchema = z.string().trim().min(1).max(80);

export const createFolderSchema = z.object({
  name: customFolderNameSchema,
});

export const renameFolderSchema = createFolderSchema;

export const mailboxAiConfigurationSchema = z.object({
  instructions: z.string().trim().max(4000),
  confidenceThreshold: z.number().int().min(50).max(100),
});

export const retentionFolderSchema = z.enum(["trash", "spam"]);

/** Every folder but Inbox, in order: the movable system folders and the custom ones. */
export const reorderFoldersSchema = z.object({
  folderIds: z
    .array(folderSchema)
    .max(MAX_CUSTOM_FOLDER_COUNT + MOVABLE_SYSTEM_FOLDER_IDS.length)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Folder order contains duplicate ids",
    }),
});

export const mailboxQuerySchema = z.object({
  mailboxId: z.string().min(1),
});

export const recipientSuggestionQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(12).default(8),
});

export const remoteProxyQuerySchema = mailboxQuerySchema.extend({
  /** From the conversation response (`remoteTokens`, for this `url`); see remote-token.ts. */
  token: z.string().min(1).max(512),
  url: z.string().trim().min(1).max(4096),
});

export const conversationListQuerySchema = mailboxQuerySchema.extend({
  folder: folderSchema.default("inbox"),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().trim().min(1).max(512).optional(),
  search: z.string().trim().max(200).optional(),
  unreadOnly: z.literal("true").optional(),
});

export const conversationMessagesQuerySchema = mailboxQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(25).default(25),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export const mailboxStateSchema = z.enum(mailboxStates);

export const messageReadSchema = z.object({
  isRead: z.boolean(),
});

export const messageTranslationSchema = z.object({
  language: z
    .string()
    .trim()
    .min(2)
    .max(35)
    .regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/u),
  segments: z
    .array(z.string().trim().min(1).max(MAX_TRANSLATION_CHARACTERS))
    .min(1)
    .max(MAX_TRANSLATION_SEGMENTS),
});

export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(MAX_COMPOSER_ATTACHMENT_BYTES),
});

export const uploadIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^upl_[a-f0-9]{32}$/u, "Attachment upload id is invalid");

export const outboundAttachmentSchema = z
  .object({
    uploadId: uploadIdSchema,
    disposition: z.enum(["attachment", "inline"]).default("attachment"),
    contentId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+$/u, "Content ID is invalid")
      .optional(),
  })
  .superRefine((attachment, context) => {
    if (attachment.disposition === "inline" && !attachment.contentId) {
      context.addIssue({
        code: "custom",
        path: ["contentId"],
        message: "Inline attachments require a content ID",
      });
    }

    if (attachment.disposition === "attachment" && attachment.contentId) {
      context.addIssue({
        code: "custom",
        path: ["contentId"],
        message: "Regular attachments cannot have a content ID",
      });
    }
  });

export const outboundMessageContentFields = {
  bodyText: z.string().max(500_000).default(""),
  bodyHtml: z.string().max(1_000_000).optional(),
  attachments: z
    .array(outboundAttachmentSchema)
    .max(MAX_COMPOSER_ATTACHMENT_COUNT)
    .default([])
    .refine(
      (attachments) =>
        new Set(attachments.map((file) => file.uploadId)).size ===
        attachments.length,
      { message: "Duplicate attachment uploads are not allowed" }
    )
    .refine(
      (attachments) => {
        const contentIds = attachments.flatMap((file) =>
          file.contentId ? [file.contentId.toLocaleLowerCase("en-US")] : []
        );

        return new Set(contentIds).size === contentIds.length;
      },
      { message: "Duplicate attachment content IDs are not allowed" }
    ),
};

const hasMessageBody = (value: { bodyText: string; bodyHtml?: string }) =>
  Boolean(value.bodyText.trim() || value.bodyHtml?.trim());

const missingMessageBody = {
  path: ["bodyText"],
  message: "Add text to the message before sending",
};

export const outboundContentFields = {
  mailboxId: z.string().min(1),
  ...outboundMessageContentFields,
};

const outboundRequestFields = {
  requestId: z.uuid(),
  ...outboundContentFields,
};

export const outboundRecipientFields = {
  to: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
};

export const composeSchema = z
  .object({
    ...outboundRequestFields,
    ...outboundRecipientFields,
    replyTo: emailSchema.optional(),
    subject: z.string().trim().max(998).default(""),
  })
  .transform((value) => ({
    ...value,
    ...dedupeRecipientFields(value),
  }))
  .refine(hasMessageBody, missingMessageBody)
  .refine((value) => recipientCount(value) > 0, {
    message: "Add at least one recipient in To, Cc, or Bcc",
  })
  .refine((value) => recipientCount(value) <= MAX_MAIL_RECIPIENTS, {
    message: `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc`,
  });

export const replySchema = z
  .object({
    ...outboundRequestFields,
    mode: z.enum(replyActionModes),
    cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).optional(),
    bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  })
  .refine(hasMessageBody, missingMessageBody);

export const forwardSchema = z
  .object({
    ...outboundRequestFields,
    ...outboundRecipientFields,
    replyTo: emailSchema.optional(),
  })
  .transform((value) => ({
    ...value,
    ...dedupeRecipientFields(value),
  }))
  .refine((value) => recipientCount(value) > 0, {
    message: "Add at least one recipient in To, Cc, or Bcc",
  })
  .refine((value) => recipientCount(value) <= MAX_MAIL_RECIPIENTS, {
    message: `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc`,
  });

export const attachmentPreflightSchema = z.discriminatedUnion("kind", [
  z.object({
    ...outboundContentFields,
    kind: z.literal("compose"),
    subject: z.string().trim().max(998).default(""),
  }),
  z.object({
    ...outboundContentFields,
    kind: z.literal("forward"),
    sourceEmailId: z.string().trim().min(1).max(255),
  }),
  z.object({
    ...outboundContentFields,
    kind: z.literal("reply"),
    sourceEmailId: z.string().trim().min(1).max(255),
    mode: z.enum(replyActionModes),
    cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).optional(),
    bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  }),
]);

export const updateConversationSchema = z
  .object({
    mailboxState: mailboxStateSchema.optional(),
    folderId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (value) => value.mailboxState !== undefined || value.folderId !== undefined,
    {
      message: "No changes supplied",
    }
  )
  .refine(
    (value) =>
      value.folderId === undefined ||
      value.folderId === null ||
      value.mailboxState === undefined ||
      value.mailboxState === "active",
    {
      path: ["mailboxState"],
      message: "Moving to a custom folder requires the active mailbox state",
    }
  );

const bulkConversationIdsSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(MAX_BULK_CONVERSATION_COUNT)
  .transform((ids) => [...new Set(ids)]);

export const bulkConversationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("read"),
    conversationIds: bulkConversationIdsSchema,
    isRead: z.boolean(),
  }),
  z.object({
    type: z.literal("update"),
    conversationIds: bulkConversationIdsSchema,
    sourceFolderId: z.string().trim().min(1).max(255),
    update: updateConversationSchema,
  }),
  z.object({
    type: z.literal("delete_permanently"),
    conversationIds: bulkConversationIdsSchema,
  }),
]);

export const blockSenderSchema = z.object({
  pattern: z.string().trim().min(3).max(320),
  moveExisting: z.boolean().default(false),
});

export const blockPatternQuerySchema = z.object({
  pattern: z.string().trim().min(3).max(320),
});

export const trustSenderSchema = z.object({
  address: emailSchema,
  trusted: z.boolean(),
});

export const unsubscribeSchema = z.object({
  /** "link" records that the person opened the sender's page themselves. */
  method: z.enum(["auto", "link"]).default("auto"),
});

export const bulkReportSchema = z.object({
  conversationIds: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
});
