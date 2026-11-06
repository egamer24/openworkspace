import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../worker/db/client";
import { users } from "../worker/db/schema";
import { mailboxStub } from "../worker/mailbox";

const MCP_PROTOCOL_VERSION = "2026-07-28";

type JsonRpcResponse = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected an authenticated session cookie");
  return cookie;
}

async function createToken(cookie: string, name: string) {
  const response = await exports.default.fetch(
    new Request("http://example.test/api/auth/api-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(response.status).toBe(201);
  return response.json<{
    token: { id: string; name: string; token: string; tokenPrefix: string };
  }>();
}

async function mcpRequest(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  });
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  return exports.default.fetch(
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
    }),
  );
}

async function legacyMcpRequest(
  token: string,
  method: string,
  params: Record<string, unknown>,
) {
  return exports.default.fetch(
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
    }),
  );
}

describe("account MCP", () => {
  it("uses revocable personal tokens and exposes admin tools only to admins", async () => {
    const bootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
      }),
    );
    expect(bootstrap.status).toBe(200);
    const adminCookie = sessionCookie(bootstrap);
    await bootstrap.json();

    const adminToken = (await createToken(adminCookie, "Admin client")).token;
    expect(adminToken.token).toMatch(/^mcp_/u);
    expect(adminToken.token.startsWith(adminToken.tokenPrefix)).toBe(true);
    const listedTokens = await exports.default.fetch(
      new Request("http://example.test/api/auth/api-tokens", {
        headers: { cookie: adminCookie },
      }),
    );
    const listedTokenBody = await listedTokens.json();
    expect(listedTokenBody).toMatchObject({
      tokens: [{
        id: adminToken.id,
        name: "Admin client",
        tokenPrefix: adminToken.tokenPrefix,
      }],
    });
    expect(JSON.stringify(listedTokenBody)).not.toContain(adminToken.token);

    const bearerMailboxes = await exports.default.fetch(
      new Request("http://example.test/api/mail/mailboxes", {
        headers: { authorization: `Bearer ${adminToken.token}` },
      }),
    );
    expect(bearerMailboxes.status).toBe(200);
    expect(await bearerMailboxes.json()).toMatchObject({
      mailboxes: [{ address: "admin@example.test" }],
    });

    const adminToolsResponse = await mcpRequest(adminToken.token, "tools/list");
    expect(adminToolsResponse.status).toBe(200);
    const adminTools = await adminToolsResponse.json<JsonRpcResponse>();
    expect(adminTools.error).toBeUndefined();
    expect(adminTools.result).toMatchObject({ resultType: "complete" });
    const adminToolNames = (adminTools.result?.tools as Array<{ name: string }>)
      .map((tool) => tool.name);
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
    expect(adminToolNames).toContain("get_spam_settings");
    expect(adminToolNames).toContain("add_spam_sender");
    expect(adminToolNames).toContain("remove_spam_sender");
    expect(adminToolNames).toContain("get_spam_learning");
    expect(adminToolNames).toContain("reset_spam_learning");

    const invitationResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "invite_user",
        arguments: {
          name: "MCP invite",
          email: "mcp-invite@example.test",
        },
      },
    );
    const invitationBody = await invitationResponse.json<JsonRpcResponse>();
    const invitationUrl = ((invitationBody.result?.structuredContent as {
      accessLink: { url: string };
    }).accessLink.url);
    expect(new URL(invitationUrl).origin).toBe("http://example.test");

    const legacyInitialize = await legacyMcpRequest(
      adminToken.token,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1.0.0" },
      },
    );
    expect(legacyInitialize.status).toBe(200);
    expect(await legacyInitialize.text()).toContain(
      '"protocolVersion":"2025-11-25"',
    );
    const legacyTools = await legacyMcpRequest(
      adminToken.token,
      "tools/list",
      {},
    );
    expect(legacyTools.status).toBe(200);
    expect(await legacyTools.text()).toContain('"name":"list_mailboxes"');

    const callResponse = await mcpRequest(adminToken.token, "tools/call", {
      name: "list_mailboxes",
      arguments: {},
    });
    expect(callResponse.status).toBe(200);
    const callBody = await callResponse.json<JsonRpcResponse>();
    expect(callBody).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: {
          mailboxes: [{ address: "admin@example.test" }],
        },
      },
    });
    const mailboxId = ((callBody.result?.structuredContent as {
      mailboxes: Array<{ id: string }>;
    }).mailboxes[0]!).id;
    const messageId = "msg_mcp_resource";
    const attachmentId = "att_mcp_resource";
    const rawObjectKey = `mailboxes/${mailboxId}/raw/mcp-resource.eml`;
    const attachmentObjectKey = `mailboxes/${mailboxId}/messages/${messageId}/attachments/${attachmentId}`;
    const rawMessage = "Subject: MCP original\r\n\r\nhello";
    await env.MAIL_STORAGE.put(rawObjectKey, rawMessage);
    await env.MAIL_STORAGE.put(attachmentObjectKey, "abcdef");
    await mailboxStub(env, mailboxId).seedMailbox([], [{
      id: messageId,
      conversationId: "conv_mcp_resource",
      direction: "incoming",
      fromJson: [{ address: "sender@example.net", name: null }],
      toJson: [{ address: "admin@example.test", name: null }],
      subject: "MCP resource",
      timelineAt: new Date(),
      transportState: "received",
      rawMimeR2Key: rawObjectKey,
      attachmentsJson: [{
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
      }],
    }]);
    const originalResponse = await mcpRequest(adminToken.token, "tools/call", {
      name: "get_original_message",
      arguments: { mailboxId, messageId, maxBytes: 100 },
    });
    const originalBody = await originalResponse.json<JsonRpcResponse>();
    expect(originalBody.result).toMatchObject({
      structuredContent: {
        filename: `${messageId}.eml`,
        contentType: "message/rfc822",
        totalBytes: rawMessage.length,
        nextOffsetBytes: null,
        complete: true,
      },
      content: [{ type: "text" }, {
        type: "resource",
        resource: {
          mimeType: "message/rfc822",
          blob: btoa(rawMessage),
        },
      }],
    });
    const createFolderResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "create_folder",
        arguments: { mailboxId, name: "MCP folder" },
      },
    );
    expect(createFolderResponse.status).toBe(200);
    expect(await createFolderResponse.json<JsonRpcResponse>()).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: { folder: { name: "MCP folder" } },
      },
    });
    const administrationResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      { name: "get_administration", arguments: {} },
    );
    expect(administrationResponse.status).toBe(200);
    expect(await administrationResponse.json<JsonRpcResponse>()).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: { aiProcessingEnabled: false },
      },
    });

    const [adminUser] = await createDb(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    const createSharedResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "create_mailbox",
        arguments: {
          address: "mcp-shared@example.test",
          displayName: "MCP shared",
          ownerUserId: null,
          members: [{ userId: adminUser!.id, canSend: true }],
        },
      },
    );
    const createSharedBody = await createSharedResponse.json<JsonRpcResponse>();
    const sharedMailboxId = (createSharedBody.result?.structuredContent as {
      mailboxId: string;
    }).mailboxId;
    const sharedObjectKey = `mailboxes/${sharedMailboxId}/raw/delete-me.eml`;
    await env.MAIL_STORAGE.put(sharedObjectKey, "delete me");
    await mailboxStub(env, sharedMailboxId).seedMailbox([], []);
    const deleteSharedResponse = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "delete_mailbox",
        arguments: { mailboxId: sharedMailboxId },
      },
    );
    expect(await deleteSharedResponse.json<JsonRpcResponse>()).toMatchObject({
      result: {
        structuredContent: { ok: true, mailboxId: sharedMailboxId },
      },
    });
    expect(await env.MAIL_STORAGE.head(sharedObjectKey)).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ?")
        .bind(sharedMailboxId)
        .first(),
    ).toBeNull();
    const repeatDeleteShared = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "delete_mailbox",
        arguments: { mailboxId: sharedMailboxId },
      },
    );
    expect(await repeatDeleteShared.json<JsonRpcResponse>()).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
    const rejectPersonalDelete = await mcpRequest(
      adminToken.token,
      "tools/call",
      {
        name: "delete_mailbox",
        arguments: { mailboxId },
      },
    );
    expect(await rejectPersonalDelete.json<JsonRpcResponse>()).toMatchObject({
      result: { isError: true },
    });
    expect(await env.MAIL_STORAGE.head(rawObjectKey)).not.toBeNull();

    const invited = await exports.default.fetch(
      new Request("http://example.test/api/admin/invitations", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Member", email: "member@example.test" }),
      }),
    );
    expect(invited.status).toBe(201);
    const invitedBody = await invited.json<{ accessLink: { userId: string } }>();
    await createDb(env.DB)
      .update(users)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(users.id, invitedBody.accessLink.userId));
    const memberLogin = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: invitedBody.accessLink.userId }),
      }),
    );
    expect(memberLogin.status).toBe(200);
    const memberToken = (
      await createToken(sessionCookie(memberLogin), "Member client")
    ).token;
    await memberLogin.json();

    const memberToolsResponse = await mcpRequest(memberToken.token, "tools/list");
    expect(memberToolsResponse.status).toBe(200);
    const memberTools = await memberToolsResponse.json<JsonRpcResponse>();
    const memberToolNames = (memberTools.result?.tools as Array<{ name: string }>)
      .map((tool) => tool.name);
    expect(memberToolNames).toContain("list_mailboxes");
    expect(memberToolNames).not.toContain("get_administration");

    const promoteMember = await mcpRequest(adminToken.token, "tools/call", {
      name: "update_user",
      arguments: { userId: invitedBody.accessLink.userId, role: "admin" },
    });
    expect(await promoteMember.json<JsonRpcResponse>()).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
    const promotedTools = await mcpRequest(memberToken.token, "tools/list");
    const promotedToolNames = (
      (await promotedTools.json<JsonRpcResponse>()).result?.tools as Array<{
        name: string;
      }>
    ).map((tool) => tool.name);
    expect(promotedToolNames).toContain("get_administration");
    const rejectSelfDemotion = await mcpRequest(
      memberToken.token,
      "tools/call",
      {
        name: "update_user",
        arguments: { userId: invitedBody.accessLink.userId, role: "member" },
      },
    );
    expect(await rejectSelfDemotion.json<JsonRpcResponse>()).toMatchObject({
      result: { isError: true },
    });
    const demoteMember = await mcpRequest(adminToken.token, "tools/call", {
      name: "update_user",
      arguments: { userId: invitedBody.accessLink.userId, role: "member" },
    });
    expect(await demoteMember.json<JsonRpcResponse>()).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
    const demotedTools = await mcpRequest(memberToken.token, "tools/list");
    const demotedToolNames = (
      (await demotedTools.json<JsonRpcResponse>()).result?.tools as Array<{
        name: string;
      }>
    ).map((tool) => tool.name);
    expect(demotedToolNames).not.toContain("get_administration");

    const disableMember = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/users/${invitedBody.accessLink.userId}`,
        {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Member", status: "disabled" }),
        },
      ),
    );
    expect(disableMember.status).toBe(200);
    await disableMember.json();
    expect((await mcpRequest(memberToken.token, "tools/list")).status).toBe(401);

    const revoke = await exports.default.fetch(
      new Request(`http://example.test/api/auth/api-tokens/${adminToken.id}`, {
        method: "DELETE",
        headers: { cookie: adminCookie },
      }),
    );
    expect(revoke.status).toBe(200);
    await revoke.json();
    expect((await mcpRequest(adminToken.token, "tools/list")).status).toBe(401);
  });
});
