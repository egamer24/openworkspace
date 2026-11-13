import { beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";
import { internet } from "../../testing/internet.ts";
import {
  mcpAccessToken,
  MCP_TEST_ORIGIN,
  MCP_TEST_REDIRECT,
  registerMcpClient,
} from "../../testing/mcp-oauth.ts";

useFreshWorkspace();

const origin = MCP_TEST_ORIGIN;
let adminCookie = "";
let managerCookie = "";
let managerId = "";

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

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

/** 200 when the token still works at the API behind /mcp. */
async function tokenStatus(token: string) {
  const response = await worker.fetch(
    new Request(`${origin}/api/admin/state`, {
      headers: { authorization: `Bearer ${token}` },
    })
  );

  await response.body?.cancel();

  return response.status;
}

const listingSchema = z.object({
  allowSelfRegistration: z.boolean(),
  clients: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      host: z.string(),
      enabled: z.boolean(),
      registration: z.string(),
      connections: z.array(
        z.object({
          userId: z.string(),
          name: z.string(),
          scopes: z.array(z.object({ id: z.string() })),
        })
      ),
    })
  ),
});

const invitation = z.object({
  accessLink: z.object({ userId: z.string() }),
});

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

async function listing() {
  const response = await call(adminCookie, "/api/admin/mcp-clients");
  expect(response.status).toBe(200);

  return listingSchema.parse(await response.json());
}

function authorizeUrl(clientId: string) {
  const url = new URL(`${origin}/oauth/authorize`);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: MCP_TEST_REDIRECT,
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    scope: "people.read",
  })) {
    url.searchParams.set(key, value);
  }

  return url;
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

  const invited = await call(adminCookie, "/api/admin/invitations", {
    method: "POST",
    json: { name: "People manager", email: "manager@example.test" },
  });

  managerId = invitation.parse(await invited.json()).accessLink.userId;
  await env.DB.prepare(
    "UPDATE users SET status = 'active', permissions = '[\"manage_people\"]' WHERE id = ?"
  )
    .bind(managerId)
    .run();

  const login = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: managerId }),
    })
  );

  managerCookie = sessionCookie(login);
});

