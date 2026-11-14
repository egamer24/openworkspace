import type {
  ScopedToolRegistrar,
  AccountApiClient,
} from "@open-workspace/core/module";
import { apiPath, runTool } from "@open-workspace/core/module";
import { z } from "zod";

import { MAIL_ORGANIZE_SCOPE, MAIL_READ_SCOPE } from "../../shared/permissions";
import { ruleInputSchema, ruleTestSchema } from "../mail/rules";
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

  const rulesPath = (mailboxId: string) =>
    `/mail/mailboxes/${encodeURIComponent(mailboxId)}/rules`;

  tool(MAIL_READ_SCOPE)(
    "list_rules",
    {
      title: "List mailbox rules",
      description: "List a mailbox's rules in the order they run on new mail.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(rulesPath(mailboxId)))
  );

  tool(MAIL_READ_SCOPE)(
    "test_rule",
    {
      title: "Test a mailbox rule",
      description:
        "Count how many of the latest 500 incoming messages the conditions match, without changing anything.",
      inputSchema: ruleTestSchema.extend({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId, ...rule }) =>
      runTool(() =>
        api.json(`${rulesPath(mailboxId)}/test`, { method: "POST", json: rule })
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "create_rule",
    {
      title: "Create a mailbox rule",
      description:
        "Add a rule that runs on new mail. Conditions: from (contains/equals/domain), recipient, subject, listId, hasAttachment. Actions: moveToFolder, archive, trash, spam, notSpam, markRead. recipient matches To, Cc and the address the mail was delivered to. A matching moveToFolder or archive replaces AI sorting's folder; blocked senders always go to Spam.",
      inputSchema: ruleInputSchema.extend({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, idempotentHint: false },
    },
    ({ mailboxId, ...rule }) =>
      runTool(() =>
        api.json(rulesPath(mailboxId), { method: "POST", json: rule })
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "delete_rule",
    {
      title: "Delete a mailbox rule",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        ruleId: entityIdSchema,
      }),
      annotations: { ...write, destructiveHint: true },
    },
    ({ mailboxId, ruleId }) =>
      runTool(() =>
        api.json(`${rulesPath(mailboxId)}/${encodeURIComponent(ruleId)}`, {
          method: "DELETE",
        })
      )
  );
}
