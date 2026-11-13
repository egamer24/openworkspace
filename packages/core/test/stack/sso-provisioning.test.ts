import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";
import { internet } from "../../testing/internet.ts";
import { poll } from "../../testing/poll.ts";
import type { createOidcClientSchema } from "../../worker/admin/schemas.ts";
import { createDb } from "../../worker/db/client.ts";
import { hashToken, randomToken } from "../../worker/lib/crypto.ts";
import { userBackchannelSessions } from "../../worker/oidc/backchannel-logout.ts";

useFreshWorkspace();

/**
 * One SCIM sync run in the Worker. The identity-sync queue's consumer also
 * runs syncs on its own after each change; waiting out its lease makes the
 * result this run's, and leaves nothing pending from the change.
 */
const syncScimConnection = (connectionId: string, waitForLease = true) =>
  hooks.call<"done" | "more" | "skipped">(
    "sso.syncScim",
    connectionId,
    waitForLease
  );

const issuer = "http://example.test";
const redirectUri = "https://rp.example.test/callback";

let adminCookie = "";
let adminId = "";

type ApiInit = { method?: string; body?: unknown; cookie?: string };

/**
 * Calls the API as the administrator (or `init.cookie`), expects it to
 * succeed, and parses the JSON answer with `schema`.
 */
async function api<T>(path: string, init: ApiInit, schema: z.ZodType<T>) {
  const headers = new Headers({ cookie: init.cookie ?? adminCookie });

  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await worker.fetch(
    new Request(`${issuer}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  );

  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBeLessThan(400);

  return schema.parse(value);
}

/** `api` for a call whose answer the test does not read. */
const send = (path: string, init: ApiInit) => api(path, init, z.unknown());

const createdClientSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
});

/** The session cookie (`name=value`) a sign-in response sets. */
function sessionCookie(response: Response) {
  return required(
    response.headers.getSetCookie().at(0)?.split(";", 1).at(0),
    `no cookie set (${response.status})`
  );
}

/** Where a redirect points. */
function redirectTarget(response: Response) {
  return new URL(
    required(
      response.headers.get("location"),
      `no redirect (${response.status})`
    )
  );
}

/** Invites and activates a person, returning their id and a session cookie. */
async function activePerson(name: string, email: string) {
  const invitation = await api(
    "/api/admin/invitations",
    { body: { name, email } },
    z.object({ accessLink: z.object({ userId: z.string() }) })
  );

  const { userId } = invitation.accessLink;
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(userId)
    .run();

  const login = await worker.fetch(
    new Request(`${issuer}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    })
  );

  expect(login.status).toBeLessThan(400);

  return { userId, cookie: sessionCookie(login) };
}

function clientInput(
  overrides: Partial<z.input<typeof createOidcClientSchema>>
) {
  return {
    name: "Grafana",
    clientType: "confidential",
    accessTeams: [],
    redirectUris: [redirectUri],
    postLogoutRedirectUris: [],
    allowedOrigins: [],
    allowedScopes: ["openid", "profile", "email", "groups"],
    trusted: true,
    enabled: true,
    ...overrides,
  };
}

function teamInput(name: string, slug: string, userIds: string[]) {
  return {
    name,
    slug,
    description: null,
    members: userIds.map((userId) => ({ userId, canSend: true })),
  };
}

/** Creates a team with these people and returns its id. */
async function team(name: string, slug: string, userIds: string[]) {
  return (
    await api(
      "/api/admin/teams",
      { body: teamInput(name, slug, userIds) },
      z.object({ teamId: z.string() })
    )
  ).teamId;
}

async function authorizeError(cookie: string, clientId: string) {
  const authorize = new URL(`${issuer}/oauth/authorize`);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid",
    code_challenge: await hashToken(randomToken(48)),
    code_challenge_method: "S256",
  })) {
    authorize.searchParams.set(key, value);
  }

  const response = await worker.fetch(
    new Request(authorize, { headers: { cookie }, redirect: "manual" })
  );

  return redirectTarget(response).searchParams.get("error");
}

