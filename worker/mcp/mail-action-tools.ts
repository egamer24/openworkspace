import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AccountApiClient, apiPath } from "./account-client";
import { spamSenderLists } from "../mail/spam-filter";
import { runTool } from "./results";
import { ruleInputSchema } from "../mail/rules";
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
    "get_auto_reply",
    {
      title: "Get auto-reply",
      description: "Read a mailbox's out-of-office auto-reply settings, its current status (off, scheduled, active, ended), and the senders answered recently. Requires send access, or an administrator account.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/auto-reply`,
    )),
  );

  server.registerTool(
    "set_auto_reply",
    {
      title: "Set auto-reply",
      description: "Turn a mailbox's out-of-office auto-reply on or off and set its schedule and message. Replies follow RFC 3834: mailing lists, bounces, other auto-responders and spam are never answered, and each sender gets at most one reply per interval.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        enabled: z.boolean(),
        startsAt: z.iso.datetime({ offset: true }).nullable().optional()
          .describe("When replies start; omit or null to start now."),
        endsAt: z.iso.datetime({ offset: true }).nullable().optional()
          .describe("When replies stop; omit or null for no end."),
        timeZone: z.string().max(64).nullable().optional(),
        subject: z.string().max(998).nullable().optional()
          .describe("Defaults to \"Auto: <original subject>\"."),
        bodyText: z.string().max(10_000).optional().describe("Plain-text reply; required when enabled."),
        audience: z.enum(["everyone", "knownSenders"]).optional(),
        skipInternal: z.boolean().optional(),
        replyIntervalDays: z.number().int().min(1).max(30).optional(),
      }),
      annotations: write,
    },
    ({ mailboxId, ...settings }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/auto-reply`,
      { method: "PUT", json: settings },
    )),
  );

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
    "empty_folder",
    {
      title: "Empty Trash or Spam",
      description: "Permanently delete up to 100 of the oldest conversations in Trash or Spam. Returns { deleted, remaining }; call again while remaining is above 0. Requires send access.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        folder: z.enum(["trash", "spam"]),
      }),
      annotations: { ...write, destructiveHint: true, idempotentHint: false },
    },
    ({ mailboxId, folder }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders/${folder}/empty`,
      { method: "POST" },
    )),
  );

  server.registerTool(
    "list_rules",
    {
      title: "List mailbox rules",
      description: "List a mailbox's rules in the order they run on new mail. Requires send access.",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(`/mail/mailboxes/${encodeURIComponent(mailboxId)}/rules`)),
  );

  server.registerTool(
    "test_rule",
    {
      title: "Test a mailbox rule",
      description: "Count how many of the latest 500 incoming messages the conditions would match, without changing anything.",
      inputSchema: ruleInputSchema.pick({ match: true, conditions: true }).extend({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, readOnlyHint: true },
    },
    ({ mailboxId, ...rule }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/rules/test`,
      { method: "POST", json: rule },
    )),
  );

  server.registerTool(
    "set_retention",
    {
      title: "Set Trash and Spam retention",
      description: "Automatically delete conversations after they have been in Trash or Spam for a number of days (1 to 365), or null to keep them. Requires send access.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        trashDays: z.number().int().min(1).max(365).nullable(),
        spamDays: z.number().int().min(1).max(365).nullable(),
      }),
      annotations: { ...write, destructiveHint: true },
    },
    ({ mailboxId, ...retention }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/retention`,
      { method: "PUT", json: retention },
    )),
  );

  server.registerTool(
    "create_rule",
    {
      title: "Create a mailbox rule",
      description: "Add a rule that runs on new mail after spam classification. Conditions: from (contains/equals/domain), recipient, subject, listId, hasAttachment. Actions: moveToFolder, archive, trash, spam, notSpam, markRead, forward (resend from the mailbox with Reply-To set to the sender; keepCopy false moves the original to Trash).",
      inputSchema: ruleInputSchema.extend({ mailboxId: mailboxIdSchema }),
      annotations: { ...write, idempotentHint: false, openWorldHint: true },
    },
    ({ mailboxId, ...rule }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/rules`,
      { method: "POST", json: rule },
    )),
  );

  server.registerTool(
    "delete_rule",
    {
      title: "Delete a mailbox rule",
      inputSchema: z.object({ mailboxId: mailboxIdSchema, ruleId: z.string().min(1).max(80) }),
      annotations: { ...write, destructiveHint: true },
    },
    ({ mailboxId, ruleId }) => runTool(() => api.json(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    )),
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
