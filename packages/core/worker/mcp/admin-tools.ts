import { z } from "zod";

import { ACCESS_SCOPE, PEOPLE_READ_SCOPE } from "../../shared/oidc";
import {
  createInvitationSchema,
  createMailboxSchema,
  createOidcClientSchema,
  teamInputSchema,
  updateMailboxSchema,
  updateOidcClientSchema,
  updateUserSchema,
} from "../admin/schemas";
import type { ScopedToolRegistrar } from "../modules";
import { webhookEndpointInputSchema } from "../webhooks/schemas";
import type { AccountApiClient } from "./account-client";
import { runTool } from "./results";
import { entityIdSchema } from "./schemas";

const adminWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Administration tools. Each declares the scope it needs; the person's own
 * permissions then decide, in the API, what it may change.
 */
export function registerAdminTools(
  tool: ScopedToolRegistrar,
  api: AccountApiClient
) {
  tool(PEOPLE_READ_SCOPE)(
    "get_administration",
    {
      title: "Get account administration",
      description:
        "List what you may administer: mail domains, people with what they may manage, teams and their members, mailboxes with who can open them, and SSO applications with the teams that may use them. Sections you have no permission for come back empty.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => runTool(() => api.json("/admin/state"))
  );

  tool("admin.webhooks")(
    "list_webhooks",
    {
      title: "List account webhooks",
      description:
        "List webhook endpoints with their 50 most recent deliveries, and the mailboxes you may choose for mail events. Each endpoint lists its mailboxes; one marked unavailable no longer gets mail because whoever saved the endpoint can't open it.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => runTool(() => api.json("/admin/webhooks"))
  );

  tool("admin.webhooks")(
    "create_webhook",
    {
      title: "Create account webhook",
      description:
        "Create an endpoint. Mailbox events (such as email.received from the mail module) carry full messages and need mailboxIds: mailboxes you can open, whose mail is sent only while you can open them. The signing secret is returned once.",
      inputSchema: webhookEndpointInputSchema,
      annotations: { ...adminWrite, openWorldHint: true },
    },
    (input) =>
      runTool(() =>
        api.json("/admin/webhooks", {
          method: "POST",
          json: input,
        })
      )
  );

  tool("admin.webhooks")(
    "update_webhook",
    {
      title: "Update account webhook",
      description:
        "Replace an endpoint's settings. You become the person its mailboxes' mail follows, so mailboxIds must all be mailboxes you can open.",
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
    ({ webhookId, ...input }) =>
      runTool(() =>
        api.json(`/admin/webhooks/${encodeURIComponent(webhookId)}`, {
          method: "PUT",
          json: input,
        })
      )
  );

  tool("admin.webhooks")(
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
    ({ webhookId }) =>
      runTool(() =>
        api.json(`/admin/webhooks/${encodeURIComponent(webhookId)}`, {
          method: "DELETE",
        })
      )
  );

  tool("admin.webhooks")(
    "rotate_webhook_secret",
    {
      title: "Rotate webhook signing secret",
      description:
        "Invalidate the current secret and return its replacement once.",
      inputSchema: z.object({ webhookId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    ({ webhookId }) =>
      runTool(() =>
        api.json(
          `/admin/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`,
          { method: "POST" }
        )
      )
  );

  tool("admin.webhooks")(
    "send_webhook_test",
    {
      title: "Send webhook test",
      inputSchema: z.object({ webhookId: entityIdSchema }),
      annotations: { ...adminWrite, openWorldHint: true },
    },
    ({ webhookId }) =>
      runTool(() =>
        api.json(`/admin/webhooks/${encodeURIComponent(webhookId)}/test`, {
          method: "POST",
        })
      )
  );

  tool("admin.people")(
    "invite_user",
    {
      title: "Invite user",
      description:
        "Create a member account, personal mailbox, and one-time invitation link.",
      inputSchema: createInvitationSchema,
      annotations: adminWrite,
    },
    (input) =>
      runTool(() =>
        api.json("/admin/invitations", {
          method: "POST",
          json: input,
        })
      )
  );

  tool({ anyOf: ["admin.people", "admin.teams"] })(
    "create_mailbox",
    {
      title: "Create mailbox",
      description:
        "Create a person's address, or a team address. Delivery inbox gives it its own mailbox (for a team, a shared inbox the team opens together); list copies mail into each team member's own mailbox (team addresses only, with listPosting limiting who may write to it); alias delivers into aliasOf, another mailbox of the same person or team; forward sends mail on to forwardTo, up to five outside addresses, each of which must confirm the email Cloudflare sends it first. catchAll makes an inbox get mail for unknown addresses on its domain (one per domain).",
      inputSchema: createMailboxSchema,
      annotations: adminWrite,
    },
    (input) =>
      runTool(() =>
        api.json("/admin/mailboxes", {
          method: "POST",
          json: input,
        })
      )
  );

  tool("admin.people")(
    "set_primary_mailbox",
    {
      title: "Set primary personal mailbox",
      inputSchema: z.object({ mailboxId: entityIdSchema }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ mailboxId }) =>
      runTool(() =>
        api.json(`/admin/mailboxes/${encodeURIComponent(mailboxId)}/primary`, {
          method: "POST",
        })
      )
  );

  tool({ anyOf: ["admin.people", "admin.teams"] })(
    "update_shared_mailbox",
    {
      title: "Update mailbox address",
      description:
        "Change a team address or a person's address: its display name, its team (team addresses only), its delivery (inbox, list, alias with aliasOf, or forward with forwardTo, as in create_mailbox), whether it is its domain's catch-all, and who may write to a mailing list. A primary address stays an inbox.",
      inputSchema: z.object({
        mailboxId: entityIdSchema,
        ...updateMailboxSchema.shape,
      }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ mailboxId, ...input }) =>
      runTool(() =>
        api.json(`/admin/mailboxes/${encodeURIComponent(mailboxId)}`, {
          method: "PATCH",
          json: input,
        })
      )
  );

  tool({ anyOf: ["admin.people", "admin.teams"] })(
    "delete_mailbox",
    {
      title: "Delete mailbox",
      description:
        "Permanently delete a shared or secondary personal mailbox and its data. A primary personal mailbox must be replaced first.",
      inputSchema: z.object({ mailboxId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    ({ mailboxId }) =>
      runTool(() =>
        api.json(`/admin/mailboxes/${encodeURIComponent(mailboxId)}`, {
          method: "DELETE",
        })
      )
  );

  tool(["admin.people", ACCESS_SCOPE])(
    "create_user_access_link",
    {
      title: "Create user recovery link",
      description:
        "Revoke older recovery links and create a new one-time account recovery URL.",
      inputSchema: z.object({ userId: entityIdSchema }),
      annotations: { ...adminWrite, destructiveHint: true },
    },
    ({ userId }) =>
      runTool(() =>
        api.json(`/admin/users/${encodeURIComponent(userId)}/access-link`, {
          method: "POST",
        })
      )
  );

  tool("admin.people")(
    "update_user",
    {
      title: "Update user",
      description:
        "Rename, disable, or reactivate a user. Promoting, demoting, and setting what a member may manage need the admin.access scope and an administrator. Disabling revokes active access.",
      inputSchema: z.object({
        userId: entityIdSchema,
        ...updateUserSchema.shape,
      }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    ({ userId, ...input }) =>
      runTool(() =>
        api.json(`/admin/users/${encodeURIComponent(userId)}`, {
          method: "PATCH",
          json: input,
        })
      )
  );

  tool("admin.apps")(
    "create_oidc_application",
    {
      title: "Create OIDC application",
      description:
        "Register an OIDC client. Members of accessTeamIds may sign in (the Everyone team admits everyone). Confidential client secrets are returned once.",
      inputSchema: createOidcClientSchema,
      annotations: adminWrite,
    },
    (input) =>
      runTool(() =>
        api.json("/admin/oidc-clients", {
          method: "POST",
          json: input,
        })
      )
  );

  tool("admin.apps")(
    "update_oidc_application",
    {
      title: "Update OIDC application",
      description:
        "Replace an OIDC application's configuration and assignments.",
      inputSchema: z.object({
        clientId: entityIdSchema,
        ...updateOidcClientSchema.shape,
      }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ clientId, ...input }) =>
      runTool(() =>
        api.json(`/admin/oidc-clients/${encodeURIComponent(clientId)}`, {
          method: "PATCH",
          json: input,
        })
      )
  );

  tool("admin.apps")(
    "delete_oidc_application",
    {
      title: "Delete OIDC application",
      inputSchema: z.object({ clientId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    ({ clientId }) =>
      runTool(() =>
        api.json(`/admin/oidc-clients/${encodeURIComponent(clientId)}`, {
          method: "DELETE",
        })
      )
  );

  tool("admin.apps")(
    "rotate_oidc_application_secret",
    {
      title: "Rotate OIDC application secret",
      description:
        "Replace a confidential OIDC client's secret and return the new secret once.",
      inputSchema: z.object({ clientId: entityIdSchema }),
      annotations: { ...adminWrite, destructiveHint: true },
    },
    ({ clientId }) =>
      runTool(() =>
        api.json(
          `/admin/oidc-clients/${encodeURIComponent(clientId)}/rotate-secret`,
          { method: "POST" }
        )
      )
  );

  tool("admin.teams")(
    "create_team",
    {
      title: "Create team",
      description:
        "Create a team. Its members share its inboxes and receive its mailing lists; its handle is released to SSO applications in the groups claim. Set everyone to include every active person automatically.",
      inputSchema: teamInputSchema,
      annotations: adminWrite,
    },
    (input) =>
      runTool(() =>
        api.json("/admin/teams", {
          method: "POST",
          json: input,
        })
      )
  );

  tool("admin.teams")(
    "update_team",
    {
      title: "Update team",
      description:
        "Replace a team's details and complete member list (ignored when everyone is set). Members gain or lose access to the team's mailboxes and SSO applications immediately.",
      inputSchema: z.object({
        teamId: entityIdSchema,
        ...teamInputSchema.shape,
      }),
      annotations: { ...adminWrite, idempotentHint: true },
    },
    ({ teamId, ...input }) =>
      runTool(() =>
        api.json(`/admin/teams/${encodeURIComponent(teamId)}`, {
          method: "PATCH",
          json: input,
        })
      )
  );

  tool("admin.teams")(
    "delete_team",
    {
      title: "Delete team",
      description: "Delete a team that has no mailboxes left.",
      inputSchema: z.object({ teamId: entityIdSchema }),
      annotations: {
        ...adminWrite,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    ({ teamId }) =>
      runTool(() =>
        api.json(`/admin/teams/${encodeURIComponent(teamId)}`, {
          method: "DELETE",
        })
      )
  );
}
