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

let cookie = "";

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

const oauthError = z.object({
  error: z.string(),
  error_description: z.string(),
});

/** What a client sends to /oauth/register, valid or not (RFC 7591). */
type ClientMetadata = {
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
};

async function mcpStatus(token: string) {
  const response = await worker.fetch(
    new Request(`${MCP_TEST_ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
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
              name: "oauth-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    })
  );

  await response.body?.cancel();

  return response.status;
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${MCP_TEST_ORIGIN}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OAuth Admin",
        email: "oauth@example.test",
      }),
    })
  );

  expect(bootstrap.status).toBe(200);
  cookie = sessionCookie(bootstrap);
});

describe("MCP OAuth clients", () => {
  it("rejects registrations an MCP client could not use safely", async () => {
    const register = (body: ClientMetadata) =>
      worker.fetch(
        new Request(`${MCP_TEST_ORIGIN}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );

    const refusals: ClientMetadata[] = [
      {},
      { redirect_uris: ["http://agent.example/callback"] },
      {
        redirect_uris: [MCP_TEST_REDIRECT],
        token_endpoint_auth_method: "client_secret_basic",
      },
      { redirect_uris: [MCP_TEST_REDIRECT], scope: "openid email" },
    ];

    // Each is refused, so none registers a client the others could see.
    await Promise.all(
      refusals.map(async (body) => {
        const response = await register(body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: "invalid_client_metadata",
        });
      })
    );
  });

  it("refreshes tokens and keeps workspace scopes away from apps not allowed them", async () => {
    const signedIn = await mcpAccessToken(cookie, {
      scope: "people.read offline_access",
    });

    expect(await mcpStatus(signedIn.accessToken)).toBe(200);

    const refreshed = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: required(
            signedIn.refreshToken,
            "offline_access gives a refresh token"
          ),
          client_id: signedIn.clientId,
          resource: `${MCP_TEST_ORIGIN}/mcp`,
        }),
      })
    );

    const text = await refreshed.text();
    expect(refreshed.status, text).toBe(200);
    const body = tokenResponse.parse(JSON.parse(text));
    expect(await mcpStatus(body.access_token)).toBe(200);

    // A token for an ordinary SSO app is not an MCP token.
    const created = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/api/admin/oidc-clients`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: MCP_TEST_ORIGIN,
        },
        body: JSON.stringify({
          name: "Wiki",
          clientType: "public",
          accessTeams: [{ teamId: "team_everyone" }],
          redirectUris: [MCP_TEST_REDIRECT],
          postLogoutRedirectUris: [],
          allowedOrigins: [],
          allowedScopes: ["openid", "profile"],
          trusted: true,
          enabled: true,
        }),
      })
    );

    const createdText = await created.text();
    expect(created.status, createdText).toBe(201);

    const app = z
      .object({ clientId: z.string() })
      .parse(JSON.parse(createdText));

    const authorize = new URL(`${MCP_TEST_ORIGIN}/oauth/authorize`);

    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: app.clientId,
      redirect_uri: MCP_TEST_REDIRECT,
      code_challenge: "b".repeat(43),
      code_challenge_method: "S256",
      scope: "openid people.read",
    })) {
      authorize.searchParams.set(key, value);
    }

    const denied = await worker.fetch(
      new Request(authorize, { headers: { cookie }, redirect: "manual" })
    );

    expect(
      new URL(
        required(denied.headers.get("location"), "authorize redirects")
      ).searchParams.get("error")
    ).toBe("invalid_scope");

    // Self-registered clients do not show up among the administrator's SSO apps.
    const state = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/api/admin/state`, { headers: { cookie } })
    );

    const clients = z
      .object({ oidcClients: z.array(z.object({ id: z.string() })) })
      .parse(await state.json())
      .oidcClients.map((item) => item.id);

    expect(clients).toContain(app.clientId);
    expect(clients).not.toContain(signedIn.clientId);
  });

  it("accepts a client identified by its metadata document URL", async () => {
    const clientId = "https://agent.example/oauth/client.json";
    // The client's host, as the Worker reaches it.
    internet.handle((request) =>
      request.target.hostname === "agent.example"
        ? Response.json({
            client_id: clientId,
            client_name: "Example Agent",
            redirect_uris: [MCP_TEST_REDIRECT],
          })
        : undefined
    );
    const signedIn = await mcpAccessToken(cookie, { clientId });
    expect(await mcpStatus(signedIn.accessToken)).toBe(200);
    // Cached for a day: the token exchange did not fetch the document again.
    expect(internet.requests.map((request) => request.url)).toEqual([clientId]);

    const connectedApps = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/api/auth/connected-apps`, {
        headers: { cookie },
      })
    );

    expect(await connectedApps.json()).toMatchObject({
      apps: expect.arrayContaining([
        expect.objectContaining({
          clientId,
          name: "Example Agent",
          registration: "metadata_document",
          host: "agent.example",
        }),
      ]),
    });

    // A document that names a different client is refused.
    const impostor = "https://impostor.example/client.json";
    internet.handle((request) =>
      request.target.hostname === "impostor.example"
        ? Response.json({
            client_id: clientId,
            redirect_uris: [MCP_TEST_REDIRECT],
          })
        : undefined
    );
    const authorize = new URL(`${MCP_TEST_ORIGIN}/oauth/authorize`);

    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: impostor,
      redirect_uri: MCP_TEST_REDIRECT,
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    })) {
      authorize.searchParams.set(key, value);
    }

    const refused = await worker.fetch(
      new Request(authorize, { headers: { cookie }, redirect: "manual" })
    );

    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "invalid_client" });
  });

  it("fetches metadata documents only from named hosts on 443, bounded and without echoing them", async () => {
    const authorize = async (clientId: string) => {
      const url = new URL(`${MCP_TEST_ORIGIN}/oauth/authorize`);

      for (const [key, value] of Object.entries({
        response_type: "code",
        client_id: clientId,
        redirect_uri: MCP_TEST_REDIRECT,
        code_challenge: "d".repeat(43),
        code_challenge_method: "S256",
      })) {
        url.searchParams.set(key, value);
      }

      const response = await worker.fetch(
        new Request(url, { headers: { cookie }, redirect: "manual" })
      );

      return {
        status: response.status,
        body: oauthError.parse(await response.json()),
      };
    };

    // Another port, or an address instead of a name: not a metadata document client, so unknown.
    await Promise.all(
      [
        "https://agent.example:8443/client.json",
        "https://203.0.113.9/client.json",
        "https://[2001:db8::1]/client.json",
      ].map(async (clientId) => {
        const refused = await authorize(clientId);
        expect(refused.status, clientId).toBe(400);
        expect(refused.body.error).toBe("invalid_request");
      })
    );

    expect(internet.requests).toEqual([]);

    const big = "https://big.example/client.json";
    const failing = "https://failing.example/client.json";
    internet.handle((request) => {
      if (request.url === big) {
        // No length header: the body is counted as it streams in.
        const chunk = new TextEncoder().encode(" ".repeat(4096));
        let sent = 0;

        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent++ >= 64) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { headers: { "content-type": "application/json" } }
        );
      }

      if (request.url === failing) {
        return new Response("secret upstream detail", { status: 418 });
      }

      return undefined;
    });
    const tooLarge = await authorize(big);
    expect(tooLarge.status).toBe(401);
    expect(tooLarge.body.error_description).toBe(
      "The client metadata document is too large"
    );
    const failed = await authorize(failing);
    expect(failed.status).toBe(401);
    expect(failed.body.error_description).toBe(
      "The client metadata document could not be fetched"
    );
    expect(JSON.stringify(failed.body)).not.toContain("418");
  });

  it("ends sign-ins in progress when a person disconnects an app", async () => {
    const { client_id: clientId } = await registerMcpClient("Disconnected");
    await mcpAccessToken(cookie, {
      clientId,
      scope: "people.read offline_access",
    });
    // Started again and left at the consent screen.
    const url = new URL(`${MCP_TEST_ORIGIN}/oauth/authorize`);

    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: MCP_TEST_REDIRECT,
      code_challenge: "e".repeat(43),
      code_challenge_method: "S256",
      scope: "people.read",
    })) {
      url.searchParams.set(key, value);
    }

    const pending = await worker.fetch(
      new Request(url, { headers: { cookie }, redirect: "manual" })
    );

    const requestId = required(
      pending.headers.get("location")?.split("/").at(-1),
      "authorize redirects to the consent page"
    );

    const user = required(
      await env.DB.prepare(
        "SELECT user_id FROM oidc_grants WHERE client_id = ?"
      )
        .bind(clientId)
        .first<{ user_id: string }>(),
      "signing in granted the app"
    );

    await env.DB.prepare(`INSERT INTO oidc_authorization_codes (token_hash, client_id, user_id, redirect_uri, scopes, code_challenge, auth_time, expires_at, created_at)
      VALUES ('pending-code', ?, ?, ?, '["people.read"]', 'x', ?, ?, ?)`)
      .bind(
        clientId,
        user.user_id,
        MCP_TEST_REDIRECT,
        Date.now(),
        Date.now() + 60_000,
        Date.now()
      )
      .run();

    const disconnected = await worker.fetch(
      new Request(
        `${MCP_TEST_ORIGIN}/api/auth/connected-apps/${encodeURIComponent(clientId)}`,
        {
          method: "DELETE",
          headers: { cookie, origin: MCP_TEST_ORIGIN },
        }
      )
    );

    expect(disconnected.status).toBe(200);

    const remaining = await Promise.all(
      [
        "oidc_grants",
        "oidc_access_tokens",
        "oidc_refresh_tokens",
        "oidc_authorization_codes",
        "oidc_authorization_requests",
      ].map(async (table) => ({
        table,
        rows: await env.DB.prepare(
          `SELECT count(*) AS n FROM ${table} WHERE client_id = ?`
        )
          .bind(clientId)
          .first("n"),
      }))
    );

    for (const { table, rows } of remaining) expect(rows, table).toBe(0);

    const approve = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/api/oidc/consent/${requestId}`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: MCP_TEST_ORIGIN,
        },
        body: JSON.stringify({ approved: true }),
      })
    );

    expect(approve.status).toBe(400);
  });

  it("forgets registrations nobody approved", async () => {
    const { client_id: abandoned } = await registerMcpClient("Abandoned");
    await env.DB.prepare("UPDATE oidc_clients SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 2 * 24 * 60 * 60 * 1000, abandoned)
      .run();
    await hooks.call("oidc.cleanupExpiredArtifacts");

    const row = await env.DB.prepare("SELECT id FROM oidc_clients WHERE id = ?")
      .bind(abandoned)
      .first();

    expect(row).toBeNull();
  });
});
