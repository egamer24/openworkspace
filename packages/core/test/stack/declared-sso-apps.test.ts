import { afterEach, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import type { DeclaredSsoApp } from "../../shared/sso-declarations.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";
import { internet } from "../../testing/internet.ts";
import { hashToken } from "../../worker/lib/crypto.ts";

useFreshWorkspace();

const origin = "http://example.test";
const clientId = `cli_${"a".repeat(32)}`;
const samlId = `sapp_${"b".repeat(32)}`;
const secret = "owsec_declared-test-secret";

/** Redeclares the Worker's SSO apps, as a deploy with other declarations would. */
function declare(apps: DeclaredSsoApp[]) {
  return hooks.call("sso.declareApps", JSON.stringify(apps));
}

const syncDeclaredSsoApps = () => hooks.call("sso.syncDeclaredApps");

/** The session cookie (`name=value`) a sign-in response sets. */
function sessionCookie(response: Response) {
  const header = required(
    response.headers.get("set-cookie"),
    `sign-in set no cookie (${response.status})`
  );

  return required(header.split(";", 1)[0], "an empty set-cookie header");
}

/** The administrator the workspace was bootstrapped with. */
async function adminId() {
  const admin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin'"
  ).first<{ id: string }>();

  return required(admin, "the workspace has no administrator").id;
}

const createdTeamSchema = z.object({ teamId: z.string() });

const adminStateSchema = z.object({
  oidcClients: z.array(
    z.object({
      id: z.string(),
      managedBy: z.string().nullable(),
      provisioning: z.looseObject({}).nullable(),
    })
  ),
});

async function oidcApp(
  overrides: Partial<Extract<DeclaredSsoApp, { protocol: "oidc" }>> = {}
) {
  return {
    protocol: "oidc",
    id: clientId,
    name: "Access",
    clientType: "confidential",
    secretHash: await hashToken(secret),
    redirectUris: ["https://team.cloudflareaccess.com/cdn-cgi/access/callback"],
    postLogoutRedirectUris: [],
    allowedOrigins: [],
    scopes: ["openid", "email", "profile", "groups"],
    backchannelLogoutUri: null,
    trusted: true,
    requirePkce: true,
    access: { teams: { operators: "ops", later: null } },
    provisioning: null,
    ...overrides,
  } satisfies DeclaredSsoApp;
}

const samlApp: Extract<DeclaredSsoApp, { protocol: "saml" }> = {
  protocol: "saml",
  id: samlId,
  name: "Wiki",
  entityId: "https://wiki.example.net/saml",
  acsUrl: "https://wiki.example.net/saml/acs",
  nameIdFormat: "email",
  emailAttributeName: "email",
  nameAttributeName: "name",
  firstNameAttributeName: null,
  lastNameAttributeName: null,
  groupsAttributeName: null,
  signResponse: true,
  allowIdpInitiated: false,
  requireSignedAuthnRequests: false,
  spSigningCertificate: null,
  access: "everyone",
  provisioning: null,
};