/** Signs a person in to a client and returns the verified ID token. */
async function signIn(
  cookie: string,
  client: { clientId: string; clientSecret: string },
  scope: string
) {
  const verifier = randomToken(48);
  const authorize = new URL(`${issuer}/oauth/authorize`);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope,
    state: "state",
    nonce: "nonce",
    code_challenge: await hashToken(verifier),
    code_challenge_method: "S256",
  })) {
    authorize.searchParams.set(key, value);
  }

  const authorization = await worker.fetch(
    new Request(authorize, { headers: { cookie }, redirect: "manual" })
  );

  expect(authorization.status).toBe(302);

  const code = required(
    redirectTarget(authorization).searchParams.get("code"),
    "the authorization redirect has no code"
  );

  const token = await worker.fetch(
    new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })
  );

  const body = await token.json();
  expect(token.status).toBe(200);
  const { id_token: idToken } = z.object({ id_token: z.string() }).parse(body);

  return (
    await jwtVerify(idToken, await signingKey(), {
      issuer,
      audience: client.clientId,
    })
  ).payload;
}

async function signingKey() {
  const response = await worker.fetch(`${issuer}/.well-known/jwks.json`);

  const { keys } = z
    .object({
      keys: z.array(
        z.object({
          kty: z.string(),
          kid: z.string().optional(),
          alg: z.string().optional(),
          use: z.string().optional(),
          n: z.string(),
          e: z.string(),
        })
      ),
    })
    .parse(await response.json());

  return importJWK(required(keys[0], "the JWKS has no keys"), "RS256");
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${issuer}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Provisioning Admin",
        email: "provisioning-admin@example.test",
      }),
    })
  );

  adminCookie = sessionCookie(bootstrap);
  expect(bootstrap.status).toBeLessThan(400);

  const state = await api(
    "/api/admin/state",
    {},
    z.object({ users: z.array(z.object({ id: z.string() })) })
  );

  adminId = required(state.users[0], "the workspace has no users").id;
});