describe("connected apps in administration", () => {
  it("lists self-registered apps with who connected them and what they may do", async () => {
    const { client_id: clientId } = await registerMcpClient("Agent");
    await mcpAccessToken(adminCookie, {
      clientId,
      scope: "people.read offline_access",
    });
    await mcpAccessToken(managerCookie, {
      clientId,
      scope: "people.read admin.people",
    });

    const { clients, allowSelfRegistration } = await listing();
    expect(allowSelfRegistration).toBe(true);

    const app = required(
      clients.find((item) => item.id === clientId),
      "the registered app is listed"
    );

    expect(app).toMatchObject({
      name: "Agent",
      host: "127.0.0.1:33418",
      enabled: true,
      registration: "dynamic",
    });
    expect(
      app.connections
        .map((connection) => [
          connection.name,
          connection.scopes.map((scope) => scope.id),
        ])
        .sort()
    ).toEqual([
      ["Admin", ["offline_access", "people.read"]],
      ["People manager", ["people.read", "admin.people"]],
    ]);

    // Administrators only; an app needs admin.workspace for it.
    const delegated = await call(managerCookie, "/api/admin/mcp-clients");
    expect(delegated.status).toBe(403);
    await delegated.body?.cancel();
    const narrow = await mcpAccessToken(adminCookie, { scope: "people.read" });

    const narrowList = await worker.fetch(
      new Request(`${origin}/api/admin/mcp-clients`, {
        headers: { authorization: `Bearer ${narrow.accessToken}` },
      })
    );

    expect(narrowList.status).toBe(403);
    await narrowList.body?.cancel();

    const wide = await mcpAccessToken(adminCookie, {
      scope: "admin.workspace",
    });

    const wideList = await worker.fetch(
      new Request(`${origin}/api/admin/mcp-clients`, {
        headers: { authorization: `Bearer ${wide.accessToken}` },
      })
    );

    expect(wideList.status).toBe(200);
    await wideList.body?.cancel();
  });

  it("disconnects one person, or turns an app off for everyone", async () => {
    const { client_id: clientId } = await registerMcpClient("Two-person agent");

    const admin = await mcpAccessToken(adminCookie, {
      clientId,
      scope: "people.read",
    });

    const manager = await mcpAccessToken(managerCookie, {
      clientId,
      scope: "people.read",
    });

    // A sign-in in progress for the manager, which disconnecting ends too.
    const pending = await worker.fetch(
      new Request(authorizeUrl(clientId), {
        headers: { cookie: managerCookie },
      })
    );

    expect(pending.headers.get("location")).toMatch(/^\/oidc\/consent\//u);

    const cut = await call(
      adminCookie,
      `/api/admin/mcp-clients/${encodeURIComponent(clientId)}/connections/${managerId}`,
      { method: "DELETE" }
    );

    expect(cut.status).toBe(200);
    await cut.body?.cancel();
    expect(await tokenStatus(manager.accessToken)).toBe(401);
    expect(await tokenStatus(admin.accessToken)).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM oidc_authorization_requests WHERE client_id = ? AND user_id = ?"
      )
        .bind(clientId, managerId)
        .first("n")
    ).toBe(0);

    const off = await call(
      adminCookie,
      `/api/admin/mcp-clients/${encodeURIComponent(clientId)}`,
      { method: "PATCH", json: { enabled: false } }
    );

    expect(off.status).toBe(200);
    await off.body?.cancel();
    expect(await tokenStatus(admin.accessToken)).toBe(401);

    const refused = await worker.fetch(
      new Request(authorizeUrl(clientId), { headers: { cookie: adminCookie } })
    );

    expect(refused.status).toBeGreaterThanOrEqual(400);
    await refused.body?.cancel();
    expect(
      (await listing()).clients.find((item) => item.id === clientId)
    ).toMatchObject({ enabled: false, connections: [] });

    // Cleaning up abandoned registrations keeps it, so it stays off.
    await env.DB.prepare("UPDATE oidc_clients SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 3 * 86_400_000, clientId)
      .run();
    await hooks.call("oidc.cleanupExpiredArtifacts");
    expect(
      await env.DB.prepare("SELECT enabled FROM oidc_clients WHERE id = ?")
        .bind(clientId)
        .first("enabled")
    ).toBe(0);

    const on = await call(
      adminCookie,
      `/api/admin/mcp-clients/${encodeURIComponent(clientId)}`,
      { method: "PATCH", json: { enabled: true } }
    );

    expect(on.status).toBe(200);
    await on.body?.cancel();
    expect(
      (await mcpAccessToken(adminCookie, { clientId, scope: "people.read" }))
        .accessToken
    ).toBeTruthy();
  });

  it("refuses apps that register themselves while that is turned off", async () => {
    const { client_id: existing } = await registerMcpClient("Before");
    const metadataClient = "https://agent.example/oauth/client.json";
    internet.handle((request) =>
      request.target.hostname === "agent.example"
        ? Response.json({
            client_id: metadataClient,
            client_name: "Example Agent",
            redirect_uris: [MCP_TEST_REDIRECT],
          })
        : undefined
    );

    const off = await call(adminCookie, "/api/admin/mcp-clients/registration", {
      method: "PUT",
      json: { allowed: false },
    });

    expect(off.status).toBe(200);
    await off.body?.cancel();
    expect((await listing()).allowSelfRegistration).toBe(false);

    const register = await worker.fetch(
      new Request(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "After",
          redirect_uris: [MCP_TEST_REDIRECT],
        }),
      })
    );

    expect(register.status).toBe(403);
    expect(await register.json()).toMatchObject({ error: "access_denied" });

    await Promise.all(
      [existing, metadataClient].map(async (clientId) => {
        const response = await worker.fetch(
          new Request(authorizeUrl(clientId), {
            headers: { cookie: adminCookie },
          })
        );

        expect(response.status, clientId).toBe(403);
        await response.body?.cancel();
      })
    );

    // The document was not even fetched.
    expect(internet.requests).toEqual([]);

    const on = await call(adminCookie, "/api/admin/mcp-clients/registration", {
      method: "PUT",
      json: { allowed: true },
    });

    expect(on.status).toBe(200);
    await on.body?.cancel();
    expect(
      (
        await mcpAccessToken(adminCookie, {
          clientId: metadataClient,
          scope: "people.read",
        })
      ).accessToken
    ).toBeTruthy();
  });
});