describe("apps declared in alchemy.run.ts", () => {
  afterEach(async () => {
    await declare([]);
  });

  it("keeps D1 in step with the declarations and keeps the admin API out", async () => {
    await declare([await oidcApp(), samlApp]);
    // Nothing is written before the first administrator exists.
    await syncDeclaredSsoApps();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM oidc_clients WHERE managed_by IS NOT NULL"
      ).first("n")
    ).toBe(0);

    const bootstrap = await worker.fetch(
      new Request(`${origin}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Dee Clare", email: "dee@example.test" }),
      })
    );

    const cookie = sessionCookie(bootstrap);
    const admin = await adminId();

    const operators = await worker.fetch(
      new Request(`${origin}/api/admin/teams`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Operators",
          slug: "operators",
          description: null,
          members: [{ userId: admin }],
        }),
      })
    );

    expect(operators.status).toBe(201);
    const { teamId } = createdTeamSchema.parse(await operators.json());

    // Any sign-in or admin request applies the declarations first.
    const state = await worker.fetch(
      new Request(`${origin}/api/admin/state`, { headers: { cookie } })
    );

    expect(state.status).toBe(200);

    const client = await env.DB.prepare(
      "SELECT * FROM oidc_clients WHERE id = ?"
    )
      .bind(clientId)
      .first();

    expect(client).toMatchObject({
      name: "Access",
      managed_by: "deployment",
      registration: "admin",
      secret_hash: await hashToken(secret),
      trusted: 1,
      created_by_user_id: admin,
    });
    expect(
      await env.DB.prepare(
        "SELECT team_id, sent_as FROM oidc_client_access_teams WHERE client_id = ?"
      )
        .bind(clientId)
        .all()
    ).toMatchObject({ results: [{ team_id: teamId, sent_as: "ops" }] });
    expect(
      await env.DB.prepare(
        "SELECT user_id FROM oidc_client_access WHERE client_id = ?"
      )
        .bind(clientId)
        .all()
    ).toMatchObject({ results: [{ user_id: admin }] });
    expect(
      await env.DB.prepare(`SELECT allow_idp_initiated, managed_by,
      (SELECT team_id FROM saml_application_access_teams WHERE application_id = saml_applications.id) AS team_id
      FROM saml_applications WHERE id = ?`)
        .bind(samlId)
        .first()
    ).toEqual({
      allow_idp_initiated: 0,
      managed_by: "deployment",
      team_id: "team_everyone",
    });
    // The "later" team does not exist yet, so the run is retried rather than recorded.
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM settings WHERE key = 'sso_declarations_applied'"
      ).first("n")
    ).toBe(0);

    // Each is refused on its own; none changes anything another checks.
    const refusals = [
      ["PATCH", `/api/admin/oidc-clients/${clientId}`],
      ["DELETE", `/api/admin/oidc-clients/${clientId}`],
      ["POST", `/api/admin/oidc-clients/${clientId}/rotate-secret`],
      ["DELETE", `/api/admin/saml-applications/${samlId}`],
      // Their provisioning too.
      ["PUT", `/api/admin/oidc-clients/${clientId}/provisioning`],
      ["DELETE", `/api/admin/oidc-clients/${clientId}/provisioning`],
      ["POST", `/api/admin/oidc-clients/${clientId}/provisioning/test`],
      ["PUT", `/api/admin/saml-applications/${samlId}/provisioning`],
      ["DELETE", `/api/admin/saml-applications/${samlId}/provisioning`],
    ] as const;

    const responses = await Promise.all(
      refusals.map(([method, path]) =>
        worker.fetch(
          new Request(`${origin}${path}`, {
            method,
            headers: { cookie, origin, "content-type": "application/json" },
            body:
              method === "DELETE"
                ? undefined
                : JSON.stringify(
                    path.endsWith("/provisioning") || path.endsWith("/test")
                      ? {
                          enabled: true,
                          baseUrl: "https://scim.example.net/scim/v2",
                          token: "declared-scim-token",
                        }
                      : {}
                  ),
          })
        )
      )
    );

    for (const [index, [method, path]] of refusals.entries()) {
      expect(responses[index]?.status, `${method} ${path}`).toBe(409);
    }

    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM scim_connections").first(
        "n"
      )
    ).toBe(0);

    // Changing a declaration updates the row; taking one out removes it.
    await declare([await oidcApp({ name: "Zero Trust", access: "everyone" })]);
    await syncDeclaredSsoApps();
    expect(
      await env.DB.prepare(`SELECT name,
      (SELECT team_id FROM oidc_client_access_teams WHERE client_id = oidc_clients.id) AS team_id
      FROM oidc_clients WHERE id = ?`)
        .bind(clientId)
        .first()
    ).toEqual({ name: "Zero Trust", team_id: "team_everyone" });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM saml_applications WHERE id = ?"
      )
        .bind(samlId)
        .first("n")
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM settings WHERE key = 'sso_declarations_applied'"
      ).first("n")
    ).toBe(1);

    await declare([]);
    await syncDeclaredSsoApps();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM oidc_clients WHERE id = ?"
      )
        .bind(clientId)
        .first("n")
    ).toBe(0);
  });
  it("keeps a declared SAML app's Entity ID once it has issued persistent NameIDs", async () => {
    const admin = await adminId();

    const entityId = (app: DeclaredSsoApp) =>
      env.DB.prepare(
        "SELECT name, entity_id FROM saml_applications WHERE id = ?"
      )
        .bind(app.id)
        .first<{ name: string; entity_id: string }>();

    await declare([{ ...samlApp, nameIdFormat: "persistent" }]);
    await syncDeclaredSsoApps();

    // Before any NameID was issued, the Entity ID may still change.
    const moved = {
      ...samlApp,
      nameIdFormat: "persistent",
      entityId: "https://wiki.example.net/saml/v2",
    } satisfies DeclaredSsoApp;

    await declare([moved]);
    await syncDeclaredSsoApps();
    expect(await entityId(moved)).toEqual({
      name: "Wiki",
      entity_id: "https://wiki.example.net/saml/v2",
    });

    await env.DB.prepare(
      "INSERT INTO saml_pairwise_subjects (application_id, user_id, name_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(samlId, admin, "samlsub_declared", Date.now())
      .run();
    // A redeploy with another Entity ID leaves the app as it was, while the other apps still apply.
    await declare([
      {
        ...moved,
        name: "Renamed wiki",
        entityId: "https://wiki.example.net/saml/v3",
      },
      await oidcApp({ name: "Applied", access: "everyone" }),
    ]);
    await syncDeclaredSsoApps();
    expect(await entityId(moved)).toEqual({
      name: "Wiki",
      entity_id: "https://wiki.example.net/saml/v2",
    });
    expect(
      await env.DB.prepare("SELECT name FROM oidc_clients WHERE id = ?")
        .bind(clientId)
        .first("name")
    ).toBe("Applied");

    // With the Entity ID it had, the other changes apply.
    await declare([{ ...moved, name: "Renamed wiki" }]);
    await syncDeclaredSsoApps();
    expect(await entityId(moved)).toEqual({
      name: "Renamed wiki",
      entity_id: "https://wiki.example.net/saml/v2",
    });
  });
  it("writes declared SCIM provisioning as the admin UI stores it, and removes it with the declaration", async () => {
    const admin = await adminId();

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: admin }),
      })
    );

    const cookie = sessionCookie(login);
    const authorizations: string[] = [];
    internet.handle(async (request) => {
      if (request.target.hostname !== "scim.example.net") return undefined;
      authorizations.push(request.headers.get("authorization") ?? "");

      if (request.method === "GET") {
        return Response.json({ totalResults: 0, Resources: [] });
      }

      return Response.json(
        {
          ...z.looseObject({}).parse(await request.json()),
          id: `remote-${crypto.randomUUID()}`,
        },
        { status: 201 }
      );
    });

    const connection = () =>
      env.DB.prepare(
        "SELECT id, base_url, token, enabled FROM scim_connections WHERE oidc_client_id = ?"
      )
        .bind(clientId)
        .first<{
          id: string;
          base_url: string;
          token: string;
          enabled: number;
        }>();

    const baseUrl = "https://scim.example.net/scim/v2";

    await declare([
      await oidcApp({
        access: "everyone",
        provisioning: { baseUrl, token: "scim-token-1", enabled: true },
      }),
    ]);
    await syncDeclaredSsoApps();

    const created = required(
      await connection(),
      "the declared provisioning has no connection"
    );

    expect(created).toMatchObject({
      base_url: baseUrl,
      token: "scim-token-1",
      enabled: 1,
    });

    // The admin UI shows it, without the token; only "Sync now" works there.
    const state = await worker.fetch(
      new Request(`${origin}/api/admin/state`, { headers: { cookie } })
    );

    const { oidcClients } = adminStateSchema.parse(await state.json());

    const declared = oidcClients.find((client) => client.id === clientId);
    expect(declared?.managedBy).toBe("deployment");
    expect(declared?.provisioning).toMatchObject({ enabled: true, baseUrl });
    expect(declared?.provisioning).not.toHaveProperty("token");

    const syncNow = await worker.fetch(
      new Request(
        `${origin}/api/admin/oidc-clients/${clientId}/provisioning/sync`,
        {
          method: "POST",
          headers: { cookie, origin },
        }
      )
    );

    expect(syncNow.status).toBe(200);
    expect(await hooks.call("sso.syncScim", created.id, true)).toBe("done");
    expect(authorizations.length).toBeGreaterThan(0);
    expect(new Set(authorizations)).toEqual(new Set(["Bearer scim-token-1"]));

    // A new token or pausing it is a redeploy away; the connection (and what it sent) stays.
    await declare([
      await oidcApp({
        access: "everyone",
        provisioning: { baseUrl, token: "scim-token-2", enabled: false },
      }),
    ]);
    await syncDeclaredSsoApps();
    expect(await connection()).toEqual({
      id: created.id,
      base_url: baseUrl,
      token: "scim-token-2",
      enabled: 0,
    });

    // Taken out of the declaration, provisioning is off.
    await declare([await oidcApp({ access: "everyone" })]);
    await syncDeclaredSsoApps();
    expect(await connection()).toBeNull();
  });
});
