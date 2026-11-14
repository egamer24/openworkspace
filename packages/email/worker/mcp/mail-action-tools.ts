import type {
  ScopedToolRegistrar,
  AccountApiClient,
} from "@open-workspace/core/module";
import { apiPath, runTool } from "@open-workspace/core/module";
import { z } from "zod";

import { autoReplyAudiences } from "../../shared/mail";
import { MAIL_ORGANIZE_SCOPE, MAIL_READ_SCOPE } from "../../shared/permissions";
import { retentionFolderSchema } from "../mail/schemas";
import {
  conversationIdsSchema,
  entityIdSchema,
  mailboxIdSchema,
  mailboxStateSchema,
} from "./schemas";

const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerMailActionTools(
  tool: ScopedToolRegistrar,
  api: AccountApiClient
) {
  tool(MAIL_ORGANIZE_SCOPE)(
    "set_message_read",
    {
      title: "Mark message read or unread",
      description:
        "Set the current account's personal read state for one message.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        messageId: entityIdSchema,
        isRead: z.boolean(),
      }),
      annotations: write,
    },
    ({ mailboxId, messageId, isRead }) =>
      runTool(() =>
        api.json(
          apiPath(`/mail/messages/${encodeURIComponent(messageId)}/read`, {
            mailboxId,
          }),
          { method: "PATCH", json: { isRead } }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "set_conversations_read",
    {
      title: "Mark conversations read or unread",
      description:
        "Set the current account's personal read state for all messages in up to 500 conversations.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        conversationIds: conversationIdsSchema,
        isRead: z.boolean(),
      }),
      annotations: write,
    },
    ({ mailboxId, conversationIds, isRead }) =>
      runTool(() =>
        api.json(apiPath("/mail/conversations/bulk", { mailboxId }), {
          method: "PATCH",
          json: { type: "read", conversationIds, isRead },
        })
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "move_conversations",
    {
      title: "Move conversations",
      description:
        "Move up to 500 conversations between Inbox, Archive, Trash, or a custom folder, or out of Spam. To put mail in Spam use report_conversations (or report_message), which also records the report for the spam classifier.",
      inputSchema: z
        .object({
          mailboxId: mailboxIdSchema,
          conversationIds: conversationIdsSchema,
          sourceFolderId: entityIdSchema,
          // Spam goes through reporting so the classifier learns from it.
          mailboxState: mailboxStateSchema.exclude(["spam"]).optional(),
          folderId: entityIdSchema.nullable().optional(),
        })
        .refine(
          (value) =>
            value.mailboxState !== undefined || value.folderId !== undefined,
          "Provide mailboxState, folderId, or both"
        ),
      annotations: write,
    },
    ({ mailboxId, conversationIds, sourceFolderId, mailboxState, folderId }) =>
      runTool(() =>
        api.json(apiPath("/mail/conversations/bulk", { mailboxId }), {
          method: "PATCH",
          json: {
            type: "update",
            conversationIds,
            sourceFolderId,
            update: { mailboxState, folderId },
          },
        })
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "delete_conversations_permanently",
    {
      title: "Permanently delete conversations",
      description:
        "Permanently delete up to 500 conversations. Every conversation must already be in Trash.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        conversationIds: conversationIdsSchema,
      }),
      annotations: {
        ...write,
        destructiveHint: true,
      },
    },
    ({ mailboxId, conversationIds }) =>
      runTool(() =>
        api.json(apiPath("/mail/conversations/bulk", { mailboxId }), {
          method: "PATCH",
          json: { type: "delete_permanently", conversationIds },
        })
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "empty_folder",
    {
      title: "Empty Trash or Spam",
      description:
        "Permanently delete up to 100 of the oldest conversations in Trash or Spam. Returns { deleted, remaining }; call again while remaining is above 0. Requires send access.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        folder: retentionFolderSchema,
      }),
      annotations: { ...write, destructiveHint: true, idempotentHint: false },
    },
    ({ mailboxId, folder }) =>
      runTool(() =>
        api.json(
          `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/${folder}/empty`,
          { method: "POST" }
        )
      )
  );

  tool(MAIL_READ_SCOPE)(
    "get_auto_reply",
    {
      title: "Get auto-reply",
      description:
        "Read a mailbox's automatic reply: its schedule, its status now (off, scheduled, active, ended), and its two messages, for people inside the workspace and for everyone else. Your own mailboxes; anyone's with Manage people, and team inboxes with Manage teams.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) =>
      runTool(() =>
        api.json(
          apiPath(`/mail/mailboxes/${encodeURIComponent(mailboxId)}/auto-reply`)
        )
      )
  );

  const autoReplyMessage = z.object({
    enabled: z.boolean(),
    subject: z
      .string()
      .max(998)
      .nullable()
      .optional()
      .describe('Defaults to "Auto: <original subject>".'),
    html: z.string().max(20_000).describe("The reply as HTML."),
    text: z.string().max(10_000).describe("The same reply as plain text."),
  });

  tool(MAIL_ORGANIZE_SCOPE)(
    "set_auto_reply",
    {
      title: "Set auto-reply",
      description:
        "Turn a mailbox's automatic reply on or off, with an optional schedule and one message for people inside the workspace and one for everyone else (or only people the mailbox has written to). Replaces both messages and drops their images. Mailing lists, bounces, other auto-responders, Spam and Trash are never answered, and each sender gets at most one reply per interval.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        enabled: z.boolean(),
        startsAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .optional()
          .describe("When replies start; omit or null to start now."),
        endsAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .optional()
          .describe("When replies stop; omit or null for no end."),
        replyIntervalDays: z.number().int().min(1).max(30).optional(),
        inside: autoReplyMessage,
        outside: autoReplyMessage.extend({
          audience: z.enum(autoReplyAudiences).optional(),
        }),
      }),
      annotations: write,
    },
    ({ mailboxId, ...settings }) =>
      runTool(() =>
        api.json(
          apiPath(
            `/mail/mailboxes/${encodeURIComponent(mailboxId)}/auto-reply`
          ),
          {
            method: "PUT",
            json: settings,
          }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "create_folder",
    {
      title: "Create custom folder",
      description:
        "Create a custom folder shared by everyone with access to the mailbox.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        name: z.string().trim().min(1).max(80),
      }),
      annotations: { ...write, idempotentHint: false },
    },
    ({ mailboxId, name }) =>
      runTool(() =>
        api.json(`/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders`, {
          method: "POST",
          json: { name },
        })
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "rename_folder",
    {
      title: "Rename custom folder",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        folderId: entityIdSchema,
        name: z.string().trim().min(1).max(80),
      }),
      annotations: write,
    },
    ({ mailboxId, folderId, name }) =>
      runTool(() =>
        api.json(
          `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/${encodeURIComponent(folderId)}`,
          { method: "PATCH", json: { name } }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "delete_folder",
    {
      title: "Delete custom folder",
      description: "Delete a custom folder. Conversations remain in Inbox.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        folderId: entityIdSchema,
      }),
      annotations: { ...write, destructiveHint: true },
    },
    ({ mailboxId, folderId }) =>
      runTool(() =>
        api.json(
          `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/${encodeURIComponent(folderId)}`,
          { method: "DELETE" }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "reorder_folders",
    {
      title: "Reorder folders",
      description:
        "Set the complete order of a mailbox's folders: every custom folder and the system folders sent, archive, spam and trash, each once, in display order. Inbox always stays first and is not listed. System folders can be placed among custom ones.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        folderIds: z.array(entityIdSchema).max(104),
      }),
      annotations: write,
    },
    ({ mailboxId, folderIds }) =>
      runTool(() =>
        api.json(
          `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/order`,
          { method: "PUT", json: { folderIds } }
        )
      )
  );

  tool(MAIL_READ_SCOPE)(
    "get_mailbox_ai_settings",
    {
      title: "Get mailbox AI rules",
      description:
        "Read mailbox-level classification instructions and confidence threshold.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) =>
      runTool(() =>
        api.json(`/mail/mailboxes/${encodeURIComponent(mailboxId)}/ai`)
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "update_mailbox_ai_settings",
    {
      title: "Update mailbox AI rules",
      description:
        "Update mailbox-level classification instructions and confidence threshold.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        instructions: z.string().trim().max(4000),
        confidenceThreshold: z.number().int().min(50).max(100),
      }),
      annotations: write,
    },
    ({ mailboxId, instructions, confidenceThreshold }) =>
      runTool(() =>
        api.json(`/mail/mailboxes/${encodeURIComponent(mailboxId)}/ai`, {
          method: "PUT",
          json: { instructions, confidenceThreshold },
        })
      )
  );
}
