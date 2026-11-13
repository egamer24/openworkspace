import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import {
  mcpAccessToken,
  MCP_TEST_ORIGIN,
  MCP_TEST_REDIRECT,
  pkcePair,
  registerMcpClient,
} from "@open-workspace/core/testing";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = MCP_TEST_ORIGIN;
let adminCookie = "";
let memberCookie = "";
let memberId = "";

const toolList = z.object({
  result: z.looseObject({
    tools: z.array(z.looseObject({ name: z.string() })),
  }),
});

/** The consent screen's request: what the app asks for and what it cannot get. */
const consentView = z.object({
  request: z.looseObject({
    scopes: z.array(z.looseObject({ id: z.string() })),
    unavailableScopes: z.array(z.looseObject({ id: z.string() })),
  }),
});

function api(
  token: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ authorization: `Bearer ${token}` });

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

async function toolNames(token: string) {
  const response = await worker.fetch(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "scopes-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    })
  );

  if (response.status !== 200) return response.status;

  const body = await readJson(response, toolList);

  return body.result.tools.map((tool) => tool.name);
}

/** Starts an authorization as the cookie's person and returns the consent request's id. */
async function startConsent(
  cookie: string,
  input: { clientId?: string; scope: string }
) {
  const clientId = input.clientId ?? (await registerMcpClient()).client_id;
  const pkce = await pkcePair();
  const authorize = new URL(`${origin}/oauth/authorize`);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: MCP_TEST_REDIRECT,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    scope: input.scope,
    resource: `${origin}/mcp`,
  })) {
    authorize.searchParams.set(key, value);
  }

  const response = await worker.fetch(
    new Request(authorize, { headers: { cookie }, redirect: "manual" })
  );

  const location = required(
    response.headers.get("location"),
    "the authorization redirects to consent"
  );

  expect(location).toMatch(/^\/oidc\/consent\//u);

  return {
    clientId,
    requestId: required(location.split("/").at(-1), "the consent request id"),
  };
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  adminCookie = sessionCookie(bootstrap);

  const invited = await worker.fetch(
    new Request(`${origin}/api/admin/invitations`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ name: "Member", email: "member@example.test" }),
    })
  );

  memberId = (
    await readJson(
      invited,
      z.object({ accessLink: z.looseObject({ userId: z.string() }) })
    )
  ).accessLink.userId;
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(memberId)
    .run();

  const login = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: memberId }),
    })
  );

  memberCookie = sessionCookie(login);
});

