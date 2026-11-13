import { beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";
import { internet } from "../../testing/internet.ts";
import type { createOidcClientSchema } from "../../worker/admin/schemas.ts";

useFreshWorkspace();

const origin = "http://example.test";
const redirectUri = "https://rp.example.test/callback";
let adminCookie = "";
let appManagerCookie = "";

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

/** An OIDC client as the admin API takes it. */
type ClientInput = z.input<typeof createOidcClientSchema>;

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

function clientInput(overrides: Partial<ClientInput> = {}): ClientInput {
  return {
    name: "Wiki",
    clientType: "public",
    accessTeams: [{ teamId: "team_everyone", sentAs: null }],
    redirectUris: [redirectUri],
    postLogoutRedirectUris: [],
    allowedOrigins: [],
    allowedScopes: ["openid", "profile"],
    trusted: false,
    enabled: true,
    ...overrides,
  };
}

const createdClient = z.object({ clientId: z.string() });

async function createClient(
  cookie: string,
  overrides: Partial<ClientInput> = {}
) {
  const response = await call(cookie, "/api/admin/oidc-clients", {
    method: "POST",
    json: clientInput(overrides),
  });

  if (response.status !== 201) {
    await response.body?.cancel();

    return { status: response.status, clientId: "" };
  }

  return {
    status: response.status,
    clientId: createdClient.parse(await response.json()).clientId,
  };
}

function authorizeUrl(
  clientId: string,
  scope: string,
  extra: Record<string, string> = {}
) {
  const url = new URL(`${origin}/oauth/authorize`);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    scope,
    state: "s",
    ...extra,
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

  expect(bootstrap.status).toBe(200);
  adminCookie = sessionCookie(bootstrap);

  const invited = await call(adminCookie, "/api/admin/invitations", {
    method: "POST",
    json: { name: "App manager", email: "apps@example.test" },
  });

  const { accessLink } = z
    .object({ accessLink: z.object({ userId: z.string() }) })
    .parse(await invited.json());

  await env.DB.prepare(
    "UPDATE users SET status = 'active', permissions = '[\"manage_apps\"]' WHERE id = ?"
  )
    .bind(accessLink.userId)
    .run();

  const login = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: accessLink.userId }),
    })
  );

  appManagerCookie = sessionCookie(login);
});

describe("what an app manager may give an app", () => {
  it("leaves skipping consent and workspace access to administrators", async () => {
    expect(
      (await createClient(appManagerCookie, { trusted: true })).status
    ).toBe(403);
    expect(
      (
        await createClient(appManagerCookie, {
          allowedScopes: ["openid", "people.read"],
        })
      ).status
    ).toBe(403);
    const plain = await createClient(appManagerCookie);
    expect(plain.status).toBe(201);

    // Both are refused, so neither changes the client the other edits.
    await Promise.all(
      [
        { trusted: true },
        { allowedScopes: ["openid", "profile", "people.read"] },
      ].map(async (change) => {
        const response = await call(
          appManagerCookie,
          `/api/admin/oidc-clients/${plain.clientId}`,
          {
            method: "PATCH",
            json: clientInput(change),
          }
        );

        expect(response.status).toBe(403);
        await response.body?.cancel();
      })
    );

    // What an administrator gave the app may stay when an app manager edits the rest.
    const trusted = await createClient(adminCookie, {
      trusted: true,
      allowedScopes: ["openid", "profile", "people.read"],
    });

    expect(trusted.status).toBe(201);

    const renamed = await call(
      appManagerCookie,
      `/api/admin/oidc-clients/${trusted.clientId}`,
      {
        method: "PATCH",
        json: clientInput({
          name: "Renamed",
          trusted: true,
          allowedScopes: ["openid", "profile", "people.read"],
        }),
      }
    );

    expect(renamed.status).toBe(200);
    await renamed.body?.cancel();
  });
});

