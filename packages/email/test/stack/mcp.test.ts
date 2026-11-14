import { describe, expect, it } from "bun:test";

import { createDb, users } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { mcpAccessToken, MCP_TEST_ORIGIN } from "@open-workspace/core/testing";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { env, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Every workspace scope, as an agent asking for everything would. */
const ALL_SCOPES =
  "mail.read mail.send mail.organize people.read admin.people admin.teams admin.apps admin.webhooks admin.blocked_senders admin.workspace admin.access offline_access";

/** A JSON-RPC answer from the MCP endpoint: a result, or an error. */
const jsonRpcResponse = z.looseObject({
  result: z
    .looseObject({
      tools: z.array(z.looseObject({ name: z.string() })).optional(),
      structuredContent: z.looseObject({}).optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

/** A tool call's answer whose structured content has the shape `content`. */
function toolResult<S extends z.ZodType>(content: S) {
  return z.looseObject({
    result: z.looseObject({ structuredContent: content }),
  });
}

/** The params of an MCP request: the tool to call and its arguments. */
type McpParams = { name?: string; arguments?: JsonObject };

function mcpRequest(token: string, method: string, params: McpParams = {}) {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  });

  if (params.name !== undefined) headers.set("mcp-name", params.name);

  return worker.fetch(
    new Request("http://example.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "openworkspace-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    })
  );
}

function legacyMcpRequest(token: string, method: string, params: JsonObject) {
  return worker.fetch(
    new Request("http://example.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    })
  );
}

async function callTool(token: string, name: string, args: JsonObject = {}) {
  const response = await mcpRequest(token, "tools/call", {
    name,
    arguments: args,
  });

  expect(response.status).toBe(200);

  return readJson(response, jsonRpcResponse);
}

/** The names of the tools `token` sees. */
async function toolNames(token: string) {
  const response = await mcpRequest(token, "tools/list");
  const { result } = await readJson(response, jsonRpcResponse);

  return required(result?.tools, "tools/list answers with tools").map(
    (tool) => tool.name
  );
}

describe("account MCP", () => {
  it("signs clients in with OAuth and exposes admin tools only to admins", async () => {
    const bootstrap = await worker.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
      })
    );

    expect(bootstrap.status).toBe(200);
    const adminCookie = sessionCookie(bootstrap);
    await bootstrap.json();

    // Without a token, the server points the client at its OAuth metadata.
    const anonymous = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );

    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${MCP_TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mail.read mail.send mail.organize offline_access"`
    );

    const resourceMetadata = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp`)
    );

    expect(await resourceMetadata.json()).toEqual({
      resource: `${MCP_TEST_ORIGIN}/mcp`,
      authorization_servers: [MCP_TEST_ORIGIN],
      scopes_supported: [
        "mail.read",
        "mail.send",
        "mail.organize",
        "people.read",
        "admin.people",
        "admin.teams",
        "admin.webhooks",
        "admin.apps",
        "admin.blocked_senders",
        "admin.import_mail",
        "admin.mail_archive",
        "admin.workspace",
        "admin.access",
        "offline_access",
      ],
      bearer_methods_supported: ["header"],
      resource_name: "OpenWorkspace",
    });

    const serverMetadata = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/.well-known/oauth-authorization-server`)
    );

    expect(await serverMetadata.json()).toMatchObject({
      issuer: MCP_TEST_ORIGIN,
      registration_endpoint: `${MCP_TEST_ORIGIN}/oauth/register`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });

    const adminToken: Awaited<ReturnType<typeof mcpAccessToken>> & {
      token: string;
    } = {
      ...(await mcpAccessToken(adminCookie, { scope: ALL_SCOPES })),
      token: "",
    };

    // MCP clients get plain OAuth: no ID token, exactly the scopes they asked for, and a refresh token.
    expect(adminToken).toMatchObject({
      scope: ALL_SCOPES,
      idToken: undefined,
      refreshToken: expect.any(String),
    });
    adminToken.token = adminToken.accessToken;

    // Resource indicators must name this server's MCP endpoint.
    const wrongResource = new URL(`${MCP_TEST_ORIGIN}/oauth/authorize`);

    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: adminToken.clientId,
      redirect_uri: "http://127.0.0.1:33418/callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: "https://evil.example/mcp",
    })) {
      wrongResource.searchParams.set(key, value);
    }

    const wrongResourceResponse = await worker.fetch(
      new Request(wrongResource, {
        headers: { cookie: adminCookie },
        redirect: "manual",
      })
    );

    const wrongResourceRedirect = new URL(
      required(
        wrongResourceResponse.headers.get("location"),
        "the authorization endpoint redirects back"
      )
    );

    expect(wrongResourceRedirect.searchParams.get("error")).toBe(
      "invalid_target"
    );
    // Error responses name the issuer too.
    expect(wrongResourceRedirect.searchParams.get("iss")).toBe(MCP_TEST_ORIGIN);

    const connectedApps = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/api/auth/connected-apps`, {
        headers: { cookie: adminCookie },
      })
    );

    expect(await connectedApps.json()).toMatchObject({
      apps: [
        {
          clientId: adminToken.clientId,
          name: "Test agent",
          registration: "dynamic",
          host: "127.0.0.1:33418",
        },
      ],
    });

    const bearerMailboxes = await worker.fetch(
      new Request("http://example.test/api/mail/mailboxes", {
        headers: { authorization: `Bearer ${adminToken.token}` },
      })
    );

    expect(bearerMailboxes.status).toBe(200);
    expect(await bearerMailboxes.json()).toMatchObject({
      mailboxes: [{ address: "admin@example.test" }],
    });

    const adminToolsResponse = await mcpRequest(adminToken.token, "tools/list");
    expect(adminToolsResponse.status).toBe(200);
    const adminTools = await readJson(adminToolsResponse, jsonRpcResponse);
    expect(adminTools.error).toBeUndefined();
    expect(adminTools.result).toMatchObject({ resultType: "complete" });

    const adminToolNames = required(
      adminTools.result?.tools,
      "tools/list answers with tools"
    ).map((tool) => tool.name);

    expect(adminToolNames).toContain("list_mailboxes");
    expect(adminToolNames).toContain("get_administration");
    expect(adminToolNames).toContain("list_webhooks");
    expect(adminToolNames).toContain("create_webhook");
    expect(adminToolNames).toContain("delete_mailbox");
    expect(adminToolNames).toContain("get_attachment_download_url");
    expect(adminToolNames).toContain("create_attachment_upload");
    expect(adminToolNames).toContain("complete_attachment_upload");
    expect(adminToolNames).not.toContain("upload_attachment");
    expect(adminToolNames).toContain("get_original_message");

    for (const name of [
      "get_message_security",
      "unsubscribe_from_mailing_list",
      "report_message",
      "report_conversations",
      "mark_message_not_spam",
      "set_sender_trusted",
      "list_blocked_senders",
      "block_sender",
      "unblock_sender",
      "list_workspace_blocked_senders",
      "block_sender_for_workspace",
      "unblock_sender_for_workspace",
    ]) {
      expect(adminToolNames).toContain(name);
    }

    expect(adminToolNames.filter((name) => name.includes("mail_rule"))).toEqual(
      []
    );

    const invitationResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "invite_user",
        arguments: {
          name: "MCP invite",
          email: "mcp-invite@example.test",
        },
      }
    );

    const invitationBody = await readJson(
      invitationResponse,
      toolResult(
        z.looseObject({ accessLink: z.looseObject({ url: z.string() }) })
      )
    );

    const invitationUrl =
      invitationBody.result.structuredContent.accessLink.url;

    expect(new URL(invitationUrl).origin).toBe("http://example.test");

    const legacyInitialize = await legacyMcpRequest(
      adminToken.token,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1.0.0" },
      }
    );

    expect(legacyInitialize.status).toBe(200);
    expect(await legacyInitialize.text()).toContain(
      '"protocolVersion":"2025-11-25"'
    );

    const legacyTools = await legacyMcpRequest(
      adminToken.token,
      "tools/list",
      {}
    );

    expect(legacyTools.status).toBe(200);
    expect(await legacyTools.text()).toContain('"name":"list_mailboxes"');

    const callResponse = await mcpRequest(adminToken.token, "tools/call", {
      name: "list_mailboxes",
      arguments: {},
    });

    expect(callResponse.status).toBe(200);

    const callBody = await readJson(
      callResponse,
      toolResult(
        z.looseObject({ mailboxes: z.array(z.looseObject({ id: z.string() })) })
      )
    );

    expect(callBody).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: {
          mailboxes: [{ address: "admin@example.test" }],
        },
      },
    });

    const [firstMailbox] = callBody.result.structuredContent.mailboxes;
    const mailboxId = required(firstMailbox, "the admin has a mailbox").id;

    const messageId = "msg_mcp_resource";
    const attachmentId = "att_mcp_resource";
    const rawObjectKey = `mailboxes/${mailboxId}/raw/mcp-resource.eml`;
    const attachmentObjectKey = `mailboxes/${mailboxId}/messages/${messageId}/attachments/${attachmentId}`;
    const rawMessage = "Subject: MCP original\r\n\r\nhello";
    await env.MAIL_STORAGE.put(rawObjectKey, rawMessage);
    await env.MAIL_STORAGE.put(attachmentObjectKey, "abcdef");
    await mailbox(mailboxId).seedMailbox(
      [],
      [
        {
          id: messageId,
          conversationId: "conv_mcp_resource",
          direction: "incoming",
          fromJson: [{ address: "sender@example.net", name: null }],
          toJson: [{ address: "admin@example.test", name: null }],
          subject: "MCP resource",
          timelineAt: new Date(),
          transportState: "received",
          rawMimeR2Key: rawObjectKey,
          attachmentsJson: [
            {
              id: attachmentId,
              r2Key: attachmentObjectKey,
              filename: "sample.txt",
              contentType: "text/plain",
              size: 6,
              contentId: null,
              disposition: "attachment",
              delivery: "attached",
              downloadTokenHash: null,
              downloadExpiresAt: null,
            },
          ],
        },
      ]
    );

    const originalResponse = await mcpRequest(adminToken.token, "tools/call", {
      name: "get_original_message",
      arguments: { mailboxId, messageId, maxBytes: 100 },
    });

    const originalBody = await readJson(originalResponse, jsonRpcResponse);
    expect(originalBody.result).toMatchObject({
      structuredContent: {
        filename: `${messageId}.eml`,
        contentType: "message/rfc822",
        totalBytes: rawMessage.length,
        nextOffsetBytes: null,
        complete: true,
      },
      content: [
        { type: "text" },
        {
          type: "resource",
          resource: {
            mimeType: "message/rfc822",
            blob: btoa(rawMessage),
          },
        },
      ],
    });

    const securityBody = await callTool(
      adminToken.token,
      "get_message_security",
      {
        mailboxId,
        messageId,
      }
    );

    expect(securityBody.result?.isError).toBeFalsy();
    expect(securityBody.result).toMatchObject({
      structuredContent: {
        ok: true,
        messageId,
        from: "sender@example.net",
        subject: "MCP resource",
        verdict: expect.any(String),
        warnings: expect.any(Array),
        unsubscribe: { available: false, oneClick: false },
      },
    });
    expect(securityBody.result?.structuredContent).not.toHaveProperty(
      "trustedHeader"
    );

    const blockBody = await callTool(adminToken.token, "block_sender", {
      mailboxId,
      pattern: "@spam.example.net",
    });

    expect(blockBody.result).toMatchObject({ structuredContent: { ok: true } });

    const blockedBody = await callTool(
      adminToken.token,
      "list_blocked_senders",
      { mailboxId }
    );

    expect(blockedBody.result).toMatchObject({
      structuredContent: {
        blocked: [{ pattern: "@spam.example.net", scope: "domain" }],
      },
    });

    const unblockBody = await callTool(adminToken.token, "unblock_sender", {
      mailboxId,
      pattern: "spam.example.net",
    });

    expect(unblockBody.result).toMatchObject({
      structuredContent: { ok: true },
    });

    const unblockedBody = await callTool(
      adminToken.token,
      "list_blocked_senders",
      { mailboxId }
    );

    expect(unblockedBody.result).toMatchObject({
      structuredContent: { blocked: [] },
    });

    const ownBlockBody = await callTool(adminToken.token, "block_sender", {
      mailboxId,
      pattern: "example.test",
    });

    expect(ownBlockBody.result).toMatchObject({ isError: true });

    // Spam goes through reporting, never a plain move.
    const moveToSpamBody = await callTool(
      adminToken.token,
      "move_conversations",
      {
        mailboxId,
        conversationIds: ["conv_mcp_resource"],
        sourceFolderId: "inbox",
        mailboxState: "spam",
      }
    );

    expect(JSON.stringify(moveToSpamBody)).toMatch(/mailboxState/u);

    const workspaceBlockBody = await callTool(
      adminToken.token,
      "block_sender_for_workspace",
      {
        pattern: "mcp-blocked.example",
        moveExisting: false,
      }
    );

    expect(workspaceBlockBody.result).toMatchObject({
      structuredContent: { ok: true, pattern: "@mcp-blocked.example" },
    });

    const workspaceBlocksBody = await callTool(
      adminToken.token,
      "list_workspace_blocked_senders",
      {}
    );

    expect(workspaceBlocksBody.result).toMatchObject({
      structuredContent: {
        ok: true,
        blockedSenders: [{ pattern: "@mcp-blocked.example", scope: "domain" }],
      },
    });

    const workspaceUnblockBody = await callTool(
      adminToken.token,
      "unblock_sender_for_workspace",
      {
        pattern: "@mcp-blocked.example",
      }
    );

    expect(workspaceUnblockBody.result).toMatchObject({
      structuredContent: { ok: true },
    });

    const createFolderResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "create_folder",
        arguments: { mailboxId, name: "MCP folder" },
      }
    );

    expect(createFolderResponse.status).toBe(200);
    expect(await createFolderResponse.json()).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: { folder: { name: "MCP folder" } },
      },
    });

    const administrationResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      { name: "get_administration", arguments: {} }
    );

    expect(administrationResponse.status).toBe(200);
    expect(await administrationResponse.json()).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: { ok: true, teams: expect.any(Array) },
      },
    });

    const [adminUser] = await createDb(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);

    const createTeamResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "create_team",
        arguments: {
          name: "MCP team",
          slug: "mcp-team",
          description: null,
          members: [
            {
              userId: required(adminUser, "the workspace has an admin").id,
              canSend: true,
            },
          ],
        },
      }
    );

    const { teamId } = (
      await readJson(
        createTeamResponse,
        toolResult(z.looseObject({ teamId: z.string() }))
      )
    ).result.structuredContent;

    expect(teamId).toMatch(/^team_/u);

    const createSharedResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "create_mailbox",
        arguments: {
          address: "mcp-shared@example.test",
          displayName: "MCP shared",
          ownerUserId: null,
          teamId,
        },
      }
    );

    const createSharedBody = await readJson(
      createSharedResponse,
      toolResult(z.looseObject({ mailboxId: z.string() }))
    );

    const sharedMailboxId = createSharedBody.result.structuredContent.mailboxId;

    const sharedObjectKey = `mailboxes/${sharedMailboxId}/raw/delete-me.eml`;
    await env.MAIL_STORAGE.put(sharedObjectKey, "delete me");
    await mailbox(sharedMailboxId).seedMailbox([], []);

    const deleteSharedResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "delete_mailbox",
        arguments: { mailboxId: sharedMailboxId },
      }
    );

    expect(await deleteSharedResponse.json()).toMatchObject({
      result: {
        structuredContent: { ok: true, mailboxId: sharedMailboxId },
      },
    });
    expect(await env.MAIL_STORAGE.head(sharedObjectKey)).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ?")
        .bind(sharedMailboxId)
        .first()
    ).toBeNull();

    const repeatDeleteShared = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "delete_mailbox",
        arguments: { mailboxId: sharedMailboxId },
      }
    );

    expect(await repeatDeleteShared.json()).toMatchObject({
      result: { structuredContent: { ok: true } },
    });

    const rejectPersonalDelete = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "delete_mailbox",
        arguments: { mailboxId },
      }
    );

    expect(await rejectPersonalDelete.json()).toMatchObject({
      result: { isError: true },
    });
    expect(await env.MAIL_STORAGE.head(rawObjectKey)).not.toBeNull();

    const invited = await worker.fetch(
      new Request("http://example.test/api/admin/invitations", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Member", email: "member@example.test" }),
      })
    );

    expect(invited.status).toBe(201);

    const invitedBody = await readJson(
      invited,
      z.object({ accessLink: z.looseObject({ userId: z.string() }) })
    );

    await createDb(env.DB)
      .update(users)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(users.id, invitedBody.accessLink.userId));

    const memberLogin = await worker.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: invitedBody.accessLink.userId }),
      })
    );

    expect(memberLogin.status).toBe(200);
    const memberCookie = sessionCookie(memberLogin);

    // A member asking for everything gets what their role covers: mail.
    const memberOAuth = await mcpAccessToken(memberCookie, {
      scope: ALL_SCOPES,
    });

    expect(memberOAuth.scope).toBe(
      "mail.read mail.send mail.organize offline_access"
    );
    const memberToken = { token: memberOAuth.accessToken };
    await memberLogin.json();

    const memberToolsResponse = await mcpRequest(
      memberToken.token,
      "tools/list"
    );

    expect(memberToolsResponse.status).toBe(200);
    const memberTools = await readJson(memberToolsResponse, jsonRpcResponse);

    const memberToolNames = required(
      memberTools.result?.tools,
      "tools/list answers with tools"
    ).map((tool) => tool.name);

    expect(memberToolNames).toContain("list_mailboxes");
    expect(memberToolNames).not.toContain("get_administration");
    expect(memberToolNames).toContain("get_message_security");
    expect(memberToolNames).toContain("block_sender");
    expect(memberToolNames).not.toContain("list_workspace_blocked_senders");
    expect(memberToolNames).not.toContain("block_sender_for_workspace");

    const memberAdminCall = await callTool(
      memberToken.token,
      "block_sender_for_workspace",
      {
        pattern: "mcp-blocked.example",
      }
    );

    expect(
      memberAdminCall.result?.isError ?? Boolean(memberAdminCall.error)
    ).toBe(true);

    const memberSecurityCall = await callTool(
      memberToken.token,
      "get_message_security",
      {
        mailboxId,
        messageId,
      }
    );

    expect(memberSecurityCall.result).toMatchObject({ isError: true });

    const promoteMember = await mcpRequest(adminToken.token, "tools/call", {
      name: "update_user",
      arguments: { userId: invitedBody.accessLink.userId, role: "admin" },
    });

    expect(await promoteMember.json()).toMatchObject({
      result: { structuredContent: { ok: true } },
    });

    // A promotion does not reach scopes the person never granted the app.
    expect(await toolNames(memberToken.token)).not.toContain(
      "get_administration"
    );

    const promotedToken = (
      await mcpAccessToken(memberCookie, { scope: ALL_SCOPES })
    ).accessToken;

    expect(await toolNames(promotedToken)).toContain("get_administration");

    const rejectSelfDemotion = await mcpRequest(promotedToken, "tools/call", {
      name: "update_user",
      arguments: { userId: invitedBody.accessLink.userId, role: "member" },
    });

    expect(await rejectSelfDemotion.json()).toMatchObject({
      result: { isError: true },
    });

    const demoteMember = await mcpRequest(adminToken.token, "tools/call", {
      name: "update_user",
      arguments: { userId: invitedBody.accessLink.userId, role: "member" },
    });

    expect(await demoteMember.json()).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
    // What was granted works only as far as the person may go today.
    const demotedToolNames = await toolNames(promotedToken);
    expect(demotedToolNames).not.toContain("get_administration");
    expect(demotedToolNames).toContain("list_mailboxes");

    const disableMember = await worker.fetch(
      new Request(
        `http://example.test/api/admin/users/${invitedBody.accessLink.userId}`,
        {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Member", status: "disabled" }),
        }
      )
    );

    expect(disableMember.status).toBe(200);
    await disableMember.json();
    expect((await mcpRequest(memberToken.token, "tools/list")).status).toBe(
      401
    );

    // Disconnecting the app in settings revokes its tokens at once.
    const revoke = await worker.fetch(
      new Request(
        `${MCP_TEST_ORIGIN}/api/auth/connected-apps/${encodeURIComponent(adminToken.clientId)}`,
        {
          method: "DELETE",
          headers: { cookie: adminCookie, origin: MCP_TEST_ORIGIN },
        }
      )
    );

    expect(revoke.status).toBe(200);
    await revoke.json();
    expect((await mcpRequest(adminToken.token, "tools/list")).status).toBe(401);
  });
});
