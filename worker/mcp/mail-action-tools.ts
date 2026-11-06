import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AccountApiClient, apiPath } from "./account-client";
import { spamSenderLists } from "../mail/spam-filter";
import { runTool } from "./results";
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

export function registerMailActionTools(server: McpServer, api: AccountApiClient) {
  server.registerTool(
    "set_message_read",
    {
      title: "Mark message read or unread",
      description: "Set the current account's personal read state for one message.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        messageId: entityIdSchema,
        isRead: z.boolean(),
      }),
      annotations: write,
    },
    ({ mailboxId, messageId, isRead }) => runTool(() => api.json(apiPath(
      `/mail/messages/${encodeURIComponent(messageId)}/read`,
      { mailboxId },
    ), { method: "PATCH", json: { isRead } })),
  );

  server.registerTool(
    "set_conversations_read",
    {
      title: "Mark conversations read or unread",
      description: "Set the current account's personal read state for all messages in up to 500 conversations.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        conversationIds: conversationIdsSchema,
        isRead: z.boolean(),
      }),
      annotations: write,
    },
    ({ mailboxId, conversationIds, isRead }) => runTool(() => api.json(apiPath(
      "/mail/conversations/bulk",
      { mailboxId },
    ), {
      method: "PATCH",
      json: { type: "read", conversationIds, isRead },
    })),
  );

  server.registerTool(
    "move_conversations",
    {
      title: "Move conversations",
      description: "Move up to 500 conversations between Inbox, Archive, Spam, Trash, or a custom folder.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        conversationIds: conversationIdsSchema,
        sourceFolderId: entityIdSchema,
        mailboxState: mailboxStateSchema.optional(),
        folderId: entityIdSchema.nullable().optional(),
      }).refine(
        (value) => value.mailboxState !== undefined || value.folderId !== undefined,
        "Provide mailboxState, folderId, or both",
      ),
      annotations: write,
    },
    ({ mailboxId, conversationIds, sourceFolderId, mailboxState, folderId }) =>
      runTool(() => api.json(apiPath("/mail/conversations/bulk", { mailboxId }), {
        method: "PATCH",
        json: {
          type: "update",
          conversationIds,
          sourceFolderId,
          update: { mailboxState, folderId },
        },
      })),
  );

  server.registerTool(
    "delete_conversations_permanently",
    {
      title: "Permanently delete conversations",
      description: "Permanently delete up to 500 conversations. Every conversation must already be in Trash.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        conversationIds: conversationIdsSchema,
      }),
      annotations: {
        ...write,
        destructiveHint: true,
      },
    },
    ({ mailboxId, conversationIds }) => runTool(() => api.json(apiPath(
      "/mail/conversations/bulk",
      { mailboxId },
    ), {
      method: "PATCH",
      json: { type: "delete_permanently", conversationIds },
    })),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create custom folder",
      description: "Create a custom folder shared by everyone with access to the mailbox.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        name: z.string().trim().min(1).max(80),
      }),
      annotations: { ...write, idempotentHint: false },
    },
    ({ mailboxId, name }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders`,
      { method: "POST", json: { name } },
    )),
  );

  server.registerTool(
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
    ({ mailboxId, folderId, name }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/${encodeURIComponent(folderId)}`,
      { method: "PATCH", json: { name } },
    )),
  );

  server.registerTool(
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
    ({ mailboxId, folderId }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/${encodeURIComponent(folderId)}`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "reorder_folders",
    {
      title: "Reorder custom folders",
      description: "Set the complete order of custom folders in a mailbox.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        folderIds: z.array(entityIdSchema).max(100),
      }),
      annotations: write,
    },
    ({ mailboxId, folderIds }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/order`,
      { method: "PUT", json: { folderIds } },
    )),
  );

  server.registerTool(
    "get_mailbox_ai_settings",
    {
      title: "Get mailbox AI rules",
      description: "Read mailbox-level classification instructions and confidence threshold.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/ai`,
    )),
  );

  server.registerTool(
    "update_mailbox_ai_settings",
    {
      title: "Update mailbox AI rules",
      description: "Update mailbox-level classification instructions and confidence threshold.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        instructions: z.string().trim().max(4_000),
        confidenceThreshold: z.number().int().min(50).max(100),
      }),
      annotations: write,
    },
    ({ mailboxId, instructions, confidenceThreshold }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/ai`,
      { method: "PUT", json: { instructions, confidenceThreshold } },
    )),
  );

  server.registerTool(
    "get_spam_settings",
    {
      title: "Get spam filter settings",
      description: "Read the mailbox's local spam thresholds and sender allow and block lists.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/spam`,
    )),
  );

  server.registerTool(
    "get_spam_learning",
    {
      title: "Get spam learning stats",
      description: "Read how many messages the mailbox's learned spam filter was trained on (from Report spam / Not spam moves) and whether it is active yet.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/spam/learning`,
    )),
  );

  server.registerTool(
    "reset_spam_learning",
    {
      title: "Reset spam learning",
      description: "Forget everything the mailbox's learned spam filter was trained on. Lists and thresholds are kept. Requires send access.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, destructiveHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/spam/learning`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "add_spam_sender",
    {
      title: "Allow or block a sender",
      description: "Add an email address or domain to the mailbox's spam allow or block list. An entry on the other list is moved. Requires send access.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        entry: z.string().trim().min(1).max(254).describe("Email address or domain."),
        list: z.enum(spamSenderLists),
      }),
      annotations: write,
    },
    ({ mailboxId, entry, list }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/spam/senders/${encodeURIComponent(entry)}`,
      { method: "PUT", json: { list } },
    )),
  );

  server.registerTool(
    "remove_spam_sender",
    {
      title: "Remove a spam list entry",
      description: "Remove an email address or domain from the mailbox's spam allow or block list. Requires send access.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        entry: z.string().trim().min(1).max(254),
      }),
      annotations: write,
    },
    ({ mailboxId, entry }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/spam/senders/${encodeURIComponent(entry)}`,
      { method: "DELETE" },
    )),
  );
}