describe("access by team", () => {
  it("lets in the access teams' members and tells the app which of those teams they are in", async () => {
    const admins = await team("Grafana administrators", "grafana-admins", [
      adminId,
    ]);

    await team("Finance", "finance", [adminId]);

    const client = await api(
      "/api/admin/oidc-clients",
      {
        body: clientInput({
          accessTeams: [{ teamId: admins }, { teamId: "team_everyone" }],
        }),
      },
      createdClientSchema
    );

    const state = await api(
      "/api/admin/state",
      {},
      z.object({
        oidcClients: z.array(
          z.object({
            id: z.string(),
            accessTeams: z.array(
              z.object({ teamId: z.string(), sentAs: z.string().nullable() })
            ),
          })
        ),
      })
    );

    expect(
      state.oidcClients.find((item) => item.id === client.clientId)?.accessTeams
    ).toEqual(
      expect.arrayContaining([
        { teamId: admins, sentAs: null },
        { teamId: "team_everyone", sentAs: null },
      ])
    );

    // Teams without a value are not sent.
    expect((await signIn(adminCookie, client, "openid groups")).groups).toEqual(
      []
    );
    expect(await signIn(adminCookie, client, "openid")).not.toHaveProperty(
      "groups"
    );

    // Teams with a value are sent as it; Finance gives no access, so never.
    await send(`/api/admin/oidc-clients/${client.clientId}`, {
      method: "PATCH",
      body: clientInput({
        accessTeams: [
          { teamId: admins, sentAs: "Admin" },
          { teamId: "team_everyone", sentAs: "Viewer" },
        ],
      }),
    });
    expect((await signIn(adminCookie, client, "openid groups")).groups).toEqual(
      ["Admin", "Viewer"]
    );
    await send(`/api/admin/oidc-clients/${client.clientId}`, {
      method: "PATCH",
      body: clientInput({
        accessTeams: [
          { teamId: admins, sentAs: "viewer" },
          { teamId: "team_everyone", sentAs: "viewer" },
        ],
      }),
    });
    expect((await signIn(adminCookie, client, "openid groups")).groups).toEqual(
      ["viewer"]
    );
    expect(await signIn(adminCookie, client, "openid")).not.toHaveProperty(
      "roles"
    );
  });

  it("changes a person's teams from their page, with the same effects as a team edit", async () => {
    const person = await activePerson("Mary Jackson", "mary@example.test");
    const crew = await team("Crew", "crew", []);

    const client = await api(
      "/api/admin/oidc-clients",
      {
        body: clientInput({
          name: "Roster",
          accessTeams: [{ teamId: crew, sentAs: "crew" }],
        }),
      },
      createdClientSchema
    );

    expect(await authorizeError(person.cookie, client.clientId)).toBe(
      "access_denied"
    );

    await send(`/api/admin/teams/person/${person.userId}`, {
      method: "PUT",
      body: { teamIds: [crew] },
    });
    expect(
      (await signIn(person.cookie, client, "openid groups")).groups
    ).toEqual(["crew"]);

    const everyone = await worker.fetch(
      new Request(`${issuer}/api/admin/teams/person/${person.userId}`, {
        method: "PUT",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ teamIds: ["team_everyone"] }),
      })
    );

    expect(everyone.status).toBe(400);
    await everyone.json();

    await send(`/api/admin/teams/person/${person.userId}`, {
      method: "PUT",
      body: { teamIds: [] },
    });
    expect(await authorizeError(person.cookie, client.clientId)).toBe(
      "access_denied"
    );
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM oidc_grants WHERE user_id = ? AND client_id = ?"
      )
        .bind(person.userId, client.clientId)
        .first("n")
    ).toBe(0);
  });

  it("signs people out of an app when they leave the team that let them in", async () => {
    const person = await activePerson("Hedy Lamarr", "hedy@example.test");
    const pilots = await team("Pilots", "pilots", [person.userId]);

    const client = await api(
      "/api/admin/oidc-clients",
      {
        body: clientInput({
          name: "Logbook",
          accessTeams: [{ teamId: pilots }],
          backchannelLogoutUri: "https://rp.example.test/backchannel",
        }),
      },
      createdClientSchema
    );

    await signIn(person.cookie, client, "openid");
    const db = createDb(env.DB);
    expect(await userBackchannelSessions(db, person.userId)).toEqual([
      { clientId: client.clientId, userId: person.userId },
    ]);

    await send(`/api/admin/teams/${pilots}`, {
      method: "PATCH",
      body: teamInput("Pilots", "pilots", []),
    });
    expect(await userBackchannelSessions(db, person.userId)).toEqual([]);
    expect(await authorizeError(person.cookie, client.clientId)).toBe(
      "access_denied"
    );

    // Joining again lets them back in.
    await send(`/api/admin/teams/${pilots}`, {
      method: "PATCH",
      body: teamInput("Pilots", "pilots", [person.userId]),
    });
    await signIn(person.cookie, client, "openid");

    // Taking the team off the app does the same.
    await send(`/api/admin/oidc-clients/${client.clientId}`, {
      method: "PATCH",
      body: clientInput({
        name: "Logbook",
        accessTeams: [],
        backchannelLogoutUri: "https://rp.example.test/backchannel",
      }),
    });
    expect(await userBackchannelSessions(db, person.userId)).toEqual([]);
    expect(await authorizeError(person.cookie, client.clientId)).toBe(
      "access_denied"
    );
  });
});

/** Logouts the Worker sent to the relying party in this test, and how it answers them. */
let backchannel: { url: string; body: string }[] = [];
let backchannelStatus = 200;

beforeEach(() => {
  backchannel = [];
  backchannelStatus = 200;
  internet.handle(async (request) => {
    if (request.target.href !== "https://rp.example.test/backchannel") {
      return undefined;
    }

    backchannel.push({ url: request.url, body: await request.text() });

    return new Response(null, { status: backchannelStatus });
  });
});

/** The logout token of a back-channel logout request. */
function logoutTokenOf(request: { body: string }) {
  return required(
    new URLSearchParams(request.body).get("logout_token"),
    "a back-channel logout without a logout_token"
  );
}

