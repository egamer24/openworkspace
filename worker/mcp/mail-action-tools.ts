import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AccountApiClient, apiPath } from "./account-client";
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
    "list_throwaway_addresses",
    {
      title: "List throwaway addresses",
      description: "List the current account's receive-only throwaway addresses with their labels and on/off state.",
      inputSchema: z.object({}),
      annotations: { ...write, readOnlyHint: true },
    },
    () => runTool(() => api.json("/mail/throwaway-addresses")),
  );

  server.registerTool(
    "create_throwaway_address",
    {
      title: "Create a throwaway address",
      description: "Generate a random receive-only address (like quiet-otter-4821@domain) that delivers into a mailbox the account can send from.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        label: z.string().trim().max(80).optional().describe("Private note, such as the site the address is for."),
      }),
      annotations: { ...write, idempotentHint: false },
    },
    ({ mailboxId, label }) => runTool(() => api.json("/mail/throwaway-addresses", {
      method: "POST",
      json: { mailboxId, label: label ?? null },
    })),
  );

  server.registerTool(
    "set_throwaway_address_enabled",
    {
      title: "Turn a throwaway address on or off",
      description: "While off, mail sent to the throwaway address is rejected.",
      inputSchema: z.object({ addressId: entityIdSchema, enabled: z.boolean() }),
      annotations: write,
    },
    ({ addressId, enabled }) => runTool(() => api.json(
      `/mail/throwaway-addresses/${encodeURIComponent(addressId)}`,
      { method: "PATCH", json: { enabled } },
    )),
  );
}