describe("OAuth scopes", () => {
  it("give an app only what it asked for, route by route and tool by tool", async () => {
    const reader = await mcpAccessToken(adminCookie, { scope: "mail.read" });
    expect(reader.scope).toBe("mail.read");
    expect(reader.refreshToken).toBeUndefined();

    const mailboxes = await api(reader.accessToken, "/api/mail/mailboxes");
    expect(mailboxes.status).toBe(200);

    const {
      mailboxes: [listed],
    } = await readJson(
      mailboxes,
      z.object({ mailboxes: z.array(z.looseObject({ id: z.string() })) })
    );

    const mailbox = required(listed, "the admin has a mailbox");

    const send = await api(reader.accessToken, "/api/mail/messages", {
      method: "POST",
      json: {
        mailboxId: mailbox.id,
        to: ["someone@example.net"],
        subject: "Hi",
        bodyText: "Hi",
      },
    });

    expect(send.status).toBe(403);
    expect(send.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="mail.send"'
    );

    const folder = await api(
      reader.accessToken,
      `/api/mail/mailboxes/${mailbox.id}/folders`,
      {
        method: "POST",
        json: { name: "Nope" },
      }
    );

    expect(folder.status).toBe(403);

    // Administration needs its own scopes, even for an administrator.
    await Promise.all(
      [
        "/api/admin/state",
        "/api/admin/webhooks",
        "/api/admin/blocked-senders",
      ].map(async (path) => {
        const response = await api(reader.accessToken, path);
        expect(response.status, path).toBe(403);
        await response.body?.cancel();
      })
    );

    const tools = await toolNames(reader.accessToken);
    expect(tools).toContain("list_mailboxes");
    expect(tools).toContain("get_conversation");
    expect(tools).not.toContain("send_email");
    expect(tools).not.toContain("create_folder");
    expect(tools).not.toContain("get_administration");
  });

  it("keep the dangerous administration apart from the rest", async () => {
    const people = await mcpAccessToken(adminCookie, {
      scope: "admin.people people.read",
    });

    const rename = await api(
      people.accessToken,
      `/api/admin/users/${memberId}`,
      { method: "PATCH", json: { name: "Renamed" } }
    );

    expect(rename.status).toBe(200);
    await rename.body?.cancel();

    // Each is refused, so none changes what the others see.
    await Promise.all(
      (
        [
          ["PATCH", `/api/admin/users/${memberId}`, { role: "admin" }],
          [
            "PATCH",
            `/api/admin/users/${memberId}`,
            { permissions: ["manage_people"] },
          ],
          ["POST", `/api/admin/users/${memberId}/access-link`, undefined],
        ] as const
      ).map(async ([method, path, json]) => {
        const response = await api(people.accessToken, path, { method, json });
        expect(response.status, `${method} ${path}`).toBe(403);
        await response.body?.cancel();
      })
    );

    expect(await toolNames(people.accessToken)).not.toContain(
      "create_user_access_link"
    );

    const access = await mcpAccessToken(adminCookie, {
      scope: "admin.people admin.access",
    });

    const link = await api(
      access.accessToken,
      `/api/admin/users/${memberId}/access-link`,
      { method: "POST" }
    );

    expect(link.status).toBe(201);
    await link.body?.cancel();
    expect(await toolNames(access.accessToken)).toContain(
      "create_user_access_link"
    );
  });

  it("show on consent what the person may not grant, and leave it out", async () => {
    const { requestId } = await startConsent(memberCookie, {
      scope: "mail.read admin.people admin.access offline_access",
    });

    const view = await worker.fetch(
      new Request(`${origin}/api/oidc/consent/${requestId}`, {
        headers: { cookie: memberCookie },
      })
    );

    const { request } = await readJson(view, consentView);
    expect(request.scopes.map((scope) => scope.id)).toEqual([
      "offline_access",
      "mail.read",
    ]);
    expect(request.unavailableScopes).toEqual([
      expect.objectContaining({ id: "admin.people", group: "administration" }),
      expect.objectContaining({
        id: "admin.access",
        group: "administration",
        dangerous: true,
      }),
    ]);

    const approved = await worker.fetch(
      new Request(`${origin}/api/oidc/consent/${requestId}`, {
        method: "POST",
        headers: {
          cookie: memberCookie,
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({ approved: true }),
      })
    );

    expect(approved.status).toBe(200);
    await approved.body?.cancel();

    const grant = await env.DB.prepare(
      "SELECT scopes FROM oidc_grants WHERE user_id = ? ORDER BY granted_at DESC"
    )
      .bind(memberId)
      .first<{ scopes: string }>();

    const grantedScopes = z
      .array(z.string())
      .parse(JSON.parse(required(grant, "the approval stores a grant").scopes));

    expect(grantedScopes.sort()).toEqual(["mail.read", "offline_access"]);

    // The administrator sees the dangerous scope set apart, and who publishes the app.
    const metadataClient = "https://agent.example/oauth/client.json";

    const { requestId: adminRequest } =
      await startConsentForMetadataClient(metadataClient);

    const adminView = await worker.fetch(
      new Request(`${origin}/api/oidc/consent/${adminRequest}`, {
        headers: { cookie: adminCookie },
      })
    );

    const { request: shown } = await readJson(adminView, consentView);

    expect(shown).toMatchObject({
      clientHost: "agent.example",
      redirectHost: "127.0.0.1:33418",
      redirectElsewhere: true,
      unavailableScopes: [],
    });
    expect(shown.scopes).toContainEqual(
      expect.objectContaining({ id: "admin.access", dangerous: true })
    );
  });

  it("bind each token to its resource", async () => {
    const mcp = await mcpAccessToken(adminCookie, {
      scope: "mail.read offline_access",
    });

    const jmap = await mcpAccessToken(adminCookie, {
      scope: "mail.read offline_access",
      resource: `${origin}/jmap`,
    });

    const jmapAtMcp = await toolNames(jmap.accessToken);
    expect(jmapAtMcp).toBe(401);
    const jmapAtApi = await api(jmap.accessToken, "/api/mail/mailboxes");
    expect(jmapAtApi.status).toBe(401);
    await jmapAtApi.body?.cancel();
    const mcpAtJmap = await api(mcp.accessToken, "/jmap/session");
    expect(mcpAtJmap.status).toBe(401);
    await mcpAtJmap.body?.cancel();
    const jmapAtJmap = await api(jmap.accessToken, "/jmap/session");
    expect(jmapAtJmap.status).toBe(200);
    await jmapAtJmap.body?.cancel();

    // A refresh keeps the resource; asking for another one is refused.
    const refresh = (resource: string) =>
      worker.fetch(
        new Request(`${origin}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: required(
              jmap.refreshToken,
              "offline_access gives a refresh token"
            ),
            client_id: jmap.clientId,
            resource,
          }),
        })
      );

    const elsewhere = await refresh(`${origin}/mcp`);
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.json()).toMatchObject({ error: "invalid_target" });
    const same = await refresh(`${origin}/jmap`);
    expect(same.status).toBe(200);

    const refreshed = await readJson(
      same,
      z.looseObject({ access_token: z.string() })
    );

    expect((await api(refreshed.access_token, "/jmap/session")).status).toBe(
      200
    );
  });

  it("let JMAP methods run only with their scope", async () => {
    const reader = await mcpAccessToken(adminCookie, {
      scope: "mail.read",
      resource: `${origin}/jmap`,
    });

    const session = await readJson(
      await api(reader.accessToken, "/jmap/session"),
      z.looseObject({ primaryAccounts: z.record(z.string(), z.string()) })
    );

    const accountId = required(
      session.primaryAccounts["urn:ietf:params:jmap:mail"],
      "the session names a mail account"
    );

    const response = await api(reader.accessToken, "/jmap/api", {
      method: "POST",
      json: {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          ["Mailbox/get", { accountId }, "a"],
          [
            "Email/set",
            { accountId, update: { missing: { keywords: { $seen: true } } } },
            "b",
          ],
        ],
      },
    });

    const body = await readJson(
      response,
      z.looseObject({
        methodResponses: z.array(
          z.tuple([z.string(), z.looseObject({}), z.string()])
        ),
      })
    );

    const [mailboxGet] = body.methodResponses;
    expect(required(mailboxGet, "Mailbox/get answers")[0]).toBe("Mailbox/get");
    expect(body.methodResponses[1]).toEqual([
      "error",
      expect.objectContaining({ type: "forbidden" }),
      "b",
    ]);

    const upload = await api(reader.accessToken, `/jmap/upload/${accountId}`, {
      method: "POST",
    });

    expect(upload.status).toBe(403);
    await upload.body?.cancel();
  });

  it("give a self-registered app reading mail when it asks for nothing", async () => {
    const quiet = await mcpAccessToken(adminCookie);
    expect(quiet.scope).toBe("mail.read offline_access");
  });
});

async function startConsentForMetadataClient(clientId: string) {
  const { internet } = await import("@open-workspace/core/testing");
  internet.handle((request) =>
    request.target.hostname === "agent.example"
      ? Response.json({
          client_id: clientId,
          client_name: "Example Agent",
          redirect_uris: [MCP_TEST_REDIRECT],
        })
      : undefined
  );

  return startConsent(adminCookie, {
    clientId,
    scope: "mail.read admin.access",
  });
}