describe("consent for workspace access", () => {
  it("is always asked, even for a trusted app and with prompt=none", async () => {
    const { clientId, status } = await createClient(adminCookie, {
      name: "Trusted mail app",
      trusted: true,
      allowedScopes: ["openid", "profile", "people.read"],
    });

    expect(status).toBe(201);

    // Identity alone skips consent for a trusted app.
    const identity = await worker.fetch(
      new Request(authorizeUrl(clientId, "openid profile"), {
        headers: { cookie: adminCookie },
      })
    );

    expect(
      new URL(
        required(identity.headers.get("location"), "authorize redirects")
      ).searchParams.get("code")
    ).toBeTruthy();

    const mail = await worker.fetch(
      new Request(authorizeUrl(clientId, "openid people.read"), {
        headers: { cookie: adminCookie },
      })
    );

    expect(mail.headers.get("location")).toMatch(/^\/oidc\/consent\//u);

    const silent = await worker.fetch(
      new Request(
        authorizeUrl(clientId, "openid people.read", { prompt: "none" }),
        { headers: { cookie: adminCookie } }
      )
    );

    expect(
      new URL(
        required(silent.headers.get("location"), "authorize redirects")
      ).searchParams.get("error")
    ).toBe("consent_required");

    // A remembered approval does not cover workspace access either.
    const consent = required(
      mail.headers.get("location")?.split("/").at(-1),
      "authorize redirects to a consent page"
    );

    const approved = await call(adminCookie, `/api/oidc/consent/${consent}`, {
      method: "POST",
      json: { approved: true },
    });

    expect(approved.status).toBe(200);
    await approved.body?.cancel();

    const again = await worker.fetch(
      new Request(authorizeUrl(clientId, "openid people.read"), {
        headers: { cookie: adminCookie },
      })
    );

    expect(again.headers.get("location")).toMatch(/^\/oidc\/consent\//u);
  });
});

describe("SCIM tokens", () => {
  it("are only sent to the server they were entered for", async () => {
    const { clientId } = await createClient(adminCookie, {
      name: "Provisioned app",
    });

    internet.handle((request) =>
      request.target.hostname.endsWith(".example.net")
        ? Response.json({ Resources: [], totalResults: 0 })
        : undefined
    );

    const saved = await call(
      adminCookie,
      `/api/admin/oidc-clients/${clientId}/provisioning`,
      {
        method: "PUT",
        json: {
          enabled: false,
          baseUrl: "https://scim.example.net/scim/v2",
          token: "saved-secret",
        },
      }
    );

    expect(saved.status).toBe(200);
    await saved.body?.cancel();

    // The same server may keep the saved token.
    const samePlace = await call(
      adminCookie,
      `/api/admin/oidc-clients/${clientId}/provisioning`,
      {
        method: "PUT",
        json: { enabled: false, baseUrl: "https://scim.example.net/v2" },
      }
    );

    expect(samePlace.status).toBe(200);
    await samePlace.body?.cancel();

    // Another server needs its own, for saving and for testing alike.
    const moved = await call(
      adminCookie,
      `/api/admin/oidc-clients/${clientId}/provisioning`,
      {
        method: "PUT",
        json: {
          enabled: false,
          baseUrl: "https://attacker.example.net/scim/v2",
        },
      }
    );

    expect(moved.status).toBe(400);
    await moved.body?.cancel();

    const probe = await call(
      adminCookie,
      `/api/admin/oidc-clients/${clientId}/provisioning/test`,
      {
        method: "POST",
        json: { baseUrl: "https://attacker.example.net/scim/v2" },
      }
    );

    expect(probe.status).toBe(400);
    await probe.body?.cancel();
    expect(
      internet.requests.some((request) =>
        request.headers.get("authorization")?.includes("saved-secret")
      )
    ).toBe(false);

    const stored = await env.DB.prepare(
      "SELECT base_url, token FROM scim_connections"
    ).first();

    expect(stored).toEqual({
      base_url: "https://scim.example.net/v2",
      token: "saved-secret",
    });

    const replaced = await call(
      adminCookie,
      `/api/admin/oidc-clients/${clientId}/provisioning`,
      {
        method: "PUT",
        json: {
          enabled: false,
          baseUrl: "https://other.example.net/scim/v2",
          token: "new-secret",
        },
      }
    );

    expect(replaced.status).toBe(200);
    await replaced.body?.cancel();
    expect(
      await env.DB.prepare(
        "SELECT base_url, token FROM scim_connections"
      ).first()
    ).toEqual({
      base_url: "https://other.example.net/scim/v2",
      token: "new-secret",
    });

    // The saved token is used against its own server.
    const test = await call(
      adminCookie,
      `/api/admin/oidc-clients/${clientId}/provisioning/test`,
      {
        method: "POST",
        json: { baseUrl: "https://other.example.net/scim/v2" },
      }
    );

    expect(test.status).toBe(200);
    await test.body?.cancel();
    expect(
      internet.requests.map((request) => [
        new URL(request.url).host,
        request.headers.get("authorization"),
      ])
    ).toEqual([["other.example.net", "Bearer new-secret"]]);
  });
});