describe("OIDC back-channel logout", () => {
  it("tells signed-in clients when a person is disabled", async () => {
    const person = await activePerson("Grace Hopper", "grace@example.test");

    const client = await api(
      "/api/admin/oidc-clients",
      {
        body: clientInput({
          name: "Wiki",
          accessTeams: [{ teamId: "team_everyone" }],
          backchannelLogoutUri: "https://rp.example.test/backchannel",
        }),
      },
      createdClientSchema
    );

    await signIn(person.cookie, client, "openid");
    const db = createDb(env.DB);
    const sessions = await userBackchannelSessions(db, person.userId);
    expect(sessions).toEqual([
      { clientId: client.clientId, userId: person.userId },
    ]);

    await send(`/api/admin/users/${person.userId}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    // Disabling revoked every token, so the session list is read before that.
    expect(await userBackchannelSessions(db, person.userId)).toEqual([]);

    // The workspace's identity-sync queue delivers the logout to the app.
    const delivered = await poll(
      () =>
        backchannel.find(
          (request) => decodeJwt(logoutTokenOf(request)).aud === client.clientId
        ),
      (request) => request !== undefined,
      { timeout: 20_000 }
    );

    const token = required(delivered, "no back-channel logout reached the app");
    expect(token.url).toBe("https://rp.example.test/backchannel");
    const logoutToken = logoutTokenOf(token);
    expect(decodeProtectedHeader(logoutToken).typ).toBe("logout+jwt");

    const { payload } = await jwtVerify(logoutToken, await signingKey(), {
      issuer,
      audience: client.clientId,
    });

    expect(payload).toMatchObject({
      sub: person.userId,
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    });
    expect(payload).not.toHaveProperty("nonce");

    backchannelStatus = 400;
    expect(
      await hooks.call(
        "sso.deliverBackchannelLogout",
        required(sessions[0], "no back-channel session")
      )
    ).toMatchObject({ retryable: false });
  });

  it("advertises back-channel logout in discovery", async () => {
    const discovery = await api(
      "/.well-known/openid-configuration",
      {},
      z.looseObject({ scopes_supported: z.array(z.string()) })
    );

    expect(discovery).toMatchObject({
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: false,
    });
    expect(discovery.scopes_supported).toContain("groups");
    expect(discovery.scopes_supported).not.toContain("roles");
  });
});

/** A SCIM user or group as the Worker sends it, with the attributes the fake reads. */
const scimResourceSchema = z.looseObject({
  userName: z.string().optional(),
  displayName: z.string().optional(),
  active: z.boolean().optional(),
  members: z.array(z.looseObject({ value: z.string() })).optional(),
});

type ScimResource = z.infer<typeof scimResourceSchema> & { id: string };

const scimPatchSchema = z.object({
  Operations: z.array(z.object({ value: scimResourceSchema })),
});

const scimResourceType = z.enum(["Users", "Groups"]);

/**
 * A minimal in-memory SCIM 2.0 service provider on `host`, answering the
 * Worker's requests there for the rest of the test.
 */
function fakeScim(host: string) {
  const resources = {
    Users: new Map<string, ScimResource>(),
    Groups: new Map<string, ScimResource>(),
  };

  const log: string[] = [];
  const unauthorized: string[] = [];
  let rejectUserName: string | undefined;
  let nextId = 1;

  internet.handle(async (request) => {
    if (request.target.hostname !== host) return undefined;
    const url = request.target;

    if (request.headers.get("authorization") !== "Bearer scim-token") {
      unauthorized.push(`${request.method} ${url.pathname}`);

      return Response.json({ detail: "Unauthorized" }, { status: 401 });
    }

    const [, resourceType, id] = url.pathname
      .replace(/^\/scim\/v2/u, "")
      .split("/");

    const type = scimResourceType.parse(resourceType);
    const store = resources[type];

    log.push(`${request.method} /${type}${id ? "/:id" : ""}`);
    const nameField = type === "Users" ? "userName" : "displayName";

    if (request.method === "GET") {
      const filter = url.searchParams.get("filter");
      const value = filter?.match(/eq "(.*)"$/u)?.[1];

      const found = [...store.values()].filter(
        (item) => !value || item[nameField] === value
      );

      return Response.json({ totalResults: found.length, Resources: found });
    }

    if (request.method === "POST") {
      const body = scimResourceSchema.parse(await request.json());

      if (body[nameField] === rejectUserName) {
        return Response.json({ detail: "Invalid email" }, { status: 400 });
      }

      if (
        [...store.values()].some((item) => item[nameField] === body[nameField])
      ) {
        return Response.json({ detail: "Exists" }, { status: 409 });
      }

      const created = { ...body, id: `remote-${nextId++}` };
      store.set(created.id, created);

      return Response.json(created, { status: 201 });
    }

    const existing = id === undefined ? undefined : store.get(id);

    if (!id || !existing) {
      return Response.json({ detail: "Not found" }, { status: 404 });
    }

    if (request.method === "PUT") {
      store.set(id, {
        ...scimResourceSchema.parse(await request.json()),
        id,
      });
    }

    if (request.method === "PATCH") {
      const [operation] = scimPatchSchema.parse(
        await request.json()
      ).Operations;

      store.set(id, {
        ...existing,
        ...required(operation, "a PATCH without operations").value,
        id,
      });
    }

    if (request.method === "DELETE") {
      store.delete(id);

      return new Response(null, { status: 204 });
    }

    return Response.json(store.get(id));
  });

  return {
    users: resources.Users,
    groups: resources.Groups,
    log,
    /** Requests without the connection's token; should stay empty. */
    unauthorized,
    rejectUser(userName: string | undefined) {
      rejectUserName = userName;
    },
    seedUser(userName: string) {
      const id = `remote-${nextId++}`;
      resources.Users.set(id, { id, userName, active: true });

      return id;
    },
  };
}

describe("SCIM provisioning", () => {
  // The fake service providers go with their test; turn provisioning off so
  // queued syncs do not reach for them later, and wait out a run in flight.
  afterEach(async () => {
    await env.DB.prepare("UPDATE scim_connections SET enabled = 0").run();
    await poll(
      () =>
        env.DB.prepare(
          "SELECT count(*) AS n FROM scim_connections WHERE lease_until > ?"
        )
          .bind(Date.now())
          .first("n"),
      (leased) => !leased
    );
  });

  it("creates, updates, and deactivates people and groups", async () => {
    const scim = fakeScim("tracker.example.test");
    const ada = await activePerson("Ada Lovelace", "ada@example.test");
    const alan = await activePerson("Alan Turing", "alan@example.test");

    const engineering = await team("Engineering", "engineering", [
      ada.userId,
      alan.userId,
    ]);

    const input = clientInput({
      name: "Tracker",
      accessTeams: [{ teamId: engineering }],
    });

    const client = await api(
      "/api/admin/oidc-clients",
      { body: input },
      createdClientSchema
    );

    // Alan already has an account there; provisioning adopts it.
    const alanRemoteId = scim.seedUser("alan@example.test");

    const baseUrl = "https://tracker.example.test/scim/v2";
    expect(await hooks.call("sso.testScim", baseUrl, "scim-token")).toEqual({
      reachable: true,
      error: null,
    });
    await send(`/api/admin/oidc-clients/${client.clientId}/provisioning`, {
      method: "PUT",
      body: { enabled: true, baseUrl, token: "scim-token" },
    });

    const { id: connectionId } = required(
      await env.DB.prepare(
        "SELECT id FROM scim_connections WHERE oidc_client_id = ?"
      )
        .bind(client.clientId)
        .first<{ id: string }>(),
      "provisioning has no connection"
    );

    expect(await syncScimConnection(connectionId)).toBe("done");
    const remoteUsers = [...scim.users.values()];
    expect(remoteUsers).toHaveLength(2);
    expect(
      remoteUsers.find((user) => user.userName === "ada@example.test")
    ).toMatchObject({
      externalId: ada.userId,
      active: true,
      name: { givenName: "Ada", familyName: "Lovelace" },
    });
    expect(scim.users.get(alanRemoteId)).toMatchObject({
      externalId: alan.userId,
      active: true,
    });

    const group = required(
      [...scim.groups.values()].at(0),
      "no group was provisioned"
    );

    expect(group).toMatchObject({
      displayName: "Engineering",
      externalId: engineering,
    });
    expect(group.members?.map((member) => member.value)).toContain(
      alanRemoteId
    );

    // Nothing changed, so nothing is sent.
    scim.log.length = 0;
    await syncScimConnection(connectionId);
    expect(scim.log).toEqual([]);

    // Ada leaving the team deactivates her there and drops her from the group.
    await send(`/api/admin/teams/${engineering}`, {
      method: "PATCH",
      body: teamInput("Engineering", "engineering", [alan.userId]),
    });
    await syncScimConnection(connectionId);
    expect(scim.log).toEqual(["PATCH /Users/:id", "PUT /Groups/:id"]);
    expect(
      remoteUsers.find((user) => user.userName === "ada@example.test")?.id
    ).toSatisfy(
      (id) => id !== undefined && scim.users.get(id)?.active === false
    );
    expect(scim.groups.get(group.id)?.members).toHaveLength(1);

    const state = await api(
      "/api/admin/state",
      {},
      z.object({
        oidcClients: z.array(
          z.object({
            id: z.string(),
            provisioning: z.looseObject({}).nullable(),
          })
        ),
      })
    );

    expect(
      state.oidcClients.find((item) => item.id === client.clientId)
        ?.provisioning
    ).toMatchObject({
      enabled: true,
      baseUrl,
      users: 1,
      deactivatedUsers: 1,
      groups: 1,
      lastError: null,
    });
    expect(
      state.oidcClients.find((item) => item.id === client.clientId)
        ?.provisioning
    ).not.toHaveProperty("token");

    // Letting everyone in instead deletes the group: Everyone is never sent.
    await send(`/api/admin/oidc-clients/${client.clientId}`, {
      method: "PATCH",
      body: { ...input, accessTeams: [{ teamId: "team_everyone" }] },
    });
    await syncScimConnection(connectionId);
    expect(scim.groups.size).toBe(0);
    expect(scim.unauthorized).toEqual([]);
  });

  it("keeps going past a rejected person and never runs twice at once", async () => {
    const scim = fakeScim("payroll.example.test");
    // Rejected from the start: the queue's own sync may run before this test's.
    scim.rejectUser("dorothy@example.test");

    const ok = await activePerson(
      "Katherine Johnson",
      "katherine@example.test"
    );

    const rejected = await activePerson(
      "Dorothy Vaughan",
      "dorothy@example.test"
    );

    const client = await api(
      "/api/admin/oidc-clients",
      {
        body: clientInput({
          name: "Payroll",
          accessTeams: [
            {
              teamId: await team("Payroll", "payroll", [
                ok.userId,
                rejected.userId,
              ]),
            },
          ],
        }),
      },
      createdClientSchema
    );

    await send(`/api/admin/oidc-clients/${client.clientId}/provisioning`, {
      method: "PUT",
      body: {
        enabled: true,
        baseUrl: "https://payroll.example.test/scim/v2",
        token: "scim-token",
      },
    });

    const { id: connectionId } = required(
      await env.DB.prepare(
        "SELECT id FROM scim_connections WHERE oidc_client_id = ?"
      )
        .bind(client.clientId)
        .first<{ id: string }>(),
      "provisioning has no connection"
    );

    await syncScimConnection(connectionId);
    expect([...scim.users.values()].map((user) => user.userName)).toEqual([
      "katherine@example.test",
    ]);

    const connection = await env.DB.prepare(
      "SELECT last_error, lease_until FROM scim_connections WHERE id = ?"
    )
      .bind(connectionId)
      .first<{ last_error: string; lease_until: number | null }>();

    expect(connection?.last_error).toMatch(
      /^1 change rejected\. dorothy@example\.test: POST \/Users returned HTTP 400/u
    );
    expect(connection?.lease_until).toBeNull();

    await env.DB.prepare(
      "UPDATE scim_connections SET lease_until = ? WHERE id = ?"
    )
      .bind(Date.now() + 60_000, connectionId)
      .run();
    expect(await syncScimConnection(connectionId, false)).toBe("skipped");
    expect(scim.unauthorized).toEqual([]);
    await env.DB.prepare(
      "UPDATE scim_connections SET lease_until = NULL WHERE id = ?"
    )
      .bind(connectionId)
      .run();
  });
});
