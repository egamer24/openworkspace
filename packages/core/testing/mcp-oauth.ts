import { expect } from "bun:test";

import { z } from "zod";

import { required } from "../shared/invariant.ts";
import { worker } from "./client.ts";

export const MCP_TEST_ORIGIN = "http://example.test";
export const MCP_TEST_REDIRECT = "http://127.0.0.1:33418/callback";

function base64Url(bytes: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
}

export async function pkcePair() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));

  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  );

  return { verifier, challenge };
}

export async function registerMcpClient(name = "Test agent") {
  const response = await worker.fetch(
    new Request(`${MCP_TEST_ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [MCP_TEST_REDIRECT],
      }),
    })
  );

  expect(response.status).toBe(201);

  return z.object({ client_id: z.string() }).parse(await response.json());
}

/**
 * Signs an MCP client in the way a real one does: register, authorize with
 * PKCE and a resource indicator, approve consent as the session's user, and
 * exchange the code.
 */
export async function mcpAccessToken(
  cookie: string,
  options: { clientId?: string; scope?: string; resource?: string } = {}
) {
  const clientId = options.clientId ?? (await registerMcpClient()).client_id;
  const pkce = await pkcePair();
  const authorize = new URL(`${MCP_TEST_ORIGIN}/oauth/authorize`);

  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: MCP_TEST_REDIRECT,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    resource: options.resource ?? `${MCP_TEST_ORIGIN}/mcp`,
    state: "test-state",
  }).toString();

  // Without a scope the workspace's default for self-registered apps applies.
  if (options.scope !== undefined) {
    authorize.searchParams.set("scope", options.scope);
  }

  const authorizeResponse = await worker.fetch(
    new Request(authorize, { headers: { cookie }, redirect: "manual" })
  );

  const location = authorizeResponse.headers.get("location") ?? "";
  let callback: URL;
  const consent = location.match(/\/oidc\/consent\/([^/?#]+)/u)?.[1];

  if (consent) {
    const approved = await worker.fetch(
      new Request(`${MCP_TEST_ORIGIN}/api/oidc/consent/${consent}`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: MCP_TEST_ORIGIN,
        },
        body: JSON.stringify({ approved: true }),
      })
    );

    expect(approved.status).toBe(200);
    callback = new URL(
      z.object({ redirectTo: z.string() }).parse(await approved.json())
        .redirectTo
    );
  } else {
    callback = new URL(location);
  }

  // RFC 9207: the response names the issuer the client started with.
  expect(callback.searchParams.get("iss")).toBe(MCP_TEST_ORIGIN);
  const code = callback.searchParams.get("code");
  expect(code, callback.toString()).toBeTruthy();

  const token = await worker.fetch(
    new Request(`${MCP_TEST_ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: required(code, "the authorization redirect carries a code"),
        redirect_uri: MCP_TEST_REDIRECT,
        code_verifier: pkce.verifier,
        client_id: clientId,
        resource: options.resource ?? `${MCP_TEST_ORIGIN}/mcp`,
      }),
    })
  );

  const answer = await token.text();
  expect(token.status, answer).toBe(200);

  const body = z
    .object({
      access_token: z.string(),
      refresh_token: z.string().optional(),
      scope: z.string(),
      id_token: z.string().optional(),
    })
    .parse(JSON.parse(answer));

  return {
    clientId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope,
    idToken: body.id_token,
  };
}
