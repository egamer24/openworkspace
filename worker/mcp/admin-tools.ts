import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  cloudflareConnectSchema,
  createDomainSchema,
  createInvitationSchema,
  createMailboxSchema,
  createOidcClientSchema,
  globalAiProcessingSchema,
  groupInputSchema,
  updateMailboxSchema,
  updateDomainSchema,
  updateOidcClientSchema,
  updateUserSchema,
} from "../admin/schemas";
import { AccountApiClient } from "./account-client";
import { runTool } from "./results";
import { entityIdSchema } from "./schemas";
import { webhookEndpointInputSchema } from "../webhooks/schemas";

const adminWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerAdminTools(server: McpServer, api: AccountApiClient) {
  server.registerTool(
    "get_administration",
    {
      title: "Get account administration",
      description: "List domains, global settings, users, mailboxes, memberships, identity groups, and OIDC applications.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => runTool(() => api.json("/admin/state")),
  );

  server.registerTool(
    "add_domain",
    {
      title: "Add mail domain",
      description: "Allow mailboxes on a domain that an administrator has already configured in Cloudflare.",
      inputSchema: createDomainSchema,
      annotations: adminWrite,
    },
    (input) => runTool(() => api.json("/admin/domains", {
      method: "POST",
      json: input,
    })),
  );

  server.registerTool(
    "update_domain",
    {
      title: "Update mail domain",
      inputSchema: updateDomainSchema.safeExtend({
        domainId: entityIdSchema,
      }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ domainId, ...input }) => runTool(() => api.json(
      `/admin/domains/${encodeURIComponent(domainId)}`,
      { method: "PATCH", json: input },
    )),
  );

  server.registerTool(
    "delete_domain",
    {
      title: "Delete mail domain",
      description: "Delete a non-primary domain after all of its mailboxes are removed.",
      inputSchema: z.object({ domainId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    ({ domainId }) => runTool(() => api.json(
      `/admin/domains/${encodeURIComponent(domainId)}`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "check_domain_cloudflare",
    {
      title: "Check Cloudflare domain setup",
      description: "Re-read Email Routing, the catch-all rule, and Email Sending for a domain from the Cloudflare API and report each step's status. Requires CLOUDFLARE_API_TOKEN.",
      inputSchema: z.object({ domainId: entityIdSchema }),
      annotations: { ...adminWrite, idempotentHint: true, openWorldHint: true },
    },
    ({ domainId }) => runTool(() => api.json(
      `/admin/domains/${encodeURIComponent(domainId)}/cloudflare/check`,
      { method: "POST" },
    )),
  );

  server.registerTool(
    "connect_domain_cloudflare",
    {
      title: "Connect or repair a domain through Cloudflare",
      description: "Configure Email Routing, the catch-all Worker rule, and Email Sending for a domain, adding the domain if needed. Steps already in place are skipped, so this also repairs drift. Stops with outcome mx_conflict when the domain has MX records for another provider; only pass replaceMx after the administrator confirms replacing them. Changes made by a failed run are rolled back.",
      inputSchema: cloudflareConnectSchema,
      annotations: { ...adminWrite, idempotentHint: true, openWorldHint: true },
    },
    (input) => runTool(() => api.json("/admin/cloudflare/connect", {
      method: "POST",
      json: input,
    })),
  );

  server.registerTool(
    "set_global_ai_processing",
    {
      title: "Enable or pause AI mail processing",
      inputSchema: globalAiProcessingSchema,
      annotations: { ...adminWrite, idempotentHint: true },
    },
    (input) => runTool(() => api.json("/admin/ai", {
      method: "PUT",
      json: input,
    })),
  );

  server.registerTool(
    "list_webhooks",
    {
      title: "List account webhooks",
      description: "List account-wide webhook endpoints and their 50 most recent deliveries.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => runTool(() => api.json("/admin/webhooks")),
  );

  server.registerTool(
    "create_webhook",
    {
      title: "Create account webhook",
      description: "Create an account-wide endpoint. The signing secret is returned once.",
      inputSchema: webhookEndpointInputSchema,
      annotations: { ...adminWrite, openWorldHint: true },
    },
    (input) => runTool(() => api.json("/admin/webhooks", {
      method: "POST",
      json: input,
    })),
  );

  server.registerTool(
    "update_webhook",
    {
      title: "Update account webhook",
      inputSchema: z.object({
        webhookId: entityIdSchema,
        ...webhookEndpointInputSchema.shape,
      }),
      annotations: {
        ...adminWrite,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ webhookId, ...input }) => runTool(() => api.json(
      `/admin/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "PUT", json: input },
    )),
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete account webhook",
      inputSchema: z.object({ webhookId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ webhookId }) => runTool(() => api.json(
      `/admin/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "rotate_webhook_secret",
    {
      title: "Rotate webhook signing secret",
      description: "Invalidate the current secret and return its replacement once.",
      inputSchema: z.object({ webhookId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    ({ webhookId }) => runTool(() => api.json(
      `/admin/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`,
      { method: "POST" },
    )),
  );

  server.registerTool(
    "send_webhook_test",
    {
      title: "Send webhook test",
      inputSchema: z.object({ webhookId: entityIdSchema }),
      annotations: { ...adminWrite, openWorldHint: true },
    },
    ({ webhookId }) => runTool(() => api.json(
      `/admin/webhooks/${encodeURIComponent(webhookId)}/test`,
      { method: "POST" },
    )),
  );

  server.registerTool(
    "invite_user",
    {
      title: "Invite user",
      description: "Create a member account, personal mailbox, and one-time invitation link.",
      inputSchema: createInvitationSchema,
      annotations: adminWrite,
    },
    (input) => runTool(() => api.json("/admin/invitations", {
      method: "POST",
      json: input,
    })),
  );

  server.registerTool(
    "create_mailbox",
    {
      title: "Create mailbox",
      description: "Create a personal mailbox for one owner or a shared mailbox with explicit members.",
      inputSchema: createMailboxSchema,
      annotations: adminWrite,
    },
    (input) => runTool(() => api.json("/admin/mailboxes", {
      method: "POST",
      json: input,
    })),
  );

  server.registerTool(
    "set_primary_mailbox",
    {
      title: "Set primary personal mailbox",
      inputSchema: z.object({ mailboxId: entityIdSchema }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ mailboxId }) => runTool(() => api.json(
      `/admin/mailboxes/${encodeURIComponent(mailboxId)}/primary`,
      { method: "POST" },
    )),
  );

  server.registerTool(
    "update_shared_mailbox",
    {
      title: "Update shared mailbox",
      description: "Change a shared mailbox display name and replace its member access list.",
      inputSchema: z.object({
        mailboxId: entityIdSchema,
        ...updateMailboxSchema.shape,
      }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ mailboxId, ...input }) => runTool(() => api.json(
      `/admin/mailboxes/${encodeURIComponent(mailboxId)}`,
      { method: "PATCH", json: input },
    )),
  );

  server.registerTool(
    "delete_mailbox",
    {
      title: "Delete mailbox",
      description: "Permanently delete a shared or secondary personal mailbox and its data. A primary personal mailbox must be replaced first.",
      inputSchema: z.object({ mailboxId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    ({ mailboxId }) => runTool(() => api.json(
      `/admin/mailboxes/${encodeURIComponent(mailboxId)}`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "create_user_access_link",
    {
      title: "Create user recovery link",
      description: "Revoke older recovery links and create a new one-time account recovery URL.",
      inputSchema: z.object({ userId: entityIdSchema }),
      annotations: { ...adminWrite, destructiveHint: true },
    },
    ({ userId }) => runTool(() => api.json(
      `/admin/users/${encodeURIComponent(userId)}/access-link`,
      { method: "POST" },
    )),
  );

  server.registerTool(
    "update_user",
    {
      title: "Update user",
      description: "Rename, disable, reactivate, promote, or demote a user. Disabling revokes active access.",
      inputSchema: z.object({
        userId: entityIdSchema,
        ...updateUserSchema.shape,
      }),
      annotations: { ...adminWrite, destructiveHint: true, idempotentHint: true },
    },
    ({ userId, ...input }) => runTool(() => api.json(
      `/admin/users/${encodeURIComponent(userId)}`,
      { method: "PATCH", json: input },
    )),
  );

  server.registerTool(
    "create_oidc_application",
    {
      title: "Create OIDC application",
      description: "Register an OIDC client. Confidential client secrets are returned once.",
      inputSchema: createOidcClientSchema,
      annotations: adminWrite,
    },
    (input) => runTool(() => api.json("/admin/oidc-clients", {
      method: "POST",
      json: input,
    })),
  );

  server.registerTool(
    "update_oidc_application",
    {
      title: "Update OIDC application",
      description: "Replace an OIDC application's configuration and assignments.",
      inputSchema: z.object({
        clientId: entityIdSchema,
        ...updateOidcClientSchema.shape,
      }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ clientId, ...input }) => runTool(() => api.json(
      `/admin/oidc-clients/${encodeURIComponent(clientId)}`,
      { method: "PATCH", json: input },
    )),
  );

  server.registerTool(
    "delete_oidc_application",
    {
      title: "Delete OIDC application",
      inputSchema: z.object({ clientId: entityIdSchema }),
      annotations: { ...adminWrite, destructiveHint: true, idempotentHint: true },
    },
    ({ clientId }) => runTool(() => api.json(
      `/admin/oidc-clients/${encodeURIComponent(clientId)}`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "rotate_oidc_application_secret",
    {
      title: "Rotate OIDC application secret",
      description: "Replace a confidential OIDC client's secret and return the new secret once.",
      inputSchema: z.object({ clientId: entityIdSchema }),
      annotations: { ...adminWrite, destructiveHint: true },
    },
    ({ clientId }) => runTool(() => api.json(
      `/admin/oidc-clients/${encodeURIComponent(clientId)}/rotate-secret`,
      { method: "POST" },
    )),
  );

  server.registerTool(
    "create_identity_group",
    {
      title: "Create identity group",
      inputSchema: groupInputSchema,
      annotations: adminWrite,
    },
    (input) => runTool(() => api.json("/admin/groups", {
      method: "POST",
      json: input,
    })),
  );

  server.registerTool(
    "update_identity_group",
    {
      title: "Update identity group",
      description: "Replace an identity group's metadata and complete membership list.",
      inputSchema: z.object({
        groupId: entityIdSchema,
        ...groupInputSchema.shape,
      }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ groupId, ...input }) => runTool(() => api.json(
      `/admin/groups/${encodeURIComponent(groupId)}`,
      { method: "PATCH", json: input },
    )),
  );

  server.registerTool(
    "delete_identity_group",
    {
      title: "Delete identity group",
      inputSchema: z.object({ groupId: entityIdSchema }),
      annotations: { ...adminWrite, destructiveHint: true, idempotentHint: true },
    },
    ({ groupId }) => runTool(() => api.json(
      `/admin/groups/${encodeURIComponent(groupId)}`,
      { method: "DELETE" },
    )),
  );
}
